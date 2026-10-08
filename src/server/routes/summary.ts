import type { Env } from "../env.ts";
import { authenticate } from "../auth/session.ts";
import { ledgerScope } from "../repositories/scope.ts";
import { fail, json } from "../http.ts";
import { date } from "../validation.ts";
import { employeePayroll } from "../repositories/payroll-calculation.ts";
export async function summaryRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const u = new URL(request.url),
    m = u.pathname.match(
      /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/(payroll|dashboard)$/,
    );
  if (!m || request.method !== "GET") return null;
  const [, cafeId, resource] = m,
    actor = await authenticate(request, env),
    s = await ledgerScope(env, actor, cafeId);
  const from = date(u.searchParams.get("from")),
    to = date(u.searchParams.get("to"));
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
    fail(400, "VALIDATION_ERROR");
  // A single read batch gives all aggregates one consistent D1 snapshot.
  const tables = [
    "employees",
    "payroll_settings",
    "payroll_rates",
    "work_logs",
    "weekly_confirmations",
    "payroll_extras",
  ];
  const warmup = new Date(Date.parse(from + 'T12:00:00Z') - 28*86400000).toISOString().slice(0,10);
  const queries = tables.map((table) => {
    const column = table === 'work_logs' ? 'business_date' : table === 'weekly_confirmations' ? 'week_start' : table === 'payroll_extras' ? 'month' : null;
    return env.DB.prepare(`SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? ${table === 'payroll_rates' ? '' : 'AND deleted_at IS NULL'} ${column ? `AND ${column} BETWEEN ? AND ?` : ''}`).bind(cafeId,s.datasetId,...(column ? [table === 'payroll_extras' ? from.slice(0,7) : warmup,table === 'payroll_extras' ? to.slice(0,7) : to] : []));
  });
  queries.push(
    env.DB.prepare(
      "SELECT revision,active_dataset_id FROM cafes WHERE id=?",
    ).bind(cafeId),
  );
  for (const table of ["sales", "purchases", "expenses", "other_incomes"])
    queries.push(
      env.DB.prepare(
        table === "sales"
          ? `SELECT coalesce(sum(coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0)),0) total,count(CASE WHEN card IS NOT NULL OR cash IS NOT NULL OR transfer IS NOT NULL THEN 1 END) recorded FROM sales WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ?`
          : `SELECT coalesce(sum(amount),0) total FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ?`,
      ).bind(cafeId, s.datasetId, from, to),
    );
  const batch = await env.DB.batch<Record<string, any>>(queries),
    data = batch.map((r) => r.results);
  if (data[6][0].active_dataset_id !== s.datasetId)
    fail(409, "VERSION_CONFLICT");
  const payroll = data[0].map((e) =>
    employeePayroll(e, data[1], data[2], data[3], data[4], data[5], from, to),
  );
  // Authorization must still hold when a long computation finishes.
  const current = await ledgerScope(env, actor, cafeId);
  if (current.datasetId !== s.datasetId) fail(409, "VERSION_CONFLICT");
  const wages = payroll.reduce((sum, r) => sum + r.total, 0),
    pending = payroll.some((r) => r.pending),
    revision = data[6][0].revision;
  if (resource === "payroll")
    return json(
      { from, to, revision, employees: payroll, total: wages, pending },
      requestId,
    );
  const revenue = Number(data[7][0].total),
    other = Number(data[10][0].total),
    purchases = Number(data[8][0].total),
    expenses = Number(data[9][0].total),
    income = revenue + other,
    cost = purchases + expenses + wages;
  return json(
    {
      from,
      to,
      revision,
      revenue,
      other,
      income,
      purchases,
      expenses,
      wages,
      cost,
      profit: income - cost,
      pending,
      recorded: data[7][0].recorded,
    },
    requestId,
  );
}
