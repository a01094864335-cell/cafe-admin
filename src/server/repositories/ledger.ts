import { costRules, costCategories, costCategory } from "../../shared/cost-categories.js";
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
  const {
    cafe_id,
    dataset_id,
    created_by,
    updated_by,
    deleted_at,
    break_missing,
    weekly_hours_missing,
    ...safe
  } = row;
  if (break_missing) safe.break_minutes = null;
  if (weekly_hours_missing) safe.weekly_hours = null;
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
  if (["from", "to", "cursor", "limit", "sort"].some((key) => q.getAll(key).length > 1))
    fail(400, "VALIDATION_ERROR");
  const sort = q.get("sort") ?? "newest";
  if (!["newest", "oldest", "highest", "lowest"].includes(sort)) fail(400, "VALIDATION_ERROR");
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
    sort,
  ]);
  let lastDate = "",
    lastId = "",
    lastAmount = 0;
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
      if (["highest", "lowest"].includes(sort)) {
        if (!Number.isSafeInteger(c.amount)) fail(400, "VALIDATION_ERROR");
        lastAmount = c.amount;
      }
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
  }
  return { from, to, limit, binding, lastDate, lastId, lastAmount, sort };
}
export async function listLedger(
  env: Env,
  scope: Scope,
  kind: Ledger,
  request: Request,
  actorId: string,
  requestId: string,
) {
  const category = new URL(request.url).searchParams.get("category");
  const cost = kind === "purchases" || kind === "expenses";
  if (category && (!cost || !costCategories.includes(category))) fail(400, "VALIDATION_ERROR");
  if (new URL(request.url).searchParams.getAll("category").length > 1) fail(400, "VALIDATION_ERROR");
  const p = datePage(request, scope, kind + ":" + encodeURIComponent(category ?? ""), actorId);
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const expression = "CASE " + costRules.map(([label, words]) =>
    "WHEN " + words.map(word => `instr(lower(item || ' ' || vendor), ${literal(word.toLowerCase())}) > 0`).join(" OR ") + " THEN " + literal(label)
  ).join(" ") + " ELSE '기타·검토 필요' END";
  const byAmount = p.sort === "highest" || p.sort === "lowest";
  const direction = p.sort === "oldest" || p.sort === "lowest" ? "ASC" : "DESC";
  const cmp = direction === "ASC" ? ">" : "<";
  const value = kind === "sales" ? `CASE WHEN card IS NULL AND cash IS NULL AND transfer IS NULL THEN ${p.sort === "lowest" ? "9000000000000000" : "-9000000000000000"} ELSE coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0) END` : "amount";
  const keyset = p.lastId ? byAmount ? `AND (${value},business_date,id) ${cmp} (?,?,?)` : `AND (business_date,id) ${cmp} (?,?)` : "";
  const order = `${byAmount ? value + " " + direction + "," : ""} business_date ${direction},id ${direction}`;
  const listQuery = env.DB.prepare(
      `SELECT *, ${value} AS sort_amount FROM ${ledgerTables[kind]} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ? ${category ? `AND (${expression})=?` : ""} ${keyset} ORDER BY ${order} LIMIT ?`,
    )
      .bind(
        scope.cafeId,
        scope.datasetId,
        p.from,
        p.to,
        ...(category ? [category] : []),
        ...(p.lastId ? [...(byAmount ? [p.lastAmount] : []), p.lastDate, p.lastId] : []),
        p.limit + 1,
      )
;

  const actualAmount = kind === "sales" ? "CASE WHEN card IS NULL AND cash IS NULL AND transfer IS NULL THEN NULL ELSE coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0) END" : "amount";
  const totalsQuery = env.DB.prepare(`SELECT count(*) count,count(${actualAmount}) recorded,coalesce(sum(${actualAmount}),0) total,min(${actualAmount}) minimum,max(${actualAmount}) maximum,coalesce(sum(CASE WHEN (${actualAmount}) < 0 THEN (${actualAmount}) ELSE 0 END),0) refunds ${kind === "sales" ? ",coalesce(sum(card),0) card,coalesce(sum(cash),0) cash,coalesce(sum(transfer),0) transfer" : ""} FROM ${ledgerTables[kind]} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ? ${category ? `AND (${expression})=?` : ""}`).bind(scope.cafeId, scope.datasetId, p.from, p.to, ...(category ? [category] : []));
  const results = await env.DB.batch<Record<string, any>>([listQuery, totalsQuery]);
  const rows = results[0].results, summary = results[1].results[0];
  if (![summary.total, summary.refunds, ...(kind === "sales" ? [summary.card, summary.cash, summary.transfer] : [])].every(Number.isSafeInteger)) fail(400, "SUMMARY_OUT_OF_RANGE");
  const data = rows.slice(0, p.limit),
    last = data.at(-1);
  return Response.json(
    {
      summary,
      data: data.map(({ sort_amount, ...row }) => ({ ...dto(row), ...(cost ? { category: costCategory(String(row.item ?? ""), String(row.vendor ?? "")) } : {}) })),
      nextCursor:
        rows.length > p.limit
          ? btoa(
              JSON.stringify({
                binding: p.binding,
                date: last!.business_date,
                id: last!.id,
                amount: last!.sort_amount,
              }),
            )
          : null,
      requestId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
