import type { Env } from "../env.ts";
import type { Actor } from "../auth/session.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { base64url, hash } from "../auth/crypto.ts";
import { body, fail, fields, json, string } from "../http.ts";
import { assertion, changed, command } from "./commands.ts";
import { memberGuard, membership } from "./memberships.ts";
import type { Role } from "./memberships.ts";
interface Invite {
  id: string;
  cafe_id: string;
  email: string;
  role: Role;
  inviter_id: string;
  expires_at: string;
  consumed_by: string | null;
  cancelled_at: string | null;
}
async function tokenFor(id: string, env: Env) {
  if (
    !env.INVITATION_TOKEN_KEY ||
    !/^[A-Za-z0-9_-]{43}$/.test(env.INVITATION_TOKEN_KEY)
  )
    fail(503, "TEMPORARILY_UNAVAILABLE");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.INVITATION_TOKEN_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode("invite:" + id),
      ),
    ),
  );
}
async function permitted(env: Env, actor: Actor, cafeId: string, role: Role) {
  const m = await membership(env, actor, cafeId, ["owner", "admin"]);
  if (m.role === "admin" && role !== "staff") fail(403, "FORBIDDEN");
}
export async function invitationRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const manage = path.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/invitations(?:\/([A-Za-z0-9_-]+))?$/,
  );
  const accept = path.match(
    /^\/api\/v1\/invitations\/([A-Za-z0-9_-]{43})(\/accept)?$/,
  );
  if (
    manage &&
    ((!manage[2] && request.method === "POST") ||
      (manage[2] && request.method === "DELETE"))
  ) {
    const actor = await authenticate(request, env);
    await csrf(request, env, actor);
    const [, cafeId, invitationId] = manage;
    if (invitationId) {
      const invite = await env.DB.prepare(
        "SELECT * FROM invitations WHERE id=? AND cafe_id=?",
      )
        .bind(invitationId, cafeId)
        .first<Invite>();
      await membership(env, actor, cafeId, ["owner", "admin"]);
      if (!invite) fail(404, "NOT_FOUND");
      const result = await command(
        env,
        actor,
        request,
        {},
        async () => permitted(env, actor, cafeId, invite.role),
        async () => {
          const ids: string[] = [];
          return {
            cafeId,
            assertionIds: ids,
            result: { id: invitationId, cancelled: true },
            target: invitationId,
            action: "invitation.cancel",
            statements: [
              memberGuard(
                env,
                ids,
                actor,
                cafeId,
                invite.role === "admin" ? ["owner"] : ["owner", "admin"],
              ),
              env.DB.prepare(
                "UPDATE invitations SET cancelled_at=? WHERE id=? AND cafe_id=? AND cancelled_at IS NULL AND consumed_at IS NULL",
              ).bind(new Date().toISOString(), invitationId, cafeId),
              changed(env, ids),
            ],
          };
        },
      );
      return json(result, requestId);
    }
    const input = await body(request);
    fields(input, ["email", "role"]);
    const email = string(input.email, 320).toLowerCase(),
      role = string(input.role) as Role;
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !["admin", "staff"].includes(role)
    )
      fail(400, "VALIDATION_ERROR");
    const result = (await command(
      env,
      actor,
      request,
      { email, role },
      async () => permitted(env, actor, cafeId, role),
      async () => {
        const id = crypto.randomUUID(),
          token = await tokenFor(id, env),
          expiresAt = new Date(Date.now() + 7 * 86400000).toISOString(),
          ids: string[] = [];
        return {
          cafeId,
          assertionIds: ids,
          result: { id, email, role, expiresAt },
          target: id,
          action: "invitation.create",
          statements: [
            memberGuard(
              env,
              ids,
              actor,
              cafeId,
              role === "admin" ? ["owner"] : ["owner", "admin"],
            ),
            env.DB.prepare(
              "INSERT INTO invitations(id,cafe_id,token_hash,email,role,inviter_id,expires_at) VALUES (?,?,?,?,?,?,?)",
            ).bind(
              id,
              cafeId,
              await hash(token),
              email,
              role,
              actor.userId,
              expiresAt,
            ),
          ],
        };
      },
    )) as { id: string };
    const token = await tokenFor(result.id, env);
    const current = await env.DB.prepare(
      "SELECT token_hash FROM invitations WHERE id=? AND cafe_id=?",
    )
      .bind(result.id, cafeId)
      .first<{ token_hash: string }>();
    if (current?.token_hash !== (await hash(token)))
      fail(409, "VERSION_CONFLICT");
    return json({ ...result, token }, requestId, 201);
  }
  if (
    accept &&
    ((!accept[2] && request.method === "GET") ||
      (accept[2] && request.method === "POST"))
  ) {
    const actor = await authenticate(request, env),
      token = accept[1],
      digest = await hash(token);
    const load = () =>
      env.DB.prepare("SELECT * FROM invitations WHERE token_hash=?")
        .bind(digest)
        .first<Invite>();
    const invite = await load();
    if (!invite) fail(404, "NOT_FOUND");
    const authorize = async () => {
      const row = await load();
      if (
        !row ||
        row.cancelled_at ||
        row.expires_at <= new Date().toISOString()
      )
        fail(404, "NOT_FOUND");
      if (!actor.emailVerified || row.email !== actor.email.toLowerCase())
        fail(403, "FORBIDDEN");
      if (row.consumed_by) {
        if (row.consumed_by !== actor.userId) fail(404, "NOT_FOUND");
        await membership(env, actor, row.cafe_id);
        return;
      }
      const inviter = await env.DB.prepare(
        "SELECT role FROM memberships WHERE cafe_id=? AND user_id=? AND status='active'",
      )
        .bind(row.cafe_id, row.inviter_id)
        .first<{ role: Role }>();
      if (
        !inviter ||
        !(
          inviter.role === "owner" ||
          (inviter.role === "admin" && row.role === "staff")
        )
      )
        fail(404, "NOT_FOUND");
    };
    await authorize();
    if (!accept[2])
      return json(
        {
          id: invite.id,
          cafeId: invite.cafe_id,
          role: invite.role,
          expiresAt: invite.expires_at,
          accepted: !!invite.consumed_by,
        },
        requestId,
      );
    await csrf(request, env, actor);
    const result = await command(
      env,
      actor,
      request,
      {},
      authorize,
      async () => {
        const ids: string[] = [];
        return {
          cafeId: invite.cafe_id,
          assertionIds: ids,
          result: { cafeId: invite.cafe_id, joined: true },
          target: invite.id,
          action: "invitation.accept",
          statements: [
            env.DB.prepare(
              `UPDATE invitations SET consumed_by=?,consumed_at=? WHERE id=? AND token_hash=? AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at>?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND lower(email)=invitations.email AND email_verified=1)
          AND EXISTS(SELECT 1 FROM memberships m WHERE m.cafe_id=invitations.cafe_id AND m.user_id=invitations.inviter_id AND m.status='active' AND (m.role='owner' OR (m.role='admin' AND invitations.role='staff')))`,
            ).bind(
              actor.userId,
              new Date().toISOString(),
              invite.id,
              digest,
              new Date().toISOString(),
              actor.userId,
            ),
            changed(env, ids),
            env.DB.prepare(
              `INSERT INTO memberships(id,cafe_id,user_id,role) VALUES (?,?,?,?)
          ON CONFLICT(cafe_id,user_id) DO UPDATE SET status='active',role=excluded.role,version=memberships.version+1,updated_at=? WHERE memberships.status='inactive'`,
            ).bind(
              crypto.randomUUID(),
              invite.cafe_id,
              actor.userId,
              invite.role,
              new Date().toISOString(),
            ),
            changed(env, ids),
          ],
        };
      },
    );
    return json(result, requestId);
  }
  return null;
}
