export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function fail(status: number, code: string): never {
  throw new HttpError(status, code);
}
export function json(data: unknown, requestId: string, status = 200) {
  return Response.json(
    { data, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("Content-Type")
      ?.split(";")[0]
      .trim()
      .match(/^application\/json$/i)
  )
    fail(400, "VALIDATION_ERROR");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "VALIDATION_ERROR");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16384) {
      await reader.cancel();
      fail(413, "PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail(400, "VALIDATION_ERROR");
    return parsed;
  } catch {
    return fail(400, "VALIDATION_ERROR");
  }
}
export function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    fail(400, "VALIDATION_ERROR");
}
export function string(input: unknown, max = 200): string {
  if (typeof input !== "string" || !input.trim() || input.length > max)
    fail(400, "VALIDATION_ERROR");
  return input.trim();
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(400, "VALIDATION_ERROR");
  return value as number;
}
export function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  httpOnly = true,
) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}`;
}
