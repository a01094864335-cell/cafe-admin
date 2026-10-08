export const sum = (rows, key) =>
  rows.reduce((n, r) => n + (Number(key ? r[key] : r) || 0), 0);
export const ds = (d) => d.toISOString().slice(0, 10),
  day = (s) => new Date(s + "T12:00:00Z"),
  add = (s, n) => {
    const d = day(s);
    d.setUTCDate(d.getUTCDate() + n);
    return ds(d);
  };
export const weekdays = ["일", "월", "화", "수", "목", "금", "토"],
  weekday = (s) => weekdays[day(s).getUTCDay()];
export const monthDays = (m) =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate();
export const validDate = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(day(s)) &&
  ds(day(s)) === s;
export const validMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
