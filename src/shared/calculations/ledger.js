import { sum, day, add, weekdays, monthDays } from "./dates.js";
// Explicit snapshot and range: no browser, storage, or mutable global dependencies.
export function createCalculations(db, rangeStart, rangeEnd) {
  const saleTotal = (r) =>
    hasSale(r) ? sum([r.card, r.cash, r.transfer]) : null;
  const hasSale = (r) =>
    r && ["card", "cash", "transfer"].some((k) => r[k] !== null);
  function bounds(m) {
    return m ? [m + "-01", m + "-" + monthDays(m)] : [rangeStart, rangeEnd];
  }
  function within(date, m) {
    const [start, end] = bounds(m);
    return date >= start && date <= end;
  }
  function selected(key, m) {
    return db[key].filter((r) => within(r.date, m));
  }
  function extraTotal(start, end) {
    return sum(
      Object.entries(db.monthlyExtras)
        .filter(
          ([m]) =>
            m + "-" + monthDays(m) >= start && m + "-" + monthDays(m) <= end,
        )
        .map(([, n]) => n),
    );
  }
  function minutes(t, end = false) {
    if (end && t === "24:00") return 1440;
    if (typeof t !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))
      return null;
    return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  }
  function shift(r) {
    const a = minutes(r.start),
      b = minutes(r.end, true),
      pause = r.breakMinutes;
    if (
      a === null ||
      b === null ||
      pause === null ||
      !Number.isInteger(pause) ||
      pause < 0
    )
      return { hours: null, base: null, notice: "입력: 시각·휴게" };
    const elapsed = (b < a ? b + 1440 : b) - a;
    if (elapsed <= 0 || elapsed >= 1440 || pause >= elapsed)
      return { hours: null, base: null, notice: "입력: 시간 재확인" };
    if (b < a && add(r.date, 1).slice(0, 7) !== r.date.slice(0, 7))
      return { hours: null, base: null, notice: "입력: 자정 기준 분리" };
    const hours = (elapsed - pause) / 60,
      rate = db.employment.rates[r.date.slice(0, 4)];
    if (!rate) return { hours, base: null, notice: "입력: 연도 시급 필요" };
    const e = db.employment;
    let notice = "";
    if (e.hireDate && r.date < e.hireDate) notice = "입사일 이전 확인";
    else if (e.endDate && r.date > e.endDate) notice = "퇴사일 이후 확인";
    else if (r.date.slice(5) === "05-01") notice = "5/1 기타수당 확인";
    else if (
      (hours >= 8 && pause < 60) ||
      (hours >= 4 && hours < 8 && pause < 30)
    )
      notice =
        hours === 4 && r.date >= "2026-12-10"
          ? "휴게 면제요청 확인"
          : "휴게 부여 확인";
    else if (hours > 8 || b < a || b > 22 * 60 || a < 6 * 60)
      notice = "가산수당 적용 확인";
    return {
      hours,
      rate,
      base: Math.ceil(((elapsed - pause) * rate) / 60 - 1e-8),
      notice,
    };
  }
  function employmentReady() {
    const e = db.employment;
    return !!(
      e.hireDate &&
      e.firstWeek &&
      e.weeklyHours !== null &&
      e.holidayDay
    );
  }
  function weeks() {
    if (!employmentReady()) return [];
    const e = db.employment;
    const difference = Math.round((day(e.start) - day(e.firstWeek)) / 86400000);
    const mod = ((difference % 7) + 7) % 7;
    const start = [e.firstWeek, add(e.start, -mod - 21)].sort().at(-1);
    const rows = [];
    for (
      let date = start;
      date <= e.end && rows.length < 600;
      date = add(date, 7)
    ) {
      const end = add(date, 6),
        holiday = add(
          date,
          (weekdays.indexOf(e.holidayDay) - day(date).getUTCDay() + 7) % 7,
        ),
        override = db.weeks[date] || {
          agreed: null,
          confirmation: "미확인",
          note: "",
        };
      const outside = end < e.hireDate || (e.endDate && date > e.endDate);
      const agreed = outside ? null : (override.agreed ?? e.weeklyHours);
      const prior = rows
        .slice(-3)
        .map((r) => r.agreed)
        .concat([agreed]);
      const average = prior.every((x) => x !== null)
        ? sum(prior) / prior.length
        : null;
      const records = db.payroll.filter((r) => r.date >= date && r.date <= end),
        actual = sum(records.map((r) => shift(r).hours));
      let status = "";
      if (outside) status = "재직기간 밖";
      else if (agreed === null || average === null) status = "약정·설정 미확인";
      else if (date < e.hireDate || (e.endDate && end > e.endDate))
        status = "입퇴사 주 개별검토";
      else if (override.confirmation === "검토필요") status = "개별검토";
      else if (records.some((r) => shift(r).notice.startsWith("입력")))
        status = "근무입력 미확인";
      else if (agreed === 0 && average >= 15) status = "무근로 주 개별검토";
      else if (override.confirmation === "결근") status = "결근·미발생";
      else if (average < 15)
        status =
          actual >= 15 && override.confirmation !== "개근·재직 확인"
            ? "15h↑·약정 미확인"
            : "15h 미만·미발생";
      else
        status =
          override.confirmation === "개근·재직 확인"
            ? "주휴 반영"
            : "주휴 미확인";
      let amount = ["재직기간 밖", "결근·미발생", "15h 미만·미발생"].includes(
        status,
      )
        ? 0
        : null;
      if (status === "주휴 반영") {
        const rate = e.rates[holiday.slice(0, 4)];
        if (rate)
          amount = Math.ceil(Math.min(average / e.normalDays, 8) * rate - 1e-8);
        else status = "연도 시급 미확인";
      }
      rows.push({
        date,
        end,
        holiday,
        agreed,
        average,
        actual,
        status,
        amount,
        confirmation: override.confirmation,
        note: override.note,
      });
    }
    return rows;
  }
  function payrollTotals(m) {
    const records = selected("payroll", m),
      computed = records.map(shift),
      weekly = weeks().filter((r) => within(r.holiday, m));
    const base = sum(computed.map((r) => r.base)),
      holiday = sum(weekly.map((r) => r.amount)),
      extra = extraTotal(...bounds(m));
    const inRange =
      bounds(m)[1] >= db.employment.start && bounds(m)[0] <= db.employment.end;
    const pending =
      (!employmentReady() && inRange) ||
      weekly.some((r) => r.amount === null) ||
      computed.some((r) => r.base === null);
    return {
      base,
      holiday,
      extra,
      total: base + holiday + extra,
      hours: sum(computed.map((r) => r.hours)),
      pending,
      notices: computed.filter((r) => r.notice).length,
      weekly,
    };
  }
  function metrics(m) {
    const sale = selected("sales", m),
      p = selected("purchases", m),
      w = payrollTotals(m);
    const revenue = sum(sale.map(saleTotal)),
      other = sum(selected("incomes", m), "amount"),
      purchases = sum(
        p.filter((r) => r.group === "월별 구매"),
        "amount",
      ),
      misc = sum(
        p.filter((r) => r.group === "재료 외 지출"),
        "amount",
      );
    return {
      revenue,
      other,
      income: revenue + other,
      purchases,
      misc,
      wages: w.total,
      cost: purchases + misc + w.total,
      profit: revenue + other - purchases - misc - w.total,
      pending: w.pending,
      recorded: sale.filter(hasSale).length,
    };
  }
  return {
    bounds,
    within,
    selected,
    extraTotal,
    hasSale,
    saleTotal,
    minutes,
    shift,
    employmentReady,
    weeks,
    payrollTotals,
    metrics,
  };
}
