import type { Env } from "../env.ts";
import type { Scope } from "../repositories/scope.ts";
import type { Role } from "../services/memberships.ts";
import { ledgerScope, scopeGuards } from "../repositories/scope.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json, version, string } from "../http.ts";
import { date, text, identifier } from "../validation.ts";
import { command, assertion, changed } from "../services/commands.ts";
import { dto, datePage } from "../repositories/ledger.ts";
import { pagination, page } from "../pagination.ts";
export async function employeeRecord(env: Env, s: Scope, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM employees WHERE cafe_id=? AND dataset_id=? AND id=? AND deleted_at IS NULL",
  )
    .bind(s.cafeId, s.datasetId, id)
    .first<Record<string, unknown>>();
  if (!row) fail(404, "NOT_FOUND");
  return row;
}
export async function workRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/(employees|work-logs|my\/work-logs)(?:\/([A-Za-z0-9_-]+))?$/,
  );
  if (!m) return null;
  const [, cafeId, resource, id] = m,
    employees = resource === "employees",
    mine = resource === "my/work-logs",
    method = request.method,
    writing = method !== "GET",
    deleting = method === "DELETE",
    table = employees ? "employees" : "work_logs";
  if (
    !(
      id
        ? employees
          ? ["GET", "PATCH"]
          : ["GET", "PATCH", "DELETE"]
        : ["GET", "POST"]
    ).includes(method)
  )
    return null;
  const actor = await authenticate(request, env),
    roles: Role[] = mine ? ["owner", "admin", "staff"] : ["owner", "admin"],
    s = await ledgerScope(env, actor, cafeId, writing, roles);
  async function linked() {
    const e = await env.DB.prepare(
      "SELECT id FROM employees WHERE cafe_id=? AND dataset_id=? AND linked_user_id=? AND deleted_at IS NULL",
    )
      .bind(cafeId, s.datasetId, actor.userId)
      .first<{ id: string }>();
    if (!e) fail(403, "EMPLOYEE_NOT_LINKED");
    return e.id;
  }
  const myEmployee = mine ? await linked() : null;
  async function record(deleted = false) {
    const row = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND id=? ${deleted ? "" : "AND deleted_at IS NULL"} ${mine ? "AND employee_id=?" : ""}`,
    )
      .bind(cafeId, s.datasetId, id, ...(mine ? [myEmployee] : []))
      .first<Record<string, unknown>>();
    if (!row) fail(404, "NOT_FOUND");
    return row;
  }
  if (!writing) {
    if (id) return json(dto(await record()), requestId);
    if (employees) {
      const p = pagination(
        request,
        JSON.stringify([cafeId, s.datasetId, actor.userId, resource]),
      );
      const rows = await env.DB.prepare(
        "SELECT * FROM employees WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT ?",
      )
        .bind(cafeId, s.datasetId, p.after, p.limit + 1)
        .all<Record<string, unknown>>();
      return page(rows.results.map(dto), p, "id", requestId);
    }
    const requested = new URL(request.url).searchParams.get("employeeId");
    if (mine && requested) fail(400, "VALIDATION_ERROR");
    const employee = mine
      ? myEmployee
      : requested
        ? identifier(requested)
        : null;
    if (employee) await employeeRecord(env, s, employee);
    const p = datePage(
      request,
      s,
      resource + ":" + (employee ?? ""),
      actor.userId,
    );
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM work_logs WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL ${employee ? "AND employee_id=?" : ""} AND business_date BETWEEN ? AND ? AND (business_date>? OR (business_date=? AND id>?)) ORDER BY business_date,id LIMIT ?`,
      )
        .bind(
          cafeId,
          s.datasetId,
          ...(employee ? [employee] : []),
          p.from,
          p.to,
          p.lastDate,
          p.lastDate,
          p.lastId,
          p.limit + 1,
        )
        .all<Record<string, unknown>>()
    ).results;
    const data = rows.slice(0, p.limit),
      last = data.at(-1);
    return Response.json(
      {
        data: data.map(dto),
        nextCursor:
          rows.length > p.limit
            ? btoa(
                JSON.stringify({
                  binding: p.binding,
                  date: last!.business_date,
                  id: last!.id,
                }),
              )
            : null,
        requestId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  await csrf(request, env, actor);
  const input = await body(request);
  fields(
    input,
    deleting
      ? ["expectedVersion"]
      : employees
        ? [
            "name",
            "linkedUserId",
            "hireDate",
            "endDate",
            ...(id ? ["expectedVersion"] : []),
          ]
        : [
            "businessDate",
            "startTime",
            "endTime",
            "breakMinutes",
            "note",
            ...(mine ? [] : ["employeeId"]),
            ...(id ? ["expectedVersion"] : []),
          ],
  );
  const expected = id ? version(input.expectedVersion) : null,
    values: Record<string, string | number | null> = {};
  const assign = (
    key: string,
    column: string,
    validate: (v: unknown) => string | number | null,
    fallback?: unknown,
  ) => {
    if (key in input) values[column] = validate(input[key]);
    else if (!id) values[column] = validate(fallback);
  };
  if (!deleting) {
    if (employees) {
      assign("name", "name", (v) => string(v, 200));
      assign(
        "linkedUserId",
        "linked_user_id",
        (v) => (v === null ? null : identifier(v)),
        null,
      );
      for (const key of ["hire", "end"])
        assign(
          key + "Date",
          key + "_date",
          (v) => (v === null ? null : date(v)),
          null,
        );
    } else {
      if (!mine) assign("employeeId", "employee_id", identifier);
      else if (!id) values.employee_id = myEmployee;
      assign("businessDate", "business_date", date);
      for (const key of ["start", "end"])
        assign(
          key + "Time",
          key + "_time",
          (v) => {
            if (
              typeof v !== "string" ||
              (v !== "" &&
                !(key === "end" && v === "24:00") &&
                !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
            )
              fail(400, "VALIDATION_ERROR");
            return v;
          },
          "",
        );
      assign(
        "breakMinutes",
        "break_minutes",
        (v) => {
          if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1440)
            fail(400, "VALIDATION_ERROR");
          return v as number;
        },
        0,
      );
      assign("note", "note", text, "");
    }
    if (!Object.keys(values).length) fail(400, "VALIDATION_ERROR");
  }
  const authorize = async () => {
    const current = await ledgerScope(env, actor, cafeId, true, roles);
    if (current.datasetId !== s.datasetId) fail(409, "VERSION_CONFLICT");
    if (mine && (await linked()) !== myEmployee)
      fail(403, "EMPLOYEE_NOT_LINKED");
    if (id) await record(deleting);
  };
  const result = (await command(
    env,
    actor,
    request,
    { values, expected },
    authorize,
    async () => {
      const target = id ?? crypto.randomUUID(),
        ids: string[] = [],
        statements = scopeGuards(env, actor, s, ids, roles),
        now = new Date().toISOString();
      const old = id ? await record(deleting) : {},
        next = { ...old, ...values };
      if (employees) {
        if (
          next.hire_date &&
          next.end_date &&
          String(next.hire_date) > String(next.end_date)
        )
          fail(400, "VALIDATION_ERROR");
        if (next.linked_user_id)
          statements.push(
            assertion(
              env,
              ids,
              "EXISTS(SELECT 1 FROM memberships WHERE cafe_id=? AND user_id=? AND status='active')",
              cafeId,
              String(next.linked_user_id),
            ),
          );
      } else {
        await employeeRecord(env, s, String(next.employee_id));
        statements.push(
          assertion(
            env,
            ids,
            `EXISTS(SELECT 1 FROM employees WHERE cafe_id=? AND dataset_id=? AND id=? AND deleted_at IS NULL ${mine ? "AND linked_user_id=?" : ""})`,
            cafeId,
            s.datasetId,
            String(next.employee_id),
            ...(mine ? [actor.userId] : []),
          ),
        );
      }
      const columns = Object.keys(values);
      if (!id)
        statements.push(
          env.DB.prepare(
            `INSERT INTO ${table}(cafe_id,dataset_id,id,created_by,updated_by,${columns.join(",")}) VALUES (${Array(
              columns.length + 5,
            )
              .fill("?")
              .join(",")})`,
          ).bind(
            cafeId,
            s.datasetId,
            target,
            actor.userId,
            actor.userId,
            ...Object.values(values),
          ),
        );
      else
        statements.push(
          env.DB.prepare(
            `UPDATE ${table} SET ${deleting ? "deleted_at=?" : columns.map((c) => c + "=?").join(",")},version=version+1,updated_at=?,updated_by=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=? AND deleted_at IS NULL`,
          ).bind(
            ...(deleting ? [now] : Object.values(values)),
            now,
            actor.userId,
            cafeId,
            s.datasetId,
            target,
            expected,
          ),
          changed(env, ids),
        );
      return {
        cafeId,
        statements,
        assertionIds: ids,
        target,
        action:
          resource + "." + (deleting ? "delete" : id ? "update" : "create"),
        result: {
          id: target,
          datasetId: s.datasetId,
          version: (expected ?? 0) + 1,
        },
      };
    },
  )) as { id: string; datasetId: string; version: number };
  if (result.datasetId !== s.datasetId) fail(404, "NOT_FOUND");
  if (deleting)
    return json(
      { id: result.id, deleted: true, version: result.version },
      requestId,
    );
  const row = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND id=? AND deleted_at IS NULL ${mine ? "AND employee_id=?" : ""}`,
  )
    .bind(cafeId, s.datasetId, result.id, ...(mine ? [myEmployee] : []))
    .first<Record<string, unknown>>();
  if (!row) fail(404, "NOT_FOUND");
  return json(dto(row), requestId, id ? 200 : 201);
}
