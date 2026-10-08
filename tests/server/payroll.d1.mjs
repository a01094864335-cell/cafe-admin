import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setup, ok } from "./api-helpers.mjs";
import { createCalculations } from "../../src/shared/calculations/ledger.js";
import { randomToken } from "../../src/server/auth/crypto.ts";
const base = "/api/v1/cafes/a/";
test("cloud payroll preserves legacy wages, holiday confirmations and month-end extras", async (t) => {
  const { request } = await setup(t),
    f = JSON.parse(
      await readFile(
        new URL("../fixtures/legacy-v2.json", import.meta.url),
        "utf8",
      ),
    ),
    e = f.employment;
  ok(
    await request("u1", base + "employees/e1", "PATCH", {
      expectedVersion: 1,
      hireDate: e.hireDate,
      endDate: e.endDate || null,
    }),
  );
  const setting = {
    effectiveFrom: "2026-01-01",
    effectiveTo: "2027-12-31",
    firstWeek: e.firstWeek,
    weeklyHours: e.weeklyHours,
    holidayDay: e.holidayDay,
    normalDays: e.normalDays,
    calculationStart: e.start,
    calculationEnd: e.end,
    threshold: e.threshold,
    capHours: e.capHours,
    maxWeekly: e.maxWeekly,
    averageWeeks: e.averageWeeks,
    rates: e.rates,
  };
  const key = randomToken();
  const saved = ok(
    await request(
      "u1",
      base + "employees/e1/payroll-settings",
      "PATCH",
      setting,
      key,
    ),
  );
  assert.equal(
    ok(
      await request(
        "u1",
        base + "employees/e1/payroll-settings",
        "PATCH",
        setting,
        key,
      ),
    ).id,
    saved.id,
  );
  assert.equal(
    (
      await request(
        "u1",
        base + "employees/e1/payroll-settings",
        "PATCH",
        setting,
      )
    ).status,
    409,
  );
  for (const r of f.payroll)
    ok(
      await request("u1", base + "work-logs", "POST", {
        employeeId: "e1",
        businessDate: r.date,
        startTime: r.start,
        endTime: r.end,
        breakMinutes: r.breakMinutes,
        note: r.note,
      }),
      201,
    );
  for (const [week, r] of Object.entries(f.weeks))
    ok(
      await request(
        "u1",
        base + "employees/e1/weekly-confirmations/" + week,
        "PUT",
        { agreedHours: r.agreed, confirmation: r.confirmation, note: r.note },
      ),
    );
  for (const [month, amount] of Object.entries(f.monthlyExtras))
    ok(
      await request(
        "u1",
        base + "employees/e1/payroll-extras/" + month,
        "PUT",
        { amount },
      ),
    );
  const actual = ok(
    await request("u1", base + "payroll?from=2026-10-01&to=2026-10-31"),
  ).employees.find((r) => r.employeeId === "e1");
  const expected = createCalculations(
    f,
    "2026-10-01",
    "2026-10-31",
  ).payrollTotals();
  for (const k of [
    "base",
    "holiday",
    "extra",
    "total",
    "hours",
    "pending",
    "notices",
  ])
    assert.equal(actual[k], expected[k], k);
  assert.deepEqual(actual.weekly, expected.weekly);
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/b/payroll?from=2026-10-01&to=2026-10-31",
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("u2", "/api/v1/cafes/b/employees/e1/payroll-settings"))
      .status,
    404,
  );
  const before = ok(
    await request("u1", base + "employees/e1/payroll-settings"),
  );
  assert.deepEqual(before[0].rates, e.rates);
});
test("dashboard date range includes refunds and other income; inactive datasets never contribute", async (t) => {
  const { request } = await setup(t);
  for (const [resource, input] of [
    ["purchases", { item: "원두", amount: 30000 }],
    ["expenses", { item: "소모품", amount: 5000 }],
    ["other-incomes", { item: "기타", amount: 3000 }],
    ["sales", { card: -10000 }],
  ])
    ok(
      await request("u1", base + resource, "POST", {
        businessDate: "2026-10-08",
        ...input,
      }),
      201,
    );
  const r = ok(
    await request("u1", base + "dashboard?from=2026-10-01&to=2026-10-31"),
  );
  assert.equal(r.revenue, 110000);
  assert.equal(r.other, 3000);
  assert.equal(r.purchases, 30000);
  assert.equal(r.expenses, 5000);
  assert.equal(r.profit, 78000);
  assert.equal(r.pending, true);
  assert.equal(r.recorded, 2);
  assert.equal(
    (await request("u1", base + "dashboard?from=2026-01-01&to=2030-01-01"))
      .status,
    400,
  );
});
