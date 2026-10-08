/** v2 backup contract. This does not grant access to any cloud cafe. */
export type Amount = number | null;
export interface DatedRecord {
  id: string;
  date: string;
  note: string;
  source?: { file: string; sheet: string; row: number };
  modified?: boolean;
}
export interface Sale extends DatedRecord {
  card: Amount;
  cash: Amount;
  transfer: Amount;
}
export interface Purchase extends DatedRecord {
  group: "월별 구매" | "재료 외 지출";
  vendor: string;
  item: string;
  amount: number;
}
export interface WorkLog extends DatedRecord {
  start: string | null;
  end: string | null;
  breakMinutes: number | null;
}
export interface Income extends DatedRecord {
  item: string;
  amount: number;
}
export interface InventoryItem {
  id: string;
  name: string;
  qty: number;
  min: number;
  unit: string;
  cost: number;
  supplier: string;
}
export interface Employment {
  hireDate: string | null;
  firstWeek: string | null;
  endDate: string | null;
  weeklyHours: number | null;
  holidayDay: string | null;
  normalDays: number;
  rates: Record<string, number>;
  start: string;
  end: string;
  threshold: number;
  capHours: number;
  maxWeekly: number;
  averageWeeks: number;
}
export interface LegacyLedger {
  version: 2;
  store: string;
  sales: Sale[];
  purchases: Purchase[];
  payroll: WorkLog[];
  incomes: Income[];
  inventory: InventoryItem[];
  employment: Employment;
  comparisons: Record<string, { reported: Amount; note: string }>;
  monthlyExtras: Record<string, Amount>;
  weeks: Record<
    string,
    {
      agreed: Amount;
      confirmation: "미확인" | "개근·재직 확인" | "결근" | "검토필요";
      note: string;
    }
  >;
  checks: number[];
  lastBackup: string | null;
  importedAt?: string | null;
  sourceVersion?: string;
  sourceControls?: Record<string, unknown>;
}
