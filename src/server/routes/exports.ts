import type { Env } from "../env.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json } from "../http.ts";
import { membership, memberGuard } from "../services/memberships.ts";
import { command, assertion } from "../services/commands.ts";
import { ledgerScope } from "../repositories/scope.ts";
import { dataTables } from "../repositories/import-records.ts";
import {
  expireExports,
  summaryQueries,
  summaryResults,
  backupRow,
} from "../repositories/transfer.ts";
type Job = {
  id: string;
  cafe_id: string;
  dataset_id: string;
  owner_id: string;
  revision: number;
  state: string;
  expires_at: string;
  snapshot_json: string;
};
const ttl = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
export async function exportRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = url.pathname.match(
      /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/exports(?:\/([A-Za-z0-9_-]+)(?:\/(pages|complete|cancel))?)?$/,
    );
  if (!match) return null;
  const [, cafeId, jobId, action] = match,
    method = request.method;
  if (
    !jobId
      ? !["POST", "GET"].includes(method)
      : !action || action === "pages"
        ? method !== "GET"
        : method !== "POST"
  )
    return null;
  const actor = await authenticate(request, env);
  await membership(env, actor, cafeId, ["owner"]);
  if (method === "POST") await csrf(request, env, actor);
  await expireExports(env, cafeId);
  if (!jobId && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id,state,expires_at expiresAt FROM export_jobs WHERE cafe_id=? AND owner_id=? AND state='running'",
    )
      .bind(cafeId, actor.userId)
      .all();
    return json(rows.results, requestId);
  }
  const load = async () => {
    const job = await env.DB.prepare(
      "SELECT * FROM export_jobs WHERE cafe_id=? AND id=?",
    )
      .bind(cafeId, jobId)
      .first<Job>();
    if (!job || job.owner_id !== actor.userId) fail(404, "NOT_FOUND");
    return job;
  };
  // This predicate is checked inside each data-reading transaction, not only
  // before it. A concurrent ownership change cannot release a stale page.
  const gate = (job: Job) =>
    env.DB.prepare(
      `SELECT 1 valid FROM export_jobs j JOIN cafes c ON c.id=j.cafe_id JOIN memberships m ON m.cafe_id=c.id AND m.user_id=? JOIN sessions s ON s.user_id=m.user_id AND s.token_hash=? WHERE j.cafe_id=? AND j.id=? AND j.owner_id=? AND j.state='running' AND j.expires_at>? AND c.write_mode='export' AND c.active_dataset_id=j.dataset_id AND c.revision=j.revision AND m.status='active' AND m.role='owner' AND s.revoked_at IS NULL AND s.expires_at>?`,
    ).bind(
      actor.userId,
      actor.sessionHash,
      cafeId,
      job.id,
      actor.userId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  if (!jobId) {
    const input = await body(request);
    fields(input, []);
    const result = await command(
      env,
      actor,
      request,
      {},
      async () => {
        await membership(env, actor, cafeId, ["owner"]);
      },
      async () => {
        const scope = await ledgerScope(env, actor, cafeId, true, ["owner"]);
        const results = await env.DB.batch<Record<string, unknown>>([
          env.DB.prepare(
            "SELECT c.name,c.timezone,d.metadata_json FROM cafes c JOIN datasets d ON d.cafe_id=c.id AND d.id=c.active_dataset_id WHERE c.id=? AND c.active_dataset_id=?",
          ).bind(cafeId, scope.datasetId),
          ...summaryQueries(env, cafeId, scope.datasetId),
        ]);
        const meta = results[0].results[0] as {
          name: string;
          timezone: string;
          metadata_json: string;
        };
        if (!meta) fail(409, "VERSION_CONFLICT");
        const id = crypto.randomUUID(),
          expiresAt = ttl(),
          ids: string[] = [];
        const snapshot = {
          version: 3,
          format: "cafe-admin-cloud",
          exportedAt: new Date().toISOString(),
          cafe: { name: meta.name, timezone: meta.timezone },
          metadata: JSON.parse(meta.metadata_json),
          summary: summaryResults(results.slice(1)),
          tables: [...dataTables],
        };
        return {
          cafeId,
          assertionIds: ids,
          target: id,
          action: "export.create",
          result: { id, expiresAt },
          statements: [
            memberGuard(env, ids, actor, cafeId, ["owner"], true),
            assertion(
              env,
              ids,
              "EXISTS(SELECT 1 FROM cafes WHERE id=? AND active_dataset_id=? AND revision=? AND write_mode='open')",
              cafeId,
              scope.datasetId,
              scope.revision,
            ),
            env.DB.prepare(
              "INSERT INTO export_jobs(cafe_id,id,dataset_id,revision,owner_id,expires_at,state,snapshot_json) VALUES (?,?,?,?,?,?,'running',?)",
            ).bind(
              cafeId,
              id,
              scope.datasetId,
              scope.revision + 1,
              actor.userId,
              expiresAt,
              JSON.stringify(snapshot),
            ),
            env.DB.prepare(
              "UPDATE cafes SET write_mode='export' WHERE id=?",
            ).bind(cafeId),
          ],
        };
      },
    );
    return json(result, requestId, 201);
  }
  const job = await load();
  if (method === "GET") {
    if (!action) {
      if (job.state !== "running")
        return json(
          { id: job.id, state: job.state, expiresAt: job.expires_at },
          requestId,
        );
      const expiresAt = ttl();
      // Heartbeat extends this job only while the same owner/revision is valid.
      const results = await env.DB.batch<Record<string, unknown>>([
        gate(job),
        env.DB.prepare(
          `UPDATE export_jobs SET expires_at=? WHERE cafe_id=? AND id=? AND state='running' AND expires_at>? AND EXISTS(SELECT 1 FROM cafes c JOIN memberships m ON m.cafe_id=c.id JOIN sessions s ON s.user_id=m.user_id WHERE c.id=? AND c.write_mode='export' AND c.active_dataset_id=? AND c.revision=? AND m.user_id=? AND m.status='active' AND m.role='owner' AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?)`,
        ).bind(
          expiresAt,
          cafeId,
          job.id,
          new Date().toISOString(),
          cafeId,
          job.dataset_id,
          job.revision,
          actor.userId,
          actor.sessionHash,
          new Date().toISOString(),
        ),
      ]);
      if (!results[0].results.length) fail(409, "EXPORT_EXPIRED_OR_CHANGED");
      return json(
        {
          id: job.id,
          state: job.state,
          expiresAt,
          ...JSON.parse(job.snapshot_json),
        },
        requestId,
      );
    }
    const table = url.searchParams.get("table");
    if (
      !dataTables.includes(table as any) ||
      [...url.searchParams.keys()].some(
        (k) => !["table", "cursor"].includes(k),
      ) ||
      url.searchParams.getAll("table").length !== 1 ||
      url.searchParams.getAll("cursor").length > 1
    )
      fail(400, "VALIDATION_ERROR");
    const rates = table === "payroll_rates",
      binding = JSON.stringify([
        cafeId,
        job.id,
        job.dataset_id,
        actor.userId,
        table,
      ]);
    let lastId = "",
      lastYear = 0;
    if (url.searchParams.has("cursor")) {
      try {
        const c = JSON.parse(atob(url.searchParams.get("cursor")!));
        if (
          c.binding !== binding ||
          typeof c.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(c.id) ||
          !Number.isInteger(c.year)
        )
          fail(400, "VALIDATION_ERROR");
        lastId = c.id;
        lastYear = c.year;
      } catch {
        fail(400, "VALIDATION_ERROR");
      }
    }
    const query = rates
      ? env.DB.prepare(
          `SELECT * FROM payroll_rates WHERE cafe_id=? AND dataset_id=? AND (settings_id>? OR (settings_id=? AND year>?)) ORDER BY settings_id,year LIMIT 51`,
        ).bind(cafeId, job.dataset_id, lastId, lastId, lastYear)
      : env.DB.prepare(
          `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=? AND id>? ORDER BY id LIMIT 51`,
        ).bind(cafeId, job.dataset_id, lastId);
    const results = await env.DB.batch<Record<string, unknown>>([
      gate(job),
      query,
    ]);
    if (!results[0].results.length) fail(409, "EXPORT_EXPIRED_OR_CHANGED");
    const rows = results[1].results.slice(0, 50),
      last = rows.at(-1);
    return Response.json(
      {
        data: rows.map(backupRow),
        nextCursor:
          results[1].results.length > 50
            ? btoa(
                JSON.stringify({
                  binding,
                  id: rates ? last!.settings_id : last!.id,
                  year: rates ? last!.year : 0,
                }),
              )
            : null,
        requestId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const input = await body(request);
  fields(input, []);
  const result = await command(
    env,
    actor,
    request,
    {},
    async () => {
      await membership(env, actor, cafeId, ["owner"]);
      await load();
    },
    async () => {
      const ids: string[] = [],
        state = action === "complete" ? "complete" : "cancelled",
        statements = [memberGuard(env, ids, actor, cafeId, ["owner"])];
      if (job.state === state)
        return {
          cafeId,
          assertionIds: ids,
          target: job.id,
          action: "export." + action + ".replay",
          result: { id: job.id, state },
          statements,
        };
      if (action === "complete") {
        if (!(await gate(job).first())) fail(409, "EXPORT_EXPIRED_OR_CHANGED");
        statements.push(
          assertion(
            env,
            ids,
            "EXISTS(SELECT 1 FROM export_jobs j JOIN cafes c ON c.id=j.cafe_id WHERE j.cafe_id=? AND j.id=? AND j.owner_id=? AND j.state='running' AND j.expires_at>? AND c.active_dataset_id=j.dataset_id AND c.write_mode='export' AND c.revision=j.revision)",
            cafeId,
            job.id,
            actor.userId,
            new Date().toISOString(),
          ),
        );
      } else if (job.state !== "running") fail(409, "EXPORT_NOT_RUNNING");
      statements.push(
        env.DB.prepare(
          "UPDATE export_jobs SET state=? WHERE cafe_id=? AND id=? AND state='running'",
        ).bind(state, cafeId, job.id),
        env.DB.prepare(
          "UPDATE cafes SET write_mode='open' WHERE id=? AND write_mode='export' AND NOT EXISTS(SELECT 1 FROM export_jobs WHERE cafe_id=? AND state='running')",
        ).bind(cafeId, cafeId),
      );
      return {
        cafeId,
        assertionIds: ids,
        target: job.id,
        action: "export." + action,
        result: { id: job.id, state },
        statements,
      };
    },
  );
  return json(result, requestId);
}
