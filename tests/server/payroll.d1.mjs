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

test("dashboard flow reconciles base wages, confirmed holiday pay and month-end extras across dates", async (t) => {
  const { request } = await setup(t);
  ok(
    await request("u1", base + "employees/e1", "PATCH", {
      expectedVersion: 1,
      hireDate: "2026-09-01",
      endDate: null,
    }),
  );
  ok(
    await request("u1", base + "employees/e1/payroll-settings", "PATCH", {
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      firstWeek: "2026-09-28",
      weeklyHours: 20,
      holidayDay: "일",
      normalDays: 5,
      calculationStart: "2026-01-01",
      calculationEnd: "2026-12-31",
      rates: { 2026: 10000 },
    }),
  );
  for (const businessDate of ["2026-10-01", "2026-10-02", "2026-10-03"])
    ok(
      await request("u1", base + "work-logs", "POST", {
        employeeId: "e1",
        businessDate,
        startTime: "09:00",
        endTime: "13:00",
        breakMinutes: 0,
      }),
      201,
    );
  ok(
    await request(
      "u1",
      base + "employees/e1/weekly-confirmations/2026-09-28",
      "PUT",
      { agreedHours: 20, confirmation: "개근·재직 확인", note: "" },
    ),
  );
  ok(
    await request("u1", base + "employees/e1/payroll-extras/2026-10", "PUT", {
      amount: 1234,
    }),
  );
  for (let i = 1; i <= 12; i++)
    ok(
      await request("u1", base + "purchases", "POST", {
        businessDate: "2026-10-02",
        vendor: "거래처",
        item: "구매 " + i,
        amount: i * 100,
      }),
      201,
    );
  ok(
    await request("u1", base + "expenses", "POST", {
      businessDate: "2026-10-03",
      item: "환불",
      amount: -500,
    }),
    201,
  );
  ok(
    await request("u1", base + "sales", "POST", {
      businessDate: "2026-10-05",
      card: null,
      cash: null,
      transfer: null,
      note: "메모만 기록",
    }),
    201,
  );
  ok(
    await request("u1", base + "other-incomes", "POST", {
      businessDate: "2026-10-06",
      item: "기타",
      amount: 3000,
    }),
    201,
  );
  const r = ok(
    await request("u1", base + "dashboard?from=2026-10-01&to=2026-10-31"),
  );
  const p = ok(
    await request("u1", base + "payroll?from=2026-10-01&to=2026-10-31"),
  ).employees[0];
  assert.equal(r.hours, 12);
  assert.equal(
    r.recent.find((x) => x.type === "sale" && x.date === "2026-10-05").amount,
    null,
  );
  assert.equal(
    r.daily.some((x) => x.date === "2026-10-05"),
    false,
  );
  assert.deepEqual(r.bounds, { first: "2026-10-01", last: "2026-10-06" });
  assert.equal(r.purchaseCount, 13);
  assert.equal(r.recorded, 1);
  assert.equal(r.recent.filter((x) => x.type === "purchase").length, 8);
  assert.equal(r.recent.filter((x) => x.type === "shift").length, 3);
  assert.equal(
    r.daily.reduce((s, x) => s + x.income, 0),
    r.income,
  );
  assert.equal(
    r.daily.reduce((s, x) => s + x.cost, 0),
    r.cost,
  );
  assert.equal(r.daily.find((x) => x.date === "2026-10-04").cost, p.holiday);
  assert.equal(r.daily.find((x) => x.date === "2026-10-31").cost, 1234);
  assert.equal(r.daily.find((x) => x.date === "2026-10-03").cost, 39500);
  assert.equal(r.wages, p.total);
  const early = ok(
    await request("u1", base + "dashboard?from=2026-10-02&to=2026-10-03"),
  );
  assert.equal(early.hours, 8);
  assert.equal(
    early.daily.reduce((s, x) => s + x.cost, 0),
    early.cost,
  );
  assert.equal(early.daily.length, 2);
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/b/dashboard?from=2026-10-01&to=2026-10-31",
      )
    ).status,
    403,
  );
});
