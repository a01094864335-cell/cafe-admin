import type { Env } from "../env.ts";
import type { Actor } from "../auth/session.ts";
import type { Role } from "../services/memberships.ts";
import { membership, memberGuard } from "../services/memberships.ts";
import { assertion } from "../services/commands.ts";
import { fail } from "../http.ts";
export interface Scope {
  cafeId: string;
  datasetId: string;
  revision: number;
}
export async function ledgerScope(
  env: Env,
  actor: Actor,
  cafeId: string,
  write = false,
  roles: Role[] = ["owner", "admin"],
): Promise<Scope> {
  await membership(env, actor, cafeId, roles);
  const row = await env.DB.prepare(
    `SELECT c.active_dataset_id datasetId,c.revision,c.write_mode FROM cafes c JOIN datasets d ON d.cafe_id=c.id AND d.id=c.active_dataset_id AND d.state='active' WHERE c.id=?`,
  )
    .bind(cafeId)
    .first<{ datasetId: string; revision: number; write_mode: string }>();
  if (!row) fail(404, "NOT_FOUND");
  if (write && row.write_mode !== "open") fail(409, "CAFE_WRITE_LOCKED");
  return { cafeId, datasetId: row.datasetId, revision: row.revision };
}
export function scopeGuards(
  env: Env,
  actor: Actor,
  scope: Scope,
  ids: string[],
  roles: Role[] = ["owner", "admin"],
) {
  return [
    memberGuard(env, ids, actor, scope.cafeId, roles, true),
    assertion(
      env,
      ids,
      "EXISTS(SELECT 1 FROM cafes c JOIN datasets d ON d.cafe_id=c.id AND d.id=c.active_dataset_id WHERE c.id=? AND c.active_dataset_id=? AND d.state='active')",
      scope.cafeId,
      scope.datasetId,
    ),
  ];
}
