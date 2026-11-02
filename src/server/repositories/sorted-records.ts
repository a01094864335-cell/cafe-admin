import type { Env } from "../env.ts";
import type { Scope } from "./scope.ts";
import { fail } from "../http.ts";
import { dto } from "./ledger.ts";

// Table and amount expressions are supplied only by route code.
export async function sortedRecords(env: Env, scope: Scope, request: Request, actorId: string, requestId: string, table: string, amount?: string, itemId?: string) {
  const q = new URL(request.url).searchParams;
  const sort = q.get("sort") ?? "newest";
  const byAmount = sort === "highest" || sort === "lowest";
  const limit = Number(q.get("limit") ?? 50);
  if (!["newest", "oldest", "highest", "lowest"].includes(sort) || (byAmount && !amount) || !Number.isInteger(limit) || limit < 1 || limit > 100 || ["sort", "cursor", "limit"].some(k => q.getAll(k).length > 1)) fail(400, "VALIDATION_ERROR");
  const binding = JSON.stringify([scope.cafeId, scope.datasetId, actorId, table, itemId ?? "", sort]);
  let last: { binding: string; stamp: string; id: string; amount: number } | null = null;
  if (q.get("cursor")) {
    try {
      last = JSON.parse(atob(q.get("cursor")!));
      if (!last || last.binding !== binding || typeof last.stamp !== "string" || last.stamp.length > 40 || !Number.isFinite(Date.parse(last.stamp)) || !/^[A-Za-z0-9_-]{1,100}$/.test(last.id) || (byAmount && !Number.isSafeInteger(last.amount))) fail(400, "VALIDATION_ERROR");
    } catch { fail(400, "VALIDATION_ERROR"); }
  }
  const direction = sort === "oldest" || sort === "lowest" ? "ASC" : "DESC";
  const compare = direction === "ASC" ? ">" : "<";
  const value = amount ? `coalesce(${amount},${sort === "lowest" ? "9000000000000000" : "-9000000000000000"})` : "0";
  const keys = `${byAmount ? value + "," : ""}created_at,id`;
  const listQuery = env.DB.prepare(`SELECT *, ${value} AS sort_amount FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL ${itemId ? "AND item_id=?" : ""} ${last ? `AND (${keys}) ${compare} (${byAmount ? "?," : ""}?,?)` : ""} ORDER BY ${byAmount ? value + " " + direction + "," : ""}created_at ${direction},id ${direction} LIMIT ?`).bind(scope.cafeId, scope.datasetId, ...(itemId ? [itemId] : []), ...(last ? [...(byAmount ? [last.amount] : []), last.stamp, last.id] : []), limit + 1);
  const totalsQuery = env.DB.prepare(`SELECT count(*) count ${table === "inventory_items" ? ",sum(CASE WHEN quantity_hundredths <= minimum_hundredths THEN 1 ELSE 0 END) lowStock,coalesce(sum(CASE WHEN cost IS NOT NULL THEN quantity_hundredths*1.0*cost/100 ELSE 0 END),0) value,sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) missingCost" : ""} FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL ${itemId ? "AND item_id=?" : ""}`).bind(scope.cafeId,scope.datasetId,...(itemId ? [itemId] : []));
  const result = await env.DB.batch<Record<string, any>>([listQuery, totalsQuery]);
  const rows = result[0].results, summary = result[1].results[0];
  if (summary.value !== undefined && !Number.isSafeInteger(Math.round(summary.value))) fail(400,"SUMMARY_OUT_OF_RANGE");
  const data = rows.slice(0, limit), tail = data.at(-1);
  return Response.json({ summary, data: data.map(({sort_amount, ...r}) => dto(r)), nextCursor: rows.length > limit ? btoa(JSON.stringify({binding, stamp: tail!.created_at, id: tail!.id, amount: tail!.sort_amount})) : null, requestId }, {headers: {"Cache-Control": "no-store"}});
}
