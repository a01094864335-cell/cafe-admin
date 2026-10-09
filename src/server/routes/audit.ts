import type { Env } from "../env.ts";
import { authenticate } from "../auth/session.ts";
import { membership } from "../services/memberships.ts";
import { fail } from "../http.ts";

export async function auditRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = url.pathname.match(/^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/audit$/);
  if (!match || request.method !== "GET") return null;
  const cafeId = match[1],
    actor = await authenticate(request, env);
  await membership(env, actor, cafeId, ["owner", "admin"]);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("cursor").length > 1
  )
    fail(400, "VALIDATION_ERROR");
  let date = "9999",
    id = "~";
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    try {
      if (cursor.length > 1000) throw Error();
      const value = JSON.parse(atob(cursor));
      if (
        value.cafe !== cafeId ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.date) ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
      )
        throw Error();
      date = value.date;
      id = value.id;
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
  }
  const rows = (
    await env.DB.prepare(
      `SELECT a.id,a.actor_id actorId,u.name actorName,a.target,a.action,a.created_at createdAt,a.request_id requestId
    FROM audit_logs a JOIN users u ON u.id=a.actor_id
    WHERE a.cafe_id=? AND (a.created_at,a.id)<(?,?) ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
    )
      .bind(cafeId, date, id, limit + 1)
      .all<Record<string, any>>()
  ).results;
  await membership(env, actor, cafeId, ["owner", "admin"]);
  const data = rows.slice(0, limit).map((r) => ({ ...r, outcome: "success" }));
  const last = rows[Math.min(limit, rows.length) - 1];
  return Response.json(
    {
      data,
      nextCursor:
        rows.length > limit
          ? btoa(
              JSON.stringify({
                cafe: cafeId,
                date: last!.createdAt,
                id: last!.id,
              }),
            )
          : null,
      requestId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
