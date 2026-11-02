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
  const sort = u.searchParams.get("sort") ?? "newest";
  if (!["newest", "oldest", "highest", "lowest"].includes(sort) || u.searchParams.getAll("sort").length > 1) fail(400, "VALIDATION_ERROR");
  const direction = sort === "oldest" || sort === "lowest" ? "ASC" : "DESC";
  const order = `${["highest", "lowest"].includes(sort) ? `amount IS NULL ASC, amount ${direction},` : ""} business_date ${direction},id ${direction}`;
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
  const warmup = new Date(Date.parse(from + "T12:00:00Z") - 28 * 86400000)
    .toISOString()
    .slice(0, 10);
  const queries = tables.map((table) => {
    const column =
      table === "work_logs"
        ? "business_date"
        : table === "weekly_confirmations"
          ? "week_start"
          : table === "payroll_extras"
            ? "month"
            : null;
    return env.DB.prepare(
      `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? ${table === "payroll_rates" ? "" : "AND deleted_at IS NULL"} ${column ? `AND ${column} BETWEEN ? AND ?` : ""}`,
    ).bind(
      cafeId,
      s.datasetId,
      ...(column
        ? [
            table === "payroll_extras" ? from.slice(0, 7) : warmup,
            table === "payroll_extras" ? to.slice(0, 7) : to,
          ]
        : []),
    );
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
  if (resource === "dashboard") {
    // Keep charts, counts and bounded recent transactions in the same snapshot
    // as the headline totals. Do not download the entire ledger to the client.
    for (const table of ["sales", "purchases", "expenses", "other_incomes"]) {
      const value =
        table === "sales"
          ? "coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0)"
          : "amount";
      queries.push(
        env.DB.prepare(
          `SELECT business_date date,sum(${value}) total,count(*) count FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ? ${table === "sales" ? "AND (card IS NOT NULL OR cash IS NOT NULL OR transfer IS NOT NULL)" : ""} GROUP BY business_date ORDER BY business_date`,
        ).bind(cafeId, s.datasetId, from, to),
      );
      queries.push(
        env.DB.prepare(
          `SELECT id,business_date date,${table === "sales" ? "CASE WHEN card IS NULL AND cash IS NULL AND transfer IS NULL THEN NULL ELSE " + value + " END" : value} amount,note,${table === "sales" ? "'일별 매출' item,'' vendor" : "item," + (table === "other_incomes" ? "'' vendor" : "vendor")} FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL AND business_date BETWEEN ? AND ? ORDER BY ${order} LIMIT 8`,
        ).bind(cafeId, s.datasetId, from, to),
      );
    }
    queries.push(
      env.DB.prepare(
        `SELECT min(date) first,max(date) last FROM (${["sales", "purchases", "expenses", "other_incomes", "work_logs"].map((table) => `SELECT business_date date FROM ${table} WHERE cafe_id=? AND dataset_id=? AND deleted_at IS NULL`).join(" UNION ALL ")})`,
      ).bind(...Array.from({ length: 5 }, () => [cafeId, s.datasetId]).flat()),
    );
  }
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
  if (
    ![
      wages,
      ...payroll.flatMap((r) => [r.base, r.holiday, r.extra, r.total]),
    ].every(Number.isSafeInteger)
  )
    fail(400, "SUMMARY_OUT_OF_RANGE");
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
  if (
    ![revenue, other, purchases, expenses, income, cost, income - cost].every(
      Number.isSafeInteger,
    )
  )
    fail(400, "SUMMARY_OUT_OF_RANGE");
  let details = {};
  if (resource === "dashboard") {
    const events = new Map<
      string,
      { date: string; income: number; cost: number }
    >();
    const put = (date: string, income: number, cost: number) => {
      const row = events.get(date) ?? { date, income: 0, cost: 0 };
      row.income += income;
      row.cost += cost;
      events.set(date, row);
    };
    const kinds = ["sale", "purchase", "expense", "income"];
    const recent: Record<string, any>[] = [];
    let purchaseCount = 0;
    for (let i = 0; i < kinds.length; i++) {
      for (const row of data[11 + i * 2]) {
        put(
          row.date,
          i === 0 || i === 3 ? Number(row.total) : 0,
          i === 1 || i === 2 ? Number(row.total) : 0,
        );
        if (i === 1 || i === 2) purchaseCount += row.count;
      }
      recent.push(...data[12 + i * 2].map((r) => ({ ...r, type: kinds[i] })));
    }
    const employees = new Map(data[0].map((e) => [e.id, e.name]));
    const work = data[3].filter(
      (r) =>
        employees.has(r.employee_id) &&
        r.business_date >= from &&
        r.business_date <= to,
    );
    for (const employee of payroll) {
      for (const row of employee.work) put(row.businessDate, 0, row.base ?? 0);
      for (const row of employee.weekly)
        if (row.amount !== null && row.amount !== 0)
          put(row.holiday, 0, row.amount);
    }
    for (const row of data[5]) {
      const [year, month] = row.month.split("-").map(Number);
      const date =
        row.month + "-" + new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (employees.has(row.employee_id) && date >= from && date <= to)
        put(date, 0, row.amount ?? 0);
    }
    const wagesByWork = new Map(payroll.flatMap(employee => employee.work.map(row => [row.id, row.base] as const)));
    const compareRecent = (a: Record<string, any>, b: Record<string, any>) => {
      if (["highest", "lowest"].includes(sort)) {
        if (a.amount === null && b.amount !== null) return 1;
        if (b.amount === null && a.amount !== null) return -1;
        const difference = sort === "highest" ? (b.amount ?? 0) - (a.amount ?? 0) : (a.amount ?? 0) - (b.amount ?? 0);
        if (difference) return difference;
      }
      return direction === "ASC" ? a.date.localeCompare(b.date) || a.id.localeCompare(b.id) : b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
    };
    recent.push(
      ...work.map((r) => ({
          id: r.id,
          date: r.business_date,
          type: "shift",
          amount: wagesByWork.get(r.id) ?? null,
          item: `${r.start_time ?? "—"} – ${r.end_time ?? "—"}`,
          vendor: employees.get(r.employee_id),
          note: r.note,
        })).sort(compareRecent).slice(0, 8),
    );
    const daily = [...events.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    let cumulativeIncome = 0,
      cumulativeCost = 0;
    if (
      !daily.every((r) => {
        cumulativeIncome += r.income;
        cumulativeCost += r.cost;
        return [r.income, r.cost, cumulativeIncome, cumulativeCost].every(
          Number.isSafeInteger,
        );
      })
    )
      fail(400, "SUMMARY_OUT_OF_RANGE");
    details = {
      daily,
      recent: recent.sort(compareRecent),
      purchaseCount,
      hours: payroll.reduce((sum, r) => sum + r.hours, 0),
      bounds: data[19][0],
    };
  }
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
      ...details,
    },
    requestId,
  );
}
