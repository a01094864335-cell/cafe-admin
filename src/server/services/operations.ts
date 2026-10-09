import type { Env } from "../env.ts";
import { HttpError } from "../http.ts";

// One bounded counter per authenticated user, shared across sessions and cafes.
export async function limitMutation(
  env: Env,
  userId: string,
  now = Date.now(),
) {
  const window = Math.floor(now / 60000);
  const admitted = await env.DB.prepare(
    `
    INSERT INTO request_windows(user_id,window,count) VALUES (?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET window=excluded.window,
      count=CASE WHEN request_windows.window=excluded.window THEN request_windows.count+1 ELSE 1 END
    WHERE request_windows.window<>excluded.window OR request_windows.count<120
    RETURNING count`,
  )
    .bind(userId, window)
    .first();
  if (!admitted) throw new HttpError(429, "RATE_LIMITED");
}

// Bounded hourly housekeeping; business data and replay/audit history are retained.
export async function cleanupExpired(env: Env, now = new Date().toISOString()) {
  return env.DB.batch([
    env.DB.prepare(
      "DELETE FROM oauth_transactions WHERE state_hash IN (SELECT state_hash FROM oauth_transactions WHERE expires_at<=? ORDER BY expires_at LIMIT 500)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 500)",
    ).bind(now),
  ]);
}

export function operationalError(error: unknown) {
  if (error instanceof HttpError) return error;
  // Inspect only for classification. Raw database errors can contain input/SQL.
  if (
    error instanceof Error &&
    /D1|SQLITE/i.test(error.message) &&
    /quota|limit exceeded|too many|overload|busy|timeout|timed out|storage|space|SQLITE_FULL/i.test(
      error.message,
    )
  )
    return new HttpError(503, "TEMPORARILY_UNAVAILABLE");
  return new HttpError(500, "INTERNAL_ERROR");
}

export function routeGroup(path: string) {
  if (path.startsWith("/auth/")) return "auth";
  const resource = path.match(/^\/api\/v1\/cafes\/[^/]+\/([^/]+)/)?.[1];
  return [
    "sales",
    "purchases",
    "expenses",
    "other-incomes",
    "inventory",
    "employees",
    "payroll",
    "dashboard",
    "imports",
    "exports",
    "audit",
    "members",
    "invitations",
  ].includes(resource ?? "")
    ? resource!
    : "api";
}
