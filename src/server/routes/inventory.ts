import type { Env } from "../env.ts";
import type { Scope } from "../repositories/scope.ts";
import { ledgerScope, scopeGuards } from "../repositories/scope.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json, version, string } from "../http.ts";
import { command, changed } from "../services/commands.ts";
import { hundredths, money, text, identifier } from "../validation.ts";
import { dto } from "../repositories/ledger.ts";
import { pagination, page } from "../pagination.ts";
export async function inventoryRecord(
  env: Env,
  s: Scope,
  id: string,
  deleted = false,
) {
  const row = await env.DB.prepare(
    `SELECT * FROM inventory_items WHERE cafe_id=? AND dataset_id=? AND id=? ${deleted ? "" : "AND deleted_at IS NULL"}`,
  )
    .bind(s.cafeId, s.datasetId, id)
    .first<Record<string, unknown>>();
  if (!row) fail(404, "NOT_FOUND");
  return row;
}
export function movement(
  env: Env,
  s: Scope,
  user: string,
  operation: string,
  item: string,
  delta: number,
  kind: string,
  note: string,
  purchase: string | null = null,
) {
  return env.DB.prepare(
    "INSERT INTO inventory_movements(cafe_id,dataset_id,id,created_by,updated_by,item_id,delta_hundredths,operation_id,kind,note,purchase_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    s.cafeId,
    s.datasetId,
    crypto.randomUUID(),
    user,
    user,
    item,
    delta,
    operation,
    kind,
    note,
    purchase,
  );
}
export async function inventoryRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/inventory\/(items|movements)(?:\/([A-Za-z0-9_-]+))?$/,
  );
  if (!m) return null;
  const [, cafeId, resource, recordId] = m,
    method = request.method,
    history = resource === "movements";
  if (history && recordId) return null;
  let id = recordId;
  if (
    !(
      history
        ? ["GET", "POST"]
        : id
          ? ["GET", "PATCH", "DELETE"]
          : ["GET", "POST"]
    ).includes(method)
  )
    return null;
  const actor = await authenticate(request, env),
    s = await ledgerScope(env, actor, cafeId, method !== "GET");
  if (method === "GET") {
    if (history) {
      const filter = new URL(request.url).searchParams.get("itemId");
      if (filter) id = identifier(filter);
    }
    if (id) {
      const item = await inventoryRecord(env, s, id);
      if (!history) return json(dto(item), requestId);
    }
    const p = pagination(
      request,
      JSON.stringify([
        cafeId,
        s.datasetId,
        actor.userId,
        id ?? "",
        history ? "movements" : "inventory",
      ]),
    );
    const table = history ? "inventory_movements" : "inventory_items";
    const rows = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL ${history && id ? "AND item_id=?" : ""} AND id>? ORDER BY id LIMIT ?`,
    )
      .bind(
        cafeId,
        s.datasetId,
        ...(history && id ? [id] : []),
        p.after,
        p.limit + 1,
      )
      .all<Record<string, unknown>>();
    return page(rows.results.map(dto), p, "id", requestId);
  }
  await csrf(request, env, actor);
  const input = await body(request),
    deleting = method === "DELETE";
  fields(
    input,
    history
      ? ["itemId", "expectedVersion", "deltaHundredths", "note"]
      : deleting
        ? ["expectedVersion"]
        : [
            "name",
            "unit",
            "minimumHundredths",
            "cost",
            "supplier",
            ...(id ? ["expectedVersion"] : ["quantityHundredths"]),
          ],
  );
  if (history) id = identifier(input.itemId);
  const expected = id ? version(input.expectedVersion) : null,
    values: Record<string, string | number | null> = {};
  if (!deleting && !history) {
    if (!id || "name" in input) values.name = string(input.name, 200);
    if (!id || "unit" in input) values.unit = string(input.unit, 40);
    if (!id || "minimumHundredths" in input)
      values.minimum_hundredths = hundredths(input.minimumHundredths ?? 0);
    if (!id || "cost" in input) values.cost = money(input.cost ?? null, true);
    if (!id || "supplier" in input)
      values.supplier = text(input.supplier ?? "", 200);
    if (!id)
      values.quantity_hundredths = hundredths(input.quantityHundredths ?? 0);
    if (!Object.keys(values).length) fail(400, "VALIDATION_ERROR");
  }
  const delta = history ? hundredths(input.deltaHundredths) : 0,
    note = history ? text(input.note ?? "") : "";
  if (history && delta === 0) fail(400, "VALIDATION_ERROR");
  const authorize = async () => {
    const current = await ledgerScope(env, actor, cafeId, true);
    if (current.datasetId !== s.datasetId) fail(409, "VERSION_CONFLICT");
    if (id) await inventoryRecord(env, s, id, deleting);
  };
  const result = (await command(
    env,
    actor,
    request,
    { values, expected, delta, note },
    authorize,
    async (operation) => {
      const target = id ?? crypto.randomUUID(),
        ids: string[] = [],
        statements = scopeGuards(env, actor, s, ids),
        now = new Date().toISOString();
      if (!id) {
        const columns = Object.keys(values);
        statements.push(
          env.DB.prepare(
            `INSERT INTO inventory_items(cafe_id,dataset_id,id,created_by,updated_by,${columns.join(",")}) VALUES (${Array(
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
          movement(
            env,
            s,
            actor.userId,
            operation,
            target,
            values.quantity_hundredths as number,
            "opening",
            "",
          ),
        );
      } else {
        if (history) {
          const row = await inventoryRecord(env, s, id);
          hundredths(Number(row.quantity_hundredths) + delta);
        }
        const assignment = history
          ? "quantity_hundredths=quantity_hundredths+?"
          : deleting
            ? "deleted_at=?"
            : Object.keys(values)
                .map((c) => c + "=?")
                .join(",");
        statements.push(
          env.DB.prepare(
            `UPDATE inventory_items SET ${assignment},version=version+1,updated_at=?,updated_by=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=? AND deleted_at IS NULL`,
          ).bind(
            ...(history ? [delta] : deleting ? [now] : Object.values(values)),
            now,
            actor.userId,
            cafeId,
            s.datasetId,
            target,
            expected,
          ),
          changed(env, ids),
        );
        if (history)
          statements.push(
            movement(
              env,
              s,
              actor.userId,
              operation,
              target,
              delta,
              "adjustment",
              note,
            ),
          );
      }
      return {
        cafeId,
        bindCafeBeforeWrite: true,
        statements,
        assertionIds: ids,
        result: {
          id: target,
          datasetId: s.datasetId,
          version: (expected ?? 0) + 1,
        },
        target,
        action: history
          ? "inventory.adjust"
          : deleting
            ? "inventory.delete"
            : id
              ? "inventory.update"
              : "inventory.create",
      };
    },
  )) as { id: string; datasetId: string; version: number };
  if (result.datasetId !== s.datasetId) fail(404, "NOT_FOUND");
  return json(
    deleting
      ? { id: result.id, deleted: true, version: result.version }
      : dto(await inventoryRecord(env, s, result.id)),
    requestId,
    id ? 200 : 201,
  );
}
