import { limitMutation } from "../services/operations.ts";
import type { Env } from "../env.ts";
import { cookie, fail } from "../http.ts";
import { hash } from "./crypto.ts";
export interface Actor {
  userId: string;
  sessionHash: string;
  email: string;
  emailVerified: number;
  name: string;
  csrfHash: string;
}
export async function authenticate(request: Request, env: Env): Promise<Actor> {
  const token = cookie(request, "__Host-session");
  if (!token) fail(401, "UNAUTHENTICATED");
  const sessionHash = await hash(token);
  const user = await env.DB.prepare(
    `SELECT u.id userId,u.email,u.email_verified emailVerified,u.name,s.csrf_hash csrfHash
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`,
  )
    .bind(sessionHash, new Date().toISOString())
    .first<Omit<Actor, "sessionHash">>();
  if (!user) fail(401, "UNAUTHENTICATED");
  return { ...user, sessionHash };
}
export function origin(env: Env): string {
  if (!env.APP_ORIGIN) fail(503, "TEMPORARILY_UNAVAILABLE");
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.origin !== env.APP_ORIGIN || url.protocol !== "https:")
      fail(503, "TEMPORARILY_UNAVAILABLE");
    return url.origin;
  } catch {
    return fail(503, "TEMPORARILY_UNAVAILABLE");
  }
}
export async function csrf(request: Request, env: Env, actor: Actor) {
  if (request.headers.get("Origin") !== origin(env)) fail(403, "CSRF_INVALID");
  const token = request.headers.get("X-CSRF-Token");
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    (await hash(token)) !== actor.csrfHash
  )
    fail(403, "CSRF_INVALID");
  await limitMutation(env, actor.userId);
}
