import { validDate, validMonth, weekdays } from "./calculations/dates.js";
// Compatibility validator for v2 local backups; cloud input validation is separate.
/** @param {unknown} d @returns {import("./contracts/legacy.ts").LegacyLedger} */
export function validate(d) {
  const fail = (s) => {
    throw Error(s);
  };
  const num = (n) =>
    typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e12;
  const text = (t) => typeof t === "string" && t.length <= 2000;
  const amount = (n) => num(n) && Number.isInteger(n);
  const nullable = (n) => n === null || amount(n);
  if (!d || d.version !== 2 || !text(d.store) || !d.store.trim())
    fail("시트 기반 v2 백업 파일을 선택하세요.");
  const ids = new Set();
  for (const key of ["sales", "purchases", "payroll", "inventory", "incomes"]) {
    if (!Array.isArray(d[key]) || d[key].length > 50000) fail("내역 형식 오류");
    for (const r of d[key]) {
      if (!r || !text(r.id) || !r.id || ids.has(r.id)) fail("중복된 기록 ID");
      ids.add(r.id);
      if (key !== "inventory" && (!validDate(r.date) || !text(r.note)))
        fail("날짜·메모 형식 오류");
      if (
        key === "sales" &&
        (!["card", "cash", "transfer"].every((k) => nullable(r[k])) ||
          (["card", "cash", "transfer"].every((k) => r[k] === null) &&
            !r.note.trim()))
      )
        fail("매출 금액을 확인하세요.");
      if (
        key === "purchases" &&
        (!text(r.vendor) ||
          !text(r.item) ||
          !amount(r.amount) ||
          !["월별 구매", "재료 외 지출"].includes(r.group))
      )
        fail("구매 기록 오류");
      if (key === "incomes" && (!amount(r.amount) || !text(r.item)))
        fail("기타수익 오류");
      if (key === "payroll") {
        if (
          ![r.start, r.end].every(
            (t) => t === null || (typeof t === "string" && t.length <= 5),
          ) ||
          !(
            r.breakMinutes === null ||
            (Number.isInteger(r.breakMinutes) &&
              r.breakMinutes >= 0 &&
              r.breakMinutes < 1440)
          )
        )
          fail("근무 입력 오류");
      }
      if (
        key === "inventory" &&
        (!text(r.name) ||
          !r.name.trim() ||
          !text(r.unit) ||
          !r.unit.trim() ||
          !text(r.supplier) ||
          !["qty", "min", "cost"].every((k) => num(r[k]) && r[k] >= 0))
      )
        fail("재고 기록 오류");
    }
    if (
      ["sales", "payroll"].includes(key) &&
      new Set(d[key].map((r) => r.date)).size !== d[key].length
    )
      fail("날짜별 기록이 중복됩니다.");
  }
  if (!d.employment || typeof d.employment !== "object") fail("근무 설정 없음");
  const e = d.employment;
  for (const k of ["hireDate", "firstWeek", "endDate"])
    if (e[k] !== null && !validDate(e[k])) fail("근무 설정 날짜 오류");
  if (
    !(
      e.weeklyHours === null ||
      (num(e.weeklyHours) && e.weeklyHours >= 0 && e.weeklyHours <= 40)
    ) ||
    !(e.holidayDay === null || weekdays.includes(e.holidayDay)) ||
    !num(e.normalDays) ||
    e.normalDays <= 0 ||
    e.normalDays > 7 ||
    !validDate(e.start) ||
    !validDate(e.end) ||
    e.start > e.end
  )
    fail("근무 설정값 오류");
  if (e.hireDate && e.endDate && e.endDate < e.hireDate)
    fail("퇴사일이 입사일보다 빠릅니다.");
  if (
    !e.rates ||
    !Object.values(e.rates).every(
      (v) => Number.isInteger(v) && v > 0 && v <= 10000000,
    )
  )
    fail("시급 설정 오류");
  if (
    e.threshold !== 15 ||
    e.capHours !== 8 ||
    e.maxWeekly !== 40 ||
    e.averageWeeks !== 4
  )
    fail("원본 주휴 계산 기준과 다릅니다.");
  for (const k of ["comparisons", "monthlyExtras", "weeks"])
    if (!d[k] || typeof d[k] !== "object" || Array.isArray(d[k]))
      fail("월별·주간 설정 오류");
  for (const [m, r] of Object.entries(d.comparisons))
    if (!validMonth(m) || !r || !nullable(r.reported) || !text(r.note))
      fail("매출 대조 오류");
  for (const [m, n] of Object.entries(d.monthlyExtras))
    if (!validMonth(m) || !nullable(n)) fail("월 기타수당 오류");
  for (const [date, r] of Object.entries(d.weeks))
    if (
      !validDate(date) ||
      !r ||
      !(
        r.agreed === null ||
        (num(r.agreed) && r.agreed >= 0 && r.agreed <= 40)
      ) ||
      !["미확인", "개근·재직 확인", "결근", "검토필요"].includes(
        r.confirmation,
      ) ||
      !text(r.note)
    )
      fail("주휴 확인 오류");
  if (
    !Array.isArray(d.checks) ||
    d.checks.some((x) => !Number.isInteger(x) || x < 0 || x > 5) ||
    !(
      d.lastBackup === null ||
      (typeof d.lastBackup === "string" && !isNaN(Date.parse(d.lastBackup)))
    )
  )
    fail("설정 형식 오류");
  return d;
}
