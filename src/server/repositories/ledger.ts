import type { Env } from "../env.ts";
import type { Scope } from "./scope.ts";
import { fail } from "../http.ts";
import { date, money, text } from "../validation.ts";
export const ledgerTables = {
  sales: "sales",
  purchases: "purchases",
  expenses: "expenses",
  "other-incomes": "other_incomes",
} as const;
export type Ledger = keyof typeof ledgerTables;
export function ledgerValues(
  kind: Ledger,
  input: Record<string, unknown>,
  partial = false,
) {
  const values: Record<string, string | number | null> = {};
  const assign = (
    key: string,
    column: string,
    validate: (v: unknown) => string | number | null,
    fallback?: unknown,
  ) => {
    if (input[key] !== undefined) values[column] = validate(input[key]);
    else if (!partial) values[column] = validate(fallback);
  };
  assign("businessDate", "business_date", date);
  if (kind === "sales")
    for (const key of ["card", "cash", "transfer"])
      assign(key, key, (v) => money(v, true), null);
  else {
    assign("item", "item", (v) => text(v, 200), "");
    assign("vendor", "vendor", (v) => text(v, 200), "");
    assign("amount", "amount", (v) => money(v));
  }
  assign("note", "note", text, "");
  return values;
}
export function dto(row: Record<string, unknown>) {
  const { cafe_id, dataset_id, created_by, updated_by, deleted_at, ...safe } =
    row;
  return Object.fromEntries(
    Object.entries(safe).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
}
export async function record(
  env: Env,
  scope: Scope,
  kind: Ledger,
  id: string,
  includeDeleted = false,
) {
  const row = await env.DB.prepare(
    `SELECT * FROM ${ledgerTables[kind]} WHERE cafe_id=? AND dataset_id=? AND id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
  )
    .bind(scope.cafeId, scope.datasetId, id)
    .first<Record<string, unknown>>();
  if (!row) fail(404, "NOT_FOUND");
  return row;
}
export function datePage(
  request: Request,
  scope: Scope,
  kind: string,
  actorId: string,
) {
  const q = new URL(request.url).searchParams,
    from = q.has("from") ? date(q.get("from")) : "1900-01-01",
    to = q.has("to") ? date(q.get("to")) : "9999-12-31";
  if (["from", "to", "cursor", "limit"].some((key) => q.getAll(key).length > 1))
    fail(400, "VALIDATION_ERROR");
  const limit = Number(q.get("limit") ?? 50);
  if (from > to || !Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(400, "VALIDATION_ERROR");
  const binding = JSON.stringify([
    scope.cafeId,
    scope.datasetId,
    kind,
    actorId,
    from,
    to,
  ]);
  let lastDate = "",
    lastId = "";
  if (q.has("cursor")) {
    try {
      const c = JSON.parse(atob(q.get("cursor")!));
      if (
        c.binding !== binding ||
        typeof c.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(c.id)
      )
        fail(400, "VALIDATION_ERROR");
      lastDate = date(c.date);
      lastId = c.id;
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
  }
  return { from, to, limit, binding, lastDate, lastId };
}
export async function listLedger(
  env: Env,
  scope: Scope,
  kind: Ledger,
  request: Request,
  actorId: string,
  requestId: string,
) {
  const p = datePage(request, scope, kind, actorId);
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM ${ledgerTables[kind]} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ? AND (business_date>? OR (business_date=? AND id>?)) ORDER BY business_date,id LIMIT ?`,
    )
      .bind(
        scope.cafeId,
        scope.datasetId,
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
