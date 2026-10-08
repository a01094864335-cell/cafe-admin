import type { Env } from "../env.ts";
import { fail } from "../http.ts";
import { dataTables } from "./import-records.ts";

// Expiration never opens an import lock or a newer, still-running export.
export async function expireExports(env: Env, cafeId: string) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE export_jobs SET state='failed' WHERE cafe_id=? AND state='running' AND expires_at<=?",
    ).bind(cafeId, now),
    env.DB.prepare(
      "UPDATE cafes SET write_mode='open',revision=revision+1 WHERE id=? AND write_mode='export' AND NOT EXISTS(SELECT 1 FROM export_jobs WHERE cafe_id=? AND state='running' AND expires_at>?)",
    ).bind(cafeId, cafeId, now),
  ]);
}

export function summaryQueries(env: Env, cafeId: string, datasetId: string) {
  return dataTables.map((table) => {
    const total =
      table === "sales"
        ? "coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0)"
        : table === "inventory_items"
          ? "quantity_hundredths"
          : table === "sales_reconciliations"
            ? "reported"
            : [
                  "purchases",
                  "expenses",
                  "other_incomes",
                  "payroll_extras",
                ].includes(table)
              ? "amount"
              : null;
    return env.DB.prepare(
      `SELECT count(*) count${total ? `,coalesce(sum(${total}),0) total` : ""} FROM ${table} WHERE cafe_id=? AND dataset_id=?${table === "payroll_rates" || table === "inventory_movements" ? "" : " AND deleted_at IS NULL"}`,
    ).bind(cafeId, datasetId);
  });
}
export function summaryResults(
  results: { results: Record<string, unknown>[] }[],
) {
  const values = results.map((r) => r.results[0]);
  if (
    values.some((r) => Object.values(r).some((v) => !Number.isSafeInteger(v)))
  )
    fail(400, "SUMMARY_OUT_OF_RANGE");
  return Object.fromEntries(dataTables.map((table, i) => [table, values[i]]));
}

// Native backup v3: keep business relationships, but no account, session,
// invitation, command, or actor identifiers. Account links must be reapproved.
export function backupRow(row: Record<string, unknown>) {
  const {
    cafe_id,
    dataset_id,
    created_by,
    updated_by,
    linked_user_id,
    operation_id,
    ...business
  } = row;
  return business;
}
