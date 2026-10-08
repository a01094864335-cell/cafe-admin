import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createCalculations } from "../src/shared/calculations/ledger.js";
import { seed } from "../src/shared/seed.js";
import { validate } from "../src/shared/validate.js";
import { validDate, add } from "../src/shared/calculations/dates.js";

const original = readFileSync(
  new URL("../legacy/index.html", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/legacy-v2.json", import.meta.url)),
);
const sample = () => structuredClone(fixture);
const calc = (db = sample(), start = "2026-10-01", end = "2026-10-31") =>
  createCalculations(db, start, end);
function baseline(db, start, end) {
  const context = vm.createContext({
    structuredClone,
    localStorage: { getItem: () => JSON.stringify(db) },
  });
  vm.runInContext(
    original.split("<script>")[1].split("const monthLabel=")[0] +
      `\nrangeStart=${JSON.stringify(start)};rangeEnd=${JSON.stringify(end)};globalThis.result={metrics:metrics(),payroll:payrollTotals(),weeks:weeks()};`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("synthetic v2 backup and empty ledger remain valid", () => {
  assert.equal(validate(sample()).version, 2);
  const a = seed();
  a.sales.push(fixture.sales[0]);
  assert.equal(seed().sales.length, 0);
});
test("recorded zero, blank and refund have distinct meanings", () => {
  const c = calc();
  assert.equal(c.saleTotal(fixture.sales[0]), 120000);
  assert.equal(c.saleTotal(fixture.sales[1]), 0);
  assert.equal(c.saleTotal(fixture.sales[2]), null);
  assert.equal(c.saleTotal(fixture.sales[3]), -10000);
  assert.equal(c.metrics().recorded, 3);
});
test("known ledger totals include other income, refunds, wages and month-end extras once", () => {
  const m = calc().metrics();
  assert.deepEqual(m, {
    revenue: 110000,
    other: 3000,
    income: 113000,
    purchases: 28000,
    misc: 5000,
    wages: 91167,
    cost: 124167,
    profit: -11167,
    pending: true,
    recorded: 3,
  });
  assert.equal(calc().payrollTotals().base, 50167);
  assert.equal(calc().payrollTotals().holiday, 40000);
  assert.equal(
    calc(sample(), "2026-10-01", "2026-10-30").payrollTotals().extra,
    0,
  );
});
test("inventory and comparison values do not increase revenue or expenses", () => {
  const a = sample(),
    b = sample();
  b.inventory[0].qty = 999;
  b.comparisons["2026-10"].reported = 1;
  assert.deepEqual(calc(a).metrics(), calc(b).metrics());
});
test("shift rounding, missing input and month-boundary overnight shifts", () => {
  const c = calc(),
    r = { date: "2026-10-02", start: "09:00", end: "10:01", breakMinutes: 0 };
  assert.equal(c.shift(r).base, 10167);
  assert.equal(c.shift({ ...r, breakMinutes: null }).base, null);
  assert.equal(c.shift({ ...r, start: "22:00", end: "02:00" }).hours, 4);
  assert.equal(
    c.shift({ ...r, date: "2026-10-31", start: "22:00", end: "02:00" }).base,
    null,
  );
  assert.equal(c.shift({ ...r, start: "23:00", end: "24:00" }).hours, 1);
  assert.equal(c.shift({ ...r, end: "09:00" }).base, null);
  assert.equal(c.shift({ ...r, breakMinutes: 61 }).base, null);
});
test("weekly confirmation, absence and missing annual rate preserve pending state", () => {
  const db = sample();
  db.weeks["2026-09-28"].confirmation = "결근";
  assert.equal(calc(db).weeks()[0].amount, 0);
  db.weeks["2026-09-28"].confirmation = "미확인";
  assert.equal(calc(db).weeks()[0].amount, null);
  db.weeks["2026-09-28"].confirmation = "개근·재직 확인";
  delete db.employment.rates["2026"];
  assert.equal(calc(db).weeks()[0].amount, null);
  assert.equal(calc(db).shift(db.payroll[0]).base, null);
});
test("calendar validation handles leap dates and UTC date increments", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2028-02-29"), true);
  assert.equal(add("2026-12-31", 1), "2027-01-01");
});
test("legacy validator rejects duplicate IDs/dates, unsupported versions and fractional won", () => {
  for (const mutate of [
    (d) => d.sales.push({ ...d.sales[0] }),
    (d) => d.sales.push({ ...d.sales[0], id: "unique" }),
    (d) => (d.version = 3),
    (d) => (d.sales[0].card = 1.5),
    (d) => (d.purchases[0].date = "2026-02-30"),
  ]) {
    const d = sample();
    mutate(d);
    assert.throws(() => validate(d));
  }
});
for (const [name, mutate] of [
  ["representative", () => {}],
  ["empty", (d) => Object.assign(d, seed())],
  ["unconfirmed", (d) => (d.weeks = {})],
  ["absent", (d) => (d.weeks["2026-09-28"].confirmation = "결근")],
  ["no rate", (d) => (d.employment.rates = {})],
  ["under threshold", (d) => (d.employment.weeklyHours = 10)],
  ["leaver", (d) => (d.employment.endDate = "2026-10-02")],
  [
    "overnight",
    (d) =>
      Object.assign(d.payroll[0], {
        start: "22:00",
        end: "02:00",
        breakMinutes: 0,
      }),
  ],
])
  test(`parity with untouched HTML: ${name}`, () => {
    const d = sample();
    mutate(d);
    for (const [start, end] of [
      ["2026-10-01", "2026-10-31"],
      ["2026-10-02", "2026-10-04"],
      ["2026-09-28", "2026-11-01"],
      ["2027-01-01", "2027-01-31"],
    ]) {
      const before = JSON.stringify(d),
        c = calc(d, start, end);
      assert.deepEqual(
        plain({
          metrics: c.metrics(),
          payroll: c.payrollTotals(),
          weeks: c.weeks(),
        }),
        baseline(d, start, end),
      );
      assert.equal(
        JSON.stringify(d),
        before,
        "calculations must not mutate the snapshot",
      );
    }
  });
