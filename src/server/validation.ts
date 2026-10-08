import { fail } from "./http.ts";
export function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1900-01-01" ||
    value > "9999-12-31"
  )
    fail(400, "VALIDATION_ERROR");
  const d = new Date(value + "T12:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    fail(400, "VALIDATION_ERROR");
  return value;
}
export function month(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value))
    fail(400, "VALIDATION_ERROR");
  date(value + "-01");
  return value;
}
export function money(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 1e12)
    fail(400, "VALIDATION_ERROR");
  return value as number;
}
export function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || value.length > max)
    fail(400, "VALIDATION_ERROR");
  return value;
}
export function hundredths(value: unknown): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 1e12)
    fail(400, "VALIDATION_ERROR");
  return value as number;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    fail(400, "VALIDATION_ERROR");
  return value;
}
