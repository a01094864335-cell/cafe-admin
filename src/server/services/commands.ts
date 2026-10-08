import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../env.ts";
import type { Actor } from "../auth/session.ts";
import { hash } from "../auth/crypto.ts";
import { fail } from "../http.ts";
import { atomicCafeBatch } from "../repositories/atomic.ts";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function assertion(
  env: Env,
  ids: string[],
  predicate: string,
  ...values: (string | number | null)[]
) {
  const id = crypto.randomUUID();
  ids.push(id);
  return env.DB.prepare(
    `INSERT INTO transaction_assertions(id,ok) SELECT ?,(${predicate})`,
  ).bind(id, ...values);
}
export function changed(env: Env, ids: string[]) {
  return assertion(env, ids, "changes()=1");
}
export interface CommandPlan {
  cafeId: string;
  bindCafeBeforeWrite?: boolean;
  statements: D1PreparedStatement[];
  assertionIds: string[];
  result: unknown;
  target: string;
  action: string;
}
// authorize is rerun even for replay and after batch failure; responses never outlive current access.
export async function command(
  env: Env,
  actor: Actor,
  request: Request,
  payload: unknown,
  authorize: () => Promise<void>,
  plan: (operationId: string) => Promise<CommandPlan>,
): Promise<unknown> {
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    fail(400, "VALIDATION_ERROR");
  const path = new URL(request.url).pathname;
  const tokenPath = path.match(
    /^(\/api\/v1\/invitations\/)([A-Za-z0-9_-]{43})(\/accept)$/,
  );
  const scope =
    request.method +
    ":" +
    (tokenPath
      ? tokenPath[1] + (await hash(tokenPath[2])) + tokenPath[3]
      : path);
  const digest = await hash(canonical(payload));
  await authorize();
  const lookup = () =>
    env.DB.prepare(
      "SELECT payload_hash,result_json FROM commands WHERE user_id=? AND scope=? AND key=?",
    )
      .bind(actor.userId, scope, key)
      .first<{ payload_hash: string; result_json: string }>();
  const replay = (row: { payload_hash: string; result_json: string }) => {
    if (row.payload_hash !== digest) fail(409, "IDEMPOTENCY_MISMATCH");
    return JSON.parse(row.result_json);
  };
  const existing = await lookup();
  if (existing) return replay(existing);
  const id = crypto.randomUUID(),
    p = await plan(id),
    ids = p.assertionIds;
  try {
    await atomicCafeBatch(
      env.DB,
      p.cafeId,
      [
        env.DB.prepare(
          "INSERT INTO commands(id,user_id,scope,key,payload_hash,cafe_id) VALUES (?,?,?,?,?,?)",
        ).bind(
          id,
          actor.userId,
          scope,
          key,
          digest,
          p.bindCafeBeforeWrite ? p.cafeId : null,
        ),
        assertion(
          env,
          ids,
          "EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND revoked_at IS NULL AND expires_at>?)",
          actor.sessionHash,
          actor.userId,
          new Date().toISOString(),
        ),
        ...p.statements,
        env.DB.prepare(
          "UPDATE commands SET cafe_id=?,result_json=? WHERE id=?",
        ).bind(p.cafeId, JSON.stringify(p.result), id),
        env.DB.prepare(
          "INSERT INTO audit_logs(id,cafe_id,actor_id,operation_id,target,action,summary_json) VALUES (?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          p.cafeId,
          actor.userId,
          id,
          p.target,
          p.action,
          "{}",
        ),
        env.DB.prepare(
          "UPDATE cafes SET revision=revision+1,updated_at=? WHERE id=?",
        ).bind(new Date().toISOString(), p.cafeId),
      ],
      ids,
    );
    return p.result;
  } catch (error) {
    await authorize();
    const row = await lookup();
    if (row) return replay(row);
    if (
      error instanceof Error &&
      /CHECK|UNIQUE|payroll_period_overlap/.test(error.message)
    )
      fail(409, "VERSION_CONFLICT");
    throw error;
  }
}
