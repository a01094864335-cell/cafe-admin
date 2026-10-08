import { fail } from "./http.ts";
export function pagination(request: Request, scope: string) {
  const params = new URL(request.url).searchParams;
  const raw = params.get("limit") ?? "50";
  if (
    !/^\d+$/.test(raw) ||
    Number(raw) < 1 ||
    Number(raw) > 100 ||
    params.getAll("limit").length > 1 ||
    params.getAll("cursor").length > 1
  )
    fail(400, "VALIDATION_ERROR");
  let after = "";
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      const parsed = JSON.parse(atob(cursor));
      if (
        parsed.scope !== scope ||
        typeof parsed.after !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(parsed.after)
      )
        fail(400, "VALIDATION_ERROR");
      after = parsed.after;
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
  }
  return { limit: Number(raw), after, scope };
}
export function page<T extends Record<string, unknown>>(
  rows: T[],
  p: ReturnType<typeof pagination>,
  key: string,
  requestId: string,
) {
  const more = rows.length > p.limit,
    data = rows.slice(0, p.limit);
  const nextCursor = more
    ? btoa(
        JSON.stringify({ scope: p.scope, after: data[data.length - 1][key] }),
      )
    : null;
  return Response.json(
    { data, nextCursor, requestId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
