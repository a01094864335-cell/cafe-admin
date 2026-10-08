import { stockInput, purchaseStock } from "../repositories/purchase-stock.ts";
import type { Env } from "../env.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json, version, HttpError } from "../http.ts";
import { command, changed } from "../services/commands.ts";
import { ledgerScope, scopeGuards } from "../repositories/scope.ts";
import {
  ledgerTables,
  ledgerValues,
  record,
  dto,
  listLedger,
} from "../repositories/ledger.ts";
import type { Ledger } from "../repositories/ledger.ts";
export async function ledgerRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/(sales|purchases|expenses|other-incomes)(?:\/([A-Za-z0-9_-]+))?$/,
  );
  if (!match) return null;
  const [, cafeId, resource, id] = match,
    kind = resource as Ledger;
  if (
    !(id ? ["GET", "PATCH", "DELETE"] : ["GET", "POST"]).includes(
      request.method,
    )
  )
    return null;
  const actor = await authenticate(request, env),
    writing = request.method !== "GET";
  const scope = await ledgerScope(env, actor, cafeId, writing);
  if (!writing)
    return id
      ? json(dto(await record(env, scope, kind, id)), requestId)
      : listLedger(env, scope, kind, request, actor.userId, requestId);
  await csrf(request, env, actor);
  const input = await body(request),
    deleting = request.method === "DELETE";
  fields(
    input,
    deleting
      ? ["expectedVersion"]
      : [
          "businessDate",
          ...(kind === "sales"
            ? ["card", "cash", "transfer"]
            : ["item", "vendor", "amount"]),
          "note",
          ...(kind === "purchases" ? ["stock"] : []),
          ...(id ? ["expectedVersion"] : []),
        ],
  );
  const stock = kind === "purchases" ? stockInput(input.stock) : undefined;
  const expected = id ? version(input.expectedVersion) : null,
    values = deleting ? {} : ledgerValues(kind, input, !!id);
  if (
    id &&
    !deleting &&
    Object.keys(values).length === 0 &&
    stock === undefined
  )
    fail(400, "VALIDATION_ERROR");
  const authorize = async () => {
    const current = await ledgerScope(env, actor, cafeId, true);
    if (current.datasetId !== scope.datasetId) fail(409, "VERSION_CONFLICT");
    if (id) await record(env, scope, kind, id, deleting);
  };
  try {
    const result = (await command(
      env,
      actor,
      request,
      {
        values,
        expectedVersion: expected,
        ...(stock !== undefined ? { stock } : {}),
      },
      authorize,
      async (operation) => {
        const target = id ?? crypto.randomUUID(),
          ids: string[] = [],
          columns = Object.keys(values),
          now = new Date().toISOString();
        const statements = scopeGuards(env, actor, scope, ids);
        if (!id)
          statements.push(
            env.DB.prepare(
              `INSERT INTO ${ledgerTables[kind]}(cafe_id,dataset_id,id,created_by,updated_by,${columns.join(",")}) VALUES (${Array(
                columns.length + 5,
              )
                .fill("?")
                .join(",")})`,
            ).bind(
              cafeId,
              scope.datasetId,
              target,
              actor.userId,
              actor.userId,
              ...Object.values(values),
            ),
          );
        else
          statements.push(
            env.DB.prepare(
              `UPDATE ${ledgerTables[kind]} SET ${deleting ? "deleted_at=?" : columns.length ? columns.map((c) => c + "=?").join(",") : "id=id"},version=version+1,updated_by=?,updated_at=? WHERE cafe_id=? AND dataset_id=? AND id=? AND version=? AND deleted_at IS NULL`,
            ).bind(
              ...(deleting ? [now] : Object.values(values)),
              actor.userId,
              now,
              cafeId,
              scope.datasetId,
              target,
              expected,
            ),
            changed(env, ids),
          );
        if (kind === "purchases")
          statements.push(
            ...(await purchaseStock(
              env,
              scope,
              actor,
              operation,
              target,
              stock,
              deleting,
              ids,
            )),
          );
        return {
          cafeId,
          bindCafeBeforeWrite: true,
          statements,
          assertionIds: ids,
          target,
          action:
            kind + "." + (id ? (deleting ? "delete" : "update") : "create"),
          result: {
            id: target,
            datasetId: scope.datasetId,
            version: (expected ?? 0) + 1,
          },
        };
      },
    )) as { id: string; datasetId: string; version: number };
    if (result.datasetId !== scope.datasetId) fail(404, "NOT_FOUND");
    return json(
      deleting
        ? { id: result.id, deleted: true, version: result.version }
        : dto(await record(env, scope, kind, result.id)),
      requestId,
      id ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof HttpError && error.code === "VERSION_CONFLICT" && id) {
      const current = await ledgerScope(env, actor, cafeId);
      if (current.datasetId !== scope.datasetId) throw error;
      const latest = await record(env, scope, kind, id, deleting);
      error.details = {
        latest: latest.deleted_at
          ? { id, deleted: true, version: latest.version }
          : dto(latest),
      };
    }
    throw error;
  }
}
