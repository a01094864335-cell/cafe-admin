import { pagination, page } from "../pagination.ts";
import type { Env } from "../env.ts";
import type { Actor } from "../auth/session.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fail, fields, json, string, version } from "../http.ts";
import { assertion, changed, command } from "./commands.ts";
export type Role = "owner" | "admin" | "staff";
export interface Membership {
  id: string;
  role: Role;
  version: number;
}
export async function membership(
  env: Env,
  actor: Actor,
  cafeId: string,
  roles: Role[] = ["owner", "admin", "staff"],
) {
  const row = await env.DB.prepare(
    "SELECT id,role,version FROM memberships WHERE cafe_id=? AND user_id=? AND status='active'",
  )
    .bind(cafeId, actor.userId)
    .first<Membership>();
  if (!row) fail(404, "NOT_FOUND");
  if (!roles.includes(row.role)) fail(403, "FORBIDDEN");
  return row;
}
export function memberGuard(
  env: Env,
  ids: string[],
  actor: Actor,
  cafeId: string,
  roles: Role[],
  open = false,
) {
  return assertion(
    env,
    ids,
    `EXISTS(SELECT 1 FROM memberships m JOIN cafes c ON c.id=m.cafe_id WHERE m.cafe_id=? AND m.user_id=? AND m.status='active' AND m.role IN (${roles.map(() => "?").join(",")}) ${open ? "AND c.write_mode='open'" : ""})`,
    cafeId,
    actor.userId,
    ...roles,
  );
}
export async function cafeRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/cafes" && ["GET", "POST"].includes(request.method)) {
    const actor = await authenticate(request, env);
    if (request.method === "GET") {
      const p = pagination(request, "cafes:" + actor.userId);
      const rows = await env.DB.prepare(
        "SELECT c.id,c.name,c.timezone,c.version,m.role FROM cafes c JOIN memberships m ON m.cafe_id=c.id WHERE m.user_id=? AND m.status='active' AND c.id>? ORDER BY c.id LIMIT ?",
      )
        .bind(actor.userId, p.after, p.limit + 1)
        .all();
      return page(rows.results, p, "id", requestId);
    }
    await csrf(request, env, actor);
    const input = await body(request);
    fields(input, ["name", "timezone"]);
    const name = string(input.name, 100),
      timezone =
        input.timezone === undefined
          ? "Asia/Seoul"
          : string(input.timezone, 100);
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
    const result = await command(
      env,
      actor,
      request,
      { name, timezone },
      async () => {
        await authenticate(request, env);
      },
      async () => {
        const cafeId = crypto.randomUUID(),
          datasetId = crypto.randomUUID();
        return {
          cafeId,
          assertionIds: [],
          result: { id: cafeId, name, timezone, role: "owner", version: 1 },
          target: cafeId,
          action: "cafe.create",
          statements: [
            env.DB.prepare(
              "INSERT INTO cafes(id,name,timezone) VALUES (?,?,?)",
            ).bind(cafeId, name, timezone),
            env.DB.prepare(
              "INSERT INTO datasets(cafe_id,id,state) VALUES (?,?,'active')",
            ).bind(cafeId, datasetId),
            env.DB.prepare(
              "INSERT INTO memberships(id,cafe_id,user_id,role) VALUES (?,?,?,'owner')",
            ).bind(crypto.randomUUID(), cafeId, actor.userId),
            env.DB.prepare(
              "UPDATE cafes SET active_dataset_id=? WHERE id=?",
            ).bind(datasetId, cafeId),
          ],
        };
      },
    );
    // A replay after participation removal must not reveal a former cafe.
    await membership(env, actor, (result as { id: string }).id);
    return json(result, requestId, 201);
  }
  const match = path.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)(?:\/(members)(?:\/([A-Za-z0-9_-]+))?|\/(ownership-transfer))?$/,
  );
  if (!match) return null;
  const [, cafeId, resource, targetUser, transfer] = match;
  const known = transfer
    ? request.method === "POST"
    : resource
      ? targetUser
        ? ["PATCH", "DELETE"].includes(request.method)
        : request.method === "GET"
      : ["GET", "PATCH"].includes(request.method);
  if (!known) return null;
  const actor = await authenticate(request, env);
  if (!resource && !transfer && request.method === "GET") {
    const m = await membership(env, actor, cafeId);
    const cafe = await env.DB.prepare(
      "SELECT id,name,timezone,version FROM cafes WHERE id=?",
    )
      .bind(cafeId)
      .first();
    return json({ ...cafe, role: m.role }, requestId);
  }
  if (resource && !targetUser) {
    await membership(env, actor, cafeId, ["owner", "admin"]);
    const p = pagination(request, "members:" + cafeId + ":" + actor.userId);
    const rows = await env.DB.prepare(
      "SELECT m.user_id userId,u.name,u.email,m.role,m.status,m.version FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.cafe_id=? AND m.user_id>? ORDER BY m.user_id LIMIT ?",
    )
      .bind(cafeId, p.after, p.limit + 1)
      .all();
    return page(rows.results, p, "userId", requestId);
  }
  await csrf(request, env, actor);
  const input = await body(request);
  if (transfer) {
    fields(input, ["userId", "expectedVersion"]);
    const target = string(input.userId, 100),
      expected = version(input.expectedVersion);
    if (target === actor.userId) fail(400, "VALIDATION_ERROR");
    const authorize = async () => {
      await membership(env, actor, cafeId, ["owner"]);
      const cafe = await env.DB.prepare(
        "SELECT write_mode FROM cafes WHERE id=?",
      )
        .bind(cafeId)
        .first<{ write_mode: string }>();
      if (cafe?.write_mode !== "open") fail(409, "CAFE_WRITE_LOCKED");
    };
    const result = await command(
      env,
      actor,
      request,
      { userId: target, expectedVersion: expected },
      authorize,
      async () => {
        await authorize();
        const ids: string[] = [];
        return {
          cafeId,
          assertionIds: ids,
          result: { ownerUserId: target },
          target: cafeId,
          action: "ownership.transfer",
          statements: [
            memberGuard(env, ids, actor, cafeId, ["owner"], true),
            env.DB.prepare(
              "UPDATE memberships SET role='admin',version=version+1,updated_at=? WHERE cafe_id=? AND user_id=? AND role='owner' AND status='active' AND version=?",
            ).bind(new Date().toISOString(), cafeId, actor.userId, expected),
            changed(env, ids),
            env.DB.prepare(
              "UPDATE memberships SET role='owner',version=version+1,updated_at=? WHERE cafe_id=? AND user_id=? AND status='active' AND role!='owner'",
            ).bind(new Date().toISOString(), cafeId, target),
            changed(env, ids),
          ],
        };
      },
    );
    return json(result, requestId);
  }
  if (resource && targetUser) {
    fields(
      input,
      request.method === "PATCH"
        ? ["role", "expectedVersion"]
        : ["expectedVersion"],
    );
    const expected = version(input.expectedVersion),
      role = request.method === "PATCH" ? string(input.role) : null;
    if (role && !["admin", "staff"].includes(role))
      fail(400, "VALIDATION_ERROR");
    const authorize = async () => {
      const m = await membership(env, actor, cafeId, ["owner", "admin"]);
      const target = await env.DB.prepare(
        "SELECT role FROM memberships WHERE cafe_id=? AND user_id=?",
      )
        .bind(cafeId, targetUser)
        .first<{ role: Role }>();
      if (!target) fail(404, "NOT_FOUND");
      if (
        target.role === "owner" ||
        (m.role === "admin" &&
          (target.role !== "staff" || (role && role !== "staff")))
      )
        fail(403, "FORBIDDEN");
    };
    const result = await command(
      env,
      actor,
      request,
      { expectedVersion: expected, role },
      authorize,
      async () => {
        const ids: string[] = [];
        return {
          cafeId,
          assertionIds: ids,
          result: { userId: targetUser, version: expected + 1 },
          target: targetUser,
          action: role ? "member.role" : "member.remove",
          statements: [
            memberGuard(env, ids, actor, cafeId, ["owner", "admin"]),
            env.DB.prepare(
              `UPDATE memberships SET ${role ? "role=?" : "status='inactive'"},version=version+1,updated_at=?
          WHERE cafe_id=? AND user_id=? AND version=? AND status='active' AND role!='owner'
          AND EXISTS(SELECT 1 FROM memberships actor WHERE actor.cafe_id=? AND actor.user_id=? AND actor.status='active'
            AND (actor.role='owner' OR (actor.role='admin' AND memberships.role='staff' AND ?='staff')))`,
            ).bind(
              ...(role ? [role] : []),
              new Date().toISOString(),
              cafeId,
              targetUser,
              expected,
              cafeId,
              actor.userId,
              role ?? "staff",
            ),
            changed(env, ids),
          ],
        };
      },
    );
    return json(result, requestId);
  }
  fields(input, ["name", "timezone", "expectedVersion"]);
  const name = input.name === undefined ? null : string(input.name, 100),
    timezone =
      input.timezone === undefined ? null : string(input.timezone, 100),
    expected = version(input.expectedVersion);
  if (name === null && timezone === null) fail(400, "VALIDATION_ERROR");
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      fail(400, "VALIDATION_ERROR");
    }
  }
  const result = await command(
    env,
    actor,
    request,
    { name, timezone, expectedVersion: expected },
    async () => {
      await membership(env, actor, cafeId, ["owner"]);
    },
    async () => {
      const ids: string[] = [];
      return {
        cafeId,
        assertionIds: ids,
        result: { id: cafeId, version: expected + 1 },
        target: cafeId,
        action: "cafe.update",
        statements: [
          memberGuard(env, ids, actor, cafeId, ["owner"]),
          env.DB.prepare(
            "UPDATE cafes SET name=COALESCE(?,name),timezone=COALESCE(?,timezone),version=version+1 WHERE id=? AND version=?",
          ).bind(name, timezone, cafeId, expected),
          changed(env, ids),
        ],
      };
    },
  );
  return json(result, requestId);
}
