import type { Env } from "../env.ts";
import type { Scope } from "./scope.ts";
import type { Actor } from "../auth/session.ts";
import { fields, fail, version } from "../http.ts";
import { identifier, hundredths } from "../validation.ts";
import { inventoryRecord, movement } from "../routes/inventory.ts";
import { changed } from "../services/commands.ts";
export function stockInput(input: unknown) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input))
    fail(400, "VALIDATION_ERROR");
  const v = input as Record<string, unknown>;
  fields(v, ["itemId", "deltaHundredths", "expectedItemVersion"]);
  const deltaHundredths = hundredths(v.deltaHundredths);
  if (deltaHundredths === 0) fail(400, "VALIDATION_ERROR");
  return {
    itemId: identifier(v.itemId),
    deltaHundredths,
    expectedItemVersion: version(v.expectedItemVersion),
  };
}
// Replacement appends the net correction to each affected item; history is never rewritten.
export async function purchaseStock(
  env: Env,
  s: Scope,
  actor: Actor,
  operation: string,
  purchase: string,
  stock: ReturnType<typeof stockInput>,
  deleting: boolean,
  ids: string[],
) {
  if (stock === undefined && !deleting) return [];
  const old = await env.DB.prepare(
    "SELECT item_id,SUM(delta_hundredths) delta FROM inventory_movements WHERE cafe_id=? AND dataset_id=? AND purchase_id=? GROUP BY item_id HAVING SUM(delta_hundredths)<>0",
  )
    .bind(s.cafeId, s.datasetId, purchase)
    .all<{ item_id: string; delta: number }>();
  const deltas = new Map(old.results.map((r) => [r.item_id, -r.delta]));
  if (stock && !deleting)
    deltas.set(
      stock.itemId,
      (deltas.get(stock.itemId) ?? 0) + stock.deltaHundredths,
    );
  const statements = [];
  for (const [itemId, delta] of deltas) {
    const item = await inventoryRecord(env, s, itemId, true);
    if (item.deleted_at && stock?.itemId === itemId && !deleting)
      fail(409, "INVENTORY_ITEM_DELETED");
    const expected =
      stock?.itemId === itemId && !deleting
        ? stock.expectedItemVersion
        : Number(item.version);
    hundredths(Number(item.quantity_hundredths) + delta);
    // A zero correction still checks the version when the caller supplied a stock reference.
    statements.push(
      env.DB.prepare(
        "UPDATE inventory_items SET quantity_hundredths=quantity_hundredths+?,version=version+1,updated_by=?,updated_at=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=?",
      ).bind(
        delta,
        actor.userId,
        new Date().toISOString(),
        s.cafeId,
        s.datasetId,
        itemId,
        expected,
      ),
      changed(env, ids),
    );
    statements.push(
      movement(
        env,
        s,
        actor.userId,
        operation,
        itemId,
        delta,
        deleting || !stock ? "reversal" : "purchase",
        "",
        purchase,
      ),
    );
  }
  return statements;
}
