import { createCalculations } from "../../shared/calculations/ledger.js";
type Row = Record<string, any>;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
// Reuse the preserved calculation module. Each effective period contributes only its own dates.
export function employeePayroll(
  employee: Row,
  settings: Row[],
  rates: Row[],
  work: Row[],
  confirmations: Row[],
  extras: Row[],
  from: string,
  to: string,
) {
  const periods = settings
    .filter((s) => s.employee_id === employee.id)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const logs = work.filter((r) => r.employee_id === employee.id),
    weeks = confirmations.filter((r) => r.employee_id === employee.id),
    monthly = extras.filter((r) => r.employee_id === employee.id);
  const inPeriod = (s: Row, d: string) =>
    d >= s.effective_from && d <= (s.effective_to ?? "9999-12-31");
  const snapshot = (s: Row) => ({
    sales: [],
    purchases: [],
    incomes: [],
    payroll: logs.map((r) => ({
      date: r.business_date,
      start: r.start_time,
      end: r.end_time,
      breakMinutes: r.break_minutes,
      note: r.note,
    })),
    weeks: Object.fromEntries(
      weeks.map((r) => [
        r.week_start,
        { agreed: r.agreed_hours, confirmation: r.confirmation, note: r.note },
      ]),
    ),
    monthlyExtras: {},
    employment: {
      hireDate: employee.hire_date,
      endDate: employee.end_date,
      firstWeek: s.first_week,
      weeklyHours: s.weekly_hours,
      holidayDay: s.holiday_day,
      normalDays: s.normal_days,
      start: s.calculation_start > from ? s.calculation_start : from,
      end: s.calculation_end < to ? s.calculation_end : to,
      threshold: s.threshold,
      capHours: s.cap_hours,
      maxWeekly: s.max_weekly,
      averageWeeks: s.average_weeks,
      rates: Object.fromEntries(
        rates
          .filter((r) => r.settings_id === s.id)
          .map((r) => [r.year, r.hourly_rate]),
      ),
    },
  });
  const calculations = new Map(
    periods.map((s) => [s.id, createCalculations(snapshot(s), from, to)]),
  );
  const details = logs
    .filter((r) => r.business_date >= from && r.business_date <= to)
    .map((r) => {
      const period = periods.find((s) => inPeriod(s, r.business_date));
      const computed = period
        ? calculations
            .get(period.id)!
            .shift({
              date: r.business_date,
              start: r.start_time,
              end: r.end_time,
              breakMinutes: r.break_minutes,
            })
        : { hours: null, base: null, notice: "입력: 급여 설정 필요" };
      return { id: r.id, businessDate: r.business_date, ...computed };
    });
  const weekly = periods.flatMap((s) =>
    calculations
      .get(s.id)!
      .weeks()
      .filter(
        (r) => inPeriod(s, r.holiday) && r.holiday >= from && r.holiday <= to,
      ),
  );
  const base = sum(details.map((r) => r.base ?? 0)),
    holiday = sum(weekly.map((r) => r.amount ?? 0)),
    extra = sum(
      monthly
        .filter((r) => {
          const [year, month] = r.month.split("-").map(Number);
          const end =
            r.month + "-" + new Date(Date.UTC(year, month, 0)).getUTCDate();
          return end >= from && end <= to;
        })
        .map((r) => r.amount ?? 0),
    );
  let coverage = from;
  for (const s of periods) {
    if (s.effective_from > coverage) break;
    if ((s.effective_to ?? "9999-12-31") >= coverage) {
      const end = s.effective_to ?? "9999-12-31";
      if (end >= to) {
        coverage = "covered";
        break;
      }
      coverage = new Date(Date.parse(end + "T12:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
    }
  }
  const pending =
    coverage !== "covered" ||
    details.some((r) => r.base === null) ||
    weekly.some((r) => r.amount === null) ||
    periods.some(
      (s) =>
        s.effective_from <= to &&
        (s.effective_to ?? "9999-12-31") >= from &&
        !calculations.get(s.id)!.employmentReady(),
    );
  return {
    employeeId: employee.id,
    name: employee.name,
    base,
    holiday,
    extra,
    total: base + holiday + extra,
    hours: sum(details.map((r) => r.hours ?? 0)),
    pending,
    notices: details.filter((r) => r.notice).length,
    weekly,
    work: details,
  };
}
