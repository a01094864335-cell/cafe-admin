import { validate } from "./validate.js";
export const importKinds = [
  "meta",
  "rates",
  "sales",
  "purchases",
  "incomes",
  "inventory",
  "payroll",
  "weeks",
  "monthlyExtras",
  "comparisons",
];
export async function digest(value) {
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function createImportPlan(value, fileBytes) {
  if (fileBytes > 20 * 1024 * 1024)
    throw Error("백업 파일은 20MiB 이하여야 합니다.");
  const data = validate(value);
  if (
    Object.keys(data.employment.rates).some(
      (y) => !/^\d{4}$/.test(y) || Number(y) < 1900,
    )
  )
    throw Error("시급의 적용 연도는 1900–9999년이어야 합니다.");
  for (const r of data.inventory)
    if (
      !Number.isInteger(r.cost) ||
      [r.qty, r.min].some((v) => Math.abs(v * 100 - Math.round(v * 100)) > 1e-7)
    )
      throw Error(
        "재고 수량은 소수 둘째 자리까지, 단가는 정수 원 단위여야 합니다.",
      );
  const meta = {
    version: 2,
    store: data.store,
    employment: data.employment,
    checks: data.checks,
    lastBackup: data.lastBackup,
    importedAt: data.importedAt ?? null,
    sourceVersion: data.sourceVersion ?? null,
    sourceControls: data.sourceControls ?? {},
  };
  const chunks = [{ kind: "meta", rows: [meta] }];
  const records = {
    rates: Object.entries(data.employment.rates).map(([year, rate]) => ({
      year: Number(year),
      rate,
    })),
    sales: data.sales,
    purchases: data.purchases,
    incomes: data.incomes,
    inventory: data.inventory,
    payroll: data.payroll,
    weeks: Object.entries(data.weeks).map(([date, record]) => ({
      date,
      ...record,
    })),
    monthlyExtras: Object.entries(data.monthlyExtras).map(
      ([month, amount]) => ({ month, amount }),
    ),
    comparisons: Object.entries(data.comparisons).map(([month, record]) => ({
      month,
      ...record,
    })),
  };
  for (const [kind, rows] of Object.entries(records))
    for (let i = 0; i < rows.length; i += 10)
      chunks.push({ kind, rows: rows.slice(i, i + 10) });
  const manifest = [];
  for (const chunk of chunks) {
    const encoded = JSON.stringify(chunk),
      bytes = new TextEncoder().encode(encoded).length;
    if (bytes > 128 * 1024)
      throw Error(
        "한 묶음의 자료가 128KiB를 초과합니다. 메모나 설정을 줄여 주세요.",
      );
    manifest.push({
      kind: chunk.kind,
      hash: await digest(encoded),
      bytes,
      count: chunk.rows.length,
    });
  }
  if (manifest.reduce((sum, r) => sum + r.bytes, 0) > 20 * 1024 * 1024)
    throw Error("이전할 정규화 자료가 20MiB를 초과합니다.");
  return { chunks, manifest, fileHash: await digest({ version: 2, manifest }) };
}
