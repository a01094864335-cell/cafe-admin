import type { Env } from "../env.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json, version, string } from "../http.ts";
import { ledgerScope, scopeGuards } from "../repositories/scope.ts";
import { employeeRecord } from "./work.ts";
import { command, changed, assertion } from "../services/commands.ts";
import { date, month, money, text, identifier } from "../validation.ts";
import { dto } from "../repositories/ledger.ts";
import { pagination, page } from "../pagination.ts";
function number(v: unknown, min = 0, max = 1000) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(400, "VALIDATION_ERROR");
  return v;
}
export async function payrollRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/employees\/([A-Za-z0-9_-]+)\/(payroll-settings|weekly-confirmations|payroll-extras)(?:\/([0-9-]+))?$/,
  );
  if (!m) return null;
  const [, cafeId, employeeId, resource, key] = m,
    settings = resource === "payroll-settings",
    weekly = resource === "weekly-confirmations",
    table = settings
      ? "payroll_settings"
      : weekly
        ? "weekly_confirmations"
        : "payroll_extras",
    method = request.method;
  if (
    settings
      ? !!key || !["GET", "PATCH"].includes(method)
      : !key || !["GET", "PUT"].includes(method)
  )
    return null;
  if (key) (weekly ? date : month)(key);
  const actor = await authenticate(request, env),
    s = await ledgerScope(env, actor, cafeId, method !== "GET");
  await employeeRecord(env, s, employeeId);
  const selector = weekly ? "week_start" : "month";
  if (method === "GET") {
    if (!settings) {
      const r = await env.DB.prepare(
        `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND employee_id=? AND ${selector}=? AND deleted_at IS NULL`,
      )
        .bind(cafeId, s.datasetId, employeeId, key)
        .first<Record<string, unknown>>();
      return json(r ? dto(r) : null, requestId);
    }
    const p = pagination(
      request,
      JSON.stringify([cafeId, s.datasetId, employeeId, actor.userId, resource]),
    );
    const rows = await env.DB.prepare(
      "SELECT * FROM payroll_settings WHERE cafe_id=? AND dataset_id=? AND employee_id=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT ?",
    )
      .bind(cafeId, s.datasetId, employeeId, p.after, p.limit + 1)
      .all<Record<string, unknown>>();
    const data = [];
    for (const r of rows.results) {
      const rates = await env.DB.prepare(
        "SELECT year,hourly_rate FROM payroll_rates WHERE cafe_id=? AND dataset_id=? AND settings_id=?",
      )
        .bind(cafeId, s.datasetId, r.id)
        .all<{ year: number; hourly_rate: number | null }>();
      data.push({
        ...dto(r),
        rates: Object.fromEntries(
          rates.results.map((v) => [v.year, v.hourly_rate]),
        ),
      });
    }
    return page(data, p, "id", requestId);
  }
  await csrf(request, env, actor);
  const input = await body(request),
    values: Record<string, string | number | null> = {};
  fields(
    input,
    settings
      ? [
          "id",
          "expectedVersion",
          "effectiveFrom",
          "effectiveTo",
          "firstWeek",
          "weeklyHours",
          "holidayDay",
          "normalDays",
          "calculationStart",
          "calculationEnd",
          "threshold",
          "capHours",
          "maxWeekly",
          "averageWeeks",
          "rates",
        ]
      : weekly
        ? ["expectedVersion", "agreedHours", "confirmation", "note"]
        : ["expectedVersion", "amount"],
  );
  const settingId = settings && input.id ? identifier(input.id) : null;
  const existing = settings
    ? settingId
      ? await env.DB.prepare(
          "SELECT * FROM payroll_settings WHERE cafe_id=? AND dataset_id=? AND employee_id=? AND id=? AND deleted_at IS NULL",
        )
          .bind(cafeId, s.datasetId, employeeId, settingId)
          .first<Record<string, unknown>>()
      : null
    : await env.DB.prepare(
        `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND employee_id=? AND ${selector}=? AND deleted_at IS NULL`,
      )
        .bind(cafeId, s.datasetId, employeeId, key)
        .first<Record<string, unknown>>();
  if (settingId && !existing) fail(404, "NOT_FOUND");
  const expected =
    input.expectedVersion === undefined ? null : version(input.expectedVersion);
  if (settings && settingId && expected === null) fail(400, "VALIDATION_ERROR");
  if (settings) {
    const assign = (
      k: string,
      c: string,
      validate: (v: unknown) => string | number | null,
      fallback?: unknown,
    ) => {
      if (k in input) values[c] = validate(input[k]);
      else if (!existing) values[c] = validate(fallback);
    };
    assign("effectiveFrom", "effective_from", date);
    assign(
      "effectiveTo",
      "effective_to",
      (v) => (v === null ? null : date(v)),
      null,
    );
    assign(
      "firstWeek",
      "first_week",
      (v) => (v === null ? null : date(v)),
      null,
    );
    if (!existing || "weeklyHours" in input)
      values.weekly_hours_missing = input.weeklyHours === null ? 1 : 0;
    assign(
      "weeklyHours",
      "weekly_hours",
      (v) => (v === null ? 0 : number(v, 0, 40)),
      0,
    );
    assign(
      "holidayDay",
      "holiday_day",
      (v) => {
        if (
          typeof v !== "string" ||
          !["일", "월", "화", "수", "목", "금", "토", ""].includes(v)
        )
          fail(400, "VALIDATION_ERROR");
        return v;
      },
      "",
    );
    assign("normalDays", "normal_days", (v) => number(v, 0.01, 7), 5);
    assign("calculationStart", "calculation_start", date);
    assign("calculationEnd", "calculation_end", date);
    assign("threshold", "threshold", (v) => number(v, 15, 15), 15);
    assign("capHours", "cap_hours", (v) => number(v, 8, 8), 8);
    assign("maxWeekly", "max_weekly", (v) => number(v, 40, 40), 40);
    assign("averageWeeks", "average_weeks", (v) => number(v, 4, 4), 4);
    const next = { ...existing, ...values };
    if (
      (next.effective_to &&
        String(next.effective_from) > String(next.effective_to)) ||
      String(next.calculation_start) > String(next.calculation_end)
    )
      fail(400, "VALIDATION_ERROR");
  } else if (weekly) {
    values.week_start = key;
    values.agreed_hours =
      input.agreedHours === null || input.agreedHours === undefined
        ? null
        : number(input.agreedHours, 0, 40);
    const confirmation = string(input.confirmation);
    if (
      !["미확인", "개근·재직 확인", "결근", "검토필요"].includes(confirmation)
    )
      fail(400, "VALIDATION_ERROR");
    values.confirmation = confirmation;
    values.note = text(input.note ?? "");
  } else {
    values.month = key;
    values.amount = money(input.amount, true);
  }
  let rates: Record<string, number | null> | undefined;
  if ("rates" in input) {
    if (
      !input.rates ||
      typeof input.rates !== "object" ||
      Array.isArray(input.rates) ||
      Object.keys(input.rates).length > 100
    )
      fail(400, "VALIDATION_ERROR");
    rates = {};
    for (const [year, value] of Object.entries(input.rates)) {
      if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 9999)
        fail(400, "VALIDATION_ERROR");
      const rate = money(value, true);
      if (rate !== null && rate < 0) fail(400, "VALIDATION_ERROR");
      rates[year] = rate;
    }
  }
  const authorize = async () => {
    const current = await ledgerScope(env, actor, cafeId, true);
    if (current.datasetId !== s.datasetId) fail(409, "VERSION_CONFLICT");
    await employeeRecord(env, s, employeeId);
  };
  const result = (await command(
    env,
    actor,
    request,
    { values, expected, settingId, ...(rates ? { rates } : {}) },
    authorize,
    async () => {
      if ((existing && expected === null) || (!existing && expected !== null))
        fail(409, "VERSION_CONFLICT");
      const id = existing ? String(existing.id) : crypto.randomUUID(),
        ids: string[] = [],
        statements = scopeGuards(env, actor, s, ids),
        columns = Object.keys(values);
      statements.push(
        assertion(
          env,
          ids,
          "EXISTS(SELECT 1 FROM employees WHERE cafe_id=? AND dataset_id=? AND id=? AND deleted_at IS NULL)",
          cafeId,
          s.datasetId,
          employeeId,
        ),
      );
      if (existing) {
        if (columns.length)
          statements.push(
            env.DB.prepare(
              `UPDATE ${table} SET ${columns.map((c) => c + "=?").join(",")},version=version+1,updated_by=?,updated_at=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=? AND deleted_at IS NULL`,
            ).bind(
              ...Object.values(values),
              actor.userId,
              new Date().toISOString(),
              cafeId,
              s.datasetId,
              id,
              expected,
            ),
            changed(env, ids),
          );
        else
          statements.push(
            env.DB.prepare(
              `UPDATE ${table} SET version=version+1,updated_by=?,updated_at=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=? AND deleted_at IS NULL`,
            ).bind(
              actor.userId,
              new Date().toISOString(),
              cafeId,
              s.datasetId,
              id,
              expected,
            ),
            changed(env, ids),
          );
      } else
        statements.push(
          env.DB.prepare(
            `INSERT INTO ${table}(cafe_id,dataset_id,id,employee_id,created_by,updated_by,${columns.join(",")}) VALUES (${Array(
              columns.length + 6,
            )
              .fill("?")
              .join(",")})`,
          ).bind(
            cafeId,
            s.datasetId,
            id,
            employeeId,
            actor.userId,
            actor.userId,
            ...Object.values(values),
          ),
        );
      if (rates) {
        statements.push(
          env.DB.prepare(
            "DELETE FROM payroll_rates WHERE cafe_id=? AND dataset_id=? AND settings_id=?",
          ).bind(cafeId, s.datasetId, id),
        );
        for (const [year, rate] of Object.entries(rates))
          statements.push(
            env.DB.prepare(
              "INSERT INTO payroll_rates(cafe_id,dataset_id,settings_id,year,hourly_rate) VALUES (?,?,?,?,?)",
            ).bind(cafeId, s.datasetId, id, Number(year), rate),
          );
      }
      return {
        cafeId,
        statements,
        assertionIds: ids,
        target: id,
        action: resource + ".save",
        result: { id, datasetId: s.datasetId },
      };
    },
  )) as { id: string; datasetId: string };
  if (result.datasetId !== s.datasetId) fail(404, "NOT_FOUND");
  const row = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND id=? AND deleted_at IS NULL`,
  )
    .bind(cafeId, s.datasetId, result.id)
    .first<Record<string, unknown>>();
  if (!row) fail(404, "NOT_FOUND");
  return json(dto(row), requestId);
}
