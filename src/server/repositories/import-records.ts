import type { Env } from "../env.ts";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { validate } from "../../shared/validate.js";
import { digest } from "../../shared/import-plan.js";
import { fail, fields } from "../http.ts";
import { hundredths, money, date, month } from "../validation.ts";
import { movement } from "../routes/inventory.ts";
export const dataTables = [
  "employees",
  "sales",
  "purchases",
  "expenses",
  "other_incomes",
  "inventory_items",
  "inventory_movements",
  "work_logs",
  "payroll_settings",
  "payroll_rates",
  "weekly_confirmations",
  "payroll_extras",
  "sales_reconciliations",
] as const;
export const deleteOrder = [
  "inventory_movements",
  "payroll_rates",
  "weekly_confirmations",
  "payroll_extras",
  "work_logs",
  "payroll_settings",
  "employees",
  "inventory_items",
  "sales",
  "purchases",
  "expenses",
  "other_incomes",
  "sales_reconciliations",
] as const;
export const emptyPredicate = (alias = "c") =>
  dataTables
    .filter((t) => t !== "payroll_rates")
    .map(
      (t) =>
        `NOT EXISTS(SELECT 1 FROM ${t} WHERE cafe_id=${alias}.id AND dataset_id=${alias}.active_dataset_id)`,
    )
    .join(" AND ");
export function skeleton(meta: any) {
  return {
    ...meta,
    sales: [],
    purchases: [],
    incomes: [],
    inventory: [],
    payroll: [],
    weeks: {},
    monthlyExtras: {},
    comparisons: {},
  };
}
export async function importRecords(
  env: Env,
  cafe: string,
  dataset: string,
  job: string,
  user: string,
  operation: string,
  kind: string,
  rows: any[],
  metadata: any,
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [],
    employee = await digest(job + ":employee"),
    settings = await digest(job + ":settings");
  const insert = (
    table: string,
    id: string,
    values: Record<string, unknown>,
  ) => {
    const columns = Object.keys(values);
    return env.DB.prepare(
      `INSERT INTO ${table}(cafe_id,dataset_id,id,created_by,updated_by,${columns.join(",")}) VALUES (${Array(
        columns.length + 5,
      )
        .fill("?")
        .join(",")})`,
    ).bind(cafe, dataset, id, user, user, ...Object.values(values));
  };
  if (kind === "meta") {
    if (rows.length !== 1) fail(400, "VALIDATION_ERROR");
    const meta = rows[0];
    fields(meta, [
      "version",
      "store",
      "employment",
      "checks",
      "lastBackup",
      "importedAt",
      "sourceVersion",
      "sourceControls",
    ]);
    try {
      validate(skeleton(meta));
    } catch (e) {
      fail(400, "INVALID_BACKUP");
    }
    const e = meta.employment;
    statements.push(
      env.DB.prepare(
        "UPDATE datasets SET metadata_json=? WHERE cafe_id=? AND id=?",
      ).bind(JSON.stringify(meta), cafe, dataset),
      insert("employees", employee, {
        name: "기존 장부 직원",
        hire_date: e.hireDate,
        end_date: e.endDate,
      }),
      insert("payroll_settings", settings, {
        employee_id: employee,
        effective_from: "1900-01-01",
        effective_to: null,
        first_week: e.firstWeek,
        weekly_hours: e.weeklyHours ?? 0,
        weekly_hours_missing: e.weeklyHours === null ? 1 : 0,
        holiday_day: e.holidayDay ?? "",
        normal_days: e.normalDays,
        calculation_start: e.start,
        calculation_end: e.end,
        threshold: e.threshold,
        cap_hours: e.capHours,
        max_weekly: e.maxWeekly,
        average_weeks: e.averageWeeks,
      }),
    );
    return statements;
  }
  if (!metadata?.employment) fail(409, "IMPORT_METADATA_REQUIRED");
  const snapshot = skeleton(metadata);
  if (["sales", "purchases", "incomes", "inventory", "payroll"].includes(kind))
    snapshot[kind] = rows;
  else if (kind === "weeks")
    snapshot.weeks = Object.fromEntries(
      rows.map((r) => [
        r.date,
        { agreed: r.agreed, confirmation: r.confirmation, note: r.note },
      ]),
    );
  else if (kind === "monthlyExtras")
    snapshot.monthlyExtras = Object.fromEntries(
      rows.map((r) => [r.month, r.amount]),
    );
  else if (kind === "comparisons")
    snapshot.comparisons = Object.fromEntries(
      rows.map((r) => [r.month, { reported: r.reported, note: r.note }]),
    );
  try {
    validate(snapshot);
  } catch {
    fail(400, "INVALID_BACKUP");
  }
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r))
      fail(400, "VALIDATION_ERROR");
    let id = await digest(
      job + ":" + kind + ":" + (r.id ?? r.date ?? r.month ?? r.year),
    );
    if (
      ["sales", "purchases", "incomes", "inventory", "payroll"].includes(kind)
    )
      statements.push(
        env.DB.prepare(
          "INSERT INTO import_source_ids(cafe_id,job_id,source_id,kind,target_id) VALUES (?,?,?,?,?)",
        ).bind(cafe, job, r.id, kind, id),
      );
    if (kind === "sales") {
      fields(r, ["id", "date", "card", "cash", "transfer", "note"]);
      date(r.date);
      statements.push(
        insert("sales", id, {
          business_date: r.date,
          card: r.card,
          cash: r.cash,
          transfer: r.transfer,
          note: r.note,
        }),
      );
    }
    if (kind === "purchases") {
      fields(r, ["id", "date", "group", "vendor", "item", "amount", "note"]);
      date(r.date);
      statements.push(
        insert(r.group === "월별 구매" ? "purchases" : "expenses", id, {
          business_date: r.date,
          vendor: r.vendor,
          item: r.item,
          amount: r.amount,
          note: r.note,
        }),
      );
    }
    if (kind === "incomes") {
      fields(r, ["id", "date", "item", "amount", "note"]);
      date(r.date);
      statements.push(
        insert("other_incomes", id, {
          business_date: r.date,
          item: r.item,
          amount: r.amount,
          note: r.note,
        }),
      );
    }
    if (kind === "inventory") {
      fields(r, ["id", "name", "qty", "min", "unit", "cost", "supplier"]);
      const fixed = (v: number) => {
        const n = Math.round(v * 100);
        if (Math.abs(v * 100 - n) > 1e-7) fail(400, "QUANTITY_PRECISION");
        return hundredths(n);
      };
      const qty = fixed(r.qty);
      statements.push(
        insert("inventory_items", id, {
          name: r.name,
          quantity_hundredths: qty,
          minimum_hundredths: fixed(r.min),
          unit: r.unit,
          cost: money(r.cost),
          supplier: r.supplier,
        }),
        movement(
          env,
          { cafeId: cafe, datasetId: dataset, revision: 0 },
          user,
          operation,
          id,
          qty,
          "opening",
          "v2 가져오기",
        ),
      );
    }
    if (kind === "payroll") {
      fields(r, ["id", "date", "start", "end", "breakMinutes", "note"]);
      date(r.date);
      statements.push(
        insert("work_logs", id, {
          employee_id: employee,
          business_date: r.date,
          start_time: r.start ?? "",
          end_time: r.end ?? "",
          break_minutes: r.breakMinutes ?? 0,
          break_missing: r.breakMinutes === null ? 1 : 0,
          note: r.note,
        }),
      );
    }
    if (kind === "weeks") {
      fields(r, ["date", "agreed", "confirmation", "note"]);
      date(r.date);
      statements.push(
        insert("weekly_confirmations", id, {
          employee_id: employee,
          week_start: r.date,
          agreed_hours: r.agreed,
          confirmation: r.confirmation,
          note: r.note,
        }),
      );
    }
    if (kind === "monthlyExtras") {
      fields(r, ["month", "amount"]);
      month(r.month);
      statements.push(
        insert("payroll_extras", id, {
          employee_id: employee,
          month: r.month,
          amount: r.amount,
        }),
      );
    }
    if (kind === "comparisons") {
      fields(r, ["month", "reported", "note"]);
      month(r.month);
      statements.push(
        insert("sales_reconciliations", id, {
          month: r.month,
          reported: r.reported,
          note: r.note,
        }),
      );
    }
    if (kind === "rates") {
      fields(r, ["year", "rate"]);
      if (
        !Number.isInteger(r.year) ||
        r.year < 1900 ||
        r.year > 9999 ||
        metadata.employment.rates[r.year] !== r.rate
      )
        fail(400, "VALIDATION_ERROR");
      statements.push(
        env.DB.prepare(
          "INSERT INTO payroll_rates(cafe_id,dataset_id,settings_id,year,hourly_rate) VALUES (?,?,?,?,?)",
        ).bind(cafe, dataset, settings, r.year, money(r.rate)),
      );
    }
  }
  return statements;
}
