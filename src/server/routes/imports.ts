import type { Env } from "../env.ts";
import { authenticate, csrf } from "../auth/session.ts";
import { body, fields, fail, json } from "../http.ts";
import { membership, memberGuard } from "../services/memberships.ts";
import { command, assertion, changed } from "../services/commands.ts";
import { digest, importKinds } from "../../shared/import-plan.js";
import {
  dataTables,
  deleteOrder,
  emptyPredicate,
  importRecords,
} from "../repositories/import-records.ts";
import { expireExports, summaryResults } from "../repositories/transfer.ts";
type Job = {
  id: string;
  cafe_id: string;
  dataset_id: string;
  owner_id: string;
  state: string;
  expected_chunks: number;
  validated_revision: number | null;
  summary_json: string | null;
  manifest_json: string;
};
export async function importRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/imports(?:\/([A-Za-z0-9_-]+)(?:\/(validate|commit|cancel)|\/chunks\/(\d+))?)?$/,
  );
  if (!m) return null;
  const [, cafeId, jobId, action, chunkNo] = m,
    method = request.method;
  if (
    !jobId
      ? !["POST", "GET"].includes(method)
      : chunkNo !== undefined
        ? method !== "PUT"
        : action
          ? method !== "POST"
          : method !== "GET"
  )
    return null;
  const actor = await authenticate(request, env);
  await membership(env, actor, cafeId, ["owner"]);
  async function load() {
    const job = await env.DB.prepare(
      "SELECT * FROM import_jobs WHERE cafe_id=? AND id=?",
    )
      .bind(cafeId, jobId)
      .first<Job>();
    if (!job || job.owner_id !== actor.userId) fail(404, "NOT_FOUND");
    return job;
  }
  async function summary(job: Job) {
    const chunks = await env.DB.prepare(
      "SELECT chunk_no FROM import_chunks WHERE cafe_id=? AND job_id=? ORDER BY chunk_no",
    )
      .bind(cafeId, job.id)
      .all<{ chunk_no: number }>();
    return {
      id: job.id,
      state: job.state,
      expectedChunks: job.expected_chunks,
      receivedChunks: chunks.results.map((r) => r.chunk_no),
      summary: job.summary_json ? JSON.parse(job.summary_json) : null,
    };
  }
  if (method === "GET") {
    if (!jobId) {
      const jobs = await env.DB.prepare(
        "SELECT * FROM import_jobs WHERE cafe_id=? AND owner_id=? AND state IN ('uploading','validating','ready','failed') ORDER BY created_at DESC LIMIT 20",
      )
        .bind(cafeId, actor.userId)
        .all<Job>();
      return json(await Promise.all(jobs.results.map(summary)), requestId);
    }
    return json(await summary(await load()), requestId);
  }
  await csrf(request, env, actor);
  if (!jobId) await expireExports(env, cafeId);
  const input = await body(
    request,
    !jobId ? 4 * 1024 * 1024 : chunkNo !== undefined ? 128 * 1024 : 16384,
  );
  if (!jobId) {
    fields(input, ["version", "manifest"]);
    if (
      input.version !== 2 ||
      !Array.isArray(input.manifest) ||
      !input.manifest.length ||
      input.manifest.length > 30000
    )
      fail(400, "INVALID_BACKUP");
    const manifest = input.manifest as {
      kind: string;
      hash: string;
      bytes: number;
      count: number;
    }[];
    let total = 0,
      previous = -1;
    for (const [i, c] of manifest.entries()) {
      if (!c || typeof c !== "object") fail(400, "VALIDATION_ERROR");
      fields(c, ["kind", "hash", "bytes", "count"]);
      const index = importKinds.indexOf(c.kind);
      if (
        index < 0 ||
        index < previous ||
        !Number.isInteger(c.count) ||
        c.count < 1 ||
        c.count > 10 ||
        !Number.isInteger(c.bytes) ||
        c.bytes < 1 ||
        c.bytes > 128 * 1024 ||
        !/^[A-Za-z0-9_-]{43}$/.test(c.hash) ||
        (i === 0) !== (c.kind === "meta") ||
        (i === 0 && c.count !== 1)
      )
        fail(400, "VALIDATION_ERROR");
      previous = index;
      total += c.bytes;
    }
    if (total > 20 * 1024 * 1024) fail(413, "PAYLOAD_TOO_LARGE");
    const fileHash = await digest({ version: 2, manifest });
    const authorize = async () => {
      await membership(env, actor, cafeId, ["owner"]);
    };
    const result = (await command(
      env,
      actor,
      request,
      { version: 2, manifest },
      authorize,
      async () => {
        const old = await env.DB.prepare(
          "SELECT * FROM import_jobs WHERE cafe_id=? AND file_hash=?",
        )
          .bind(cafeId, fileHash)
          .first<Job>();
        if (old && old.owner_id !== actor.userId)
          fail(409, "IMPORT_ALREADY_EXISTS");
        if (old && !["cancelled", "failed"].includes(old.state)) {
          const ids: string[] = [];
          return {
            cafeId,
            statements: [memberGuard(env, ids, actor, cafeId, ["owner"])],
            assertionIds: ids,
            target: old.id,
            action: "import.resume",
            result: { id: old.id },
          };
        }
        const id = old?.id ?? crypto.randomUUID(),
          dataset = old?.dataset_id ?? crypto.randomUUID(),
          ids: string[] = [],
          statements = [
            memberGuard(env, ids, actor, cafeId, ["owner"]),
            assertion(
              env,
              ids,
              `EXISTS(SELECT 1 FROM cafes c WHERE c.id=? AND c.write_mode='open' AND ${emptyPredicate()})`,
              cafeId,
            ),
          ];
        if (!old)
          statements.push(
            env.DB.prepare(
              "INSERT INTO datasets(cafe_id,id,state,metadata_json) VALUES (?,?,'staging','{}')",
            ).bind(cafeId, dataset),
            env.DB.prepare(
              "INSERT INTO import_jobs(cafe_id,id,dataset_id,owner_id,file_hash,state,expected_chunks,manifest_json) VALUES (?,?,?,?,?,'uploading',?,?)",
            ).bind(
              cafeId,
              id,
              dataset,
              actor.userId,
              fileHash,
              manifest.length,
              JSON.stringify(manifest),
            ),
          );
        else
          statements.push(
            env.DB.prepare(
              "UPDATE import_jobs SET state='uploading',validated_revision=NULL,summary_json=NULL WHERE cafe_id=? AND id=?",
            ).bind(cafeId, id),
          );
        statements.push(
          env.DB.prepare(
            "UPDATE cafes SET write_mode='import' WHERE id=?",
          ).bind(cafeId),
        );
        return {
          cafeId,
          statements,
          assertionIds: ids,
          target: id,
          action: "import.create",
          result: { id },
        };
      },
    )) as { id: string };
    return json(result, requestId, 201);
  }
  const job = await load(),
    authorize = async () => {
      await membership(env, actor, cafeId, ["owner"]);
      await load();
    };
  if (chunkNo !== undefined) {
    fields(input, ["kind", "rows"]);
    const no = Number(chunkNo),
      manifest = JSON.parse(job.manifest_json),
      expected = manifest[no];
    if (
      !Number.isSafeInteger(no) ||
      !expected ||
      input.kind !== expected.kind ||
      !Array.isArray(input.rows) ||
      input.rows.length !== expected.count ||
      new TextEncoder().encode(JSON.stringify(input)).length !==
        expected.bytes ||
      (await digest(input)) !== expected.hash
    )
      fail(400, "IMPORT_CHUNK_MISMATCH");
    const result = await command(
      env,
      actor,
      request,
      input,
      authorize,
      async (operation) => {
        const existing = await env.DB.prepare(
          "SELECT payload_hash FROM import_chunks WHERE cafe_id=? AND job_id=? AND chunk_no=?",
        )
          .bind(cafeId, jobId, no)
          .first<{ payload_hash: string }>();
        const ids: string[] = [],
          statements = [memberGuard(env, ids, actor, cafeId, ["owner"])];
        if (existing) {
          if (existing.payload_hash !== expected.hash)
            fail(409, "IDEMPOTENCY_MISMATCH");
          return {
            cafeId,
            statements,
            assertionIds: ids,
            target: jobId,
            action: "import.chunk.replay",
            result: { chunkNo: no },
          };
        }
        statements.push(
          assertion(
            env,
            ids,
            "EXISTS(SELECT 1 FROM import_jobs j JOIN cafes c ON c.id=j.cafe_id JOIN datasets d ON d.cafe_id=j.cafe_id AND d.id=j.dataset_id WHERE j.cafe_id=? AND j.id=? AND j.state='uploading' AND d.state='staging' AND c.write_mode='import')",
            cafeId,
            jobId,
          ),
        );
        const metadata = await env.DB.prepare(
          "SELECT metadata_json FROM datasets WHERE cafe_id=? AND id=?",
        )
          .bind(cafeId, job.dataset_id)
          .first<{ metadata_json: string }>();
        statements.push(
          ...(await importRecords(
            env,
            cafeId,
            job.dataset_id,
            jobId,
            actor.userId,
            operation,
            String(input.kind),
            input.rows as any[],
            JSON.parse(metadata?.metadata_json ?? "{}"),
          )),
          env.DB.prepare(
            "INSERT INTO import_chunks(cafe_id,job_id,chunk_no,payload_hash,row_count) VALUES (?,?,?,?,?)",
          ).bind(cafeId, jobId, no, expected.hash, expected.count),
        );
        return {
          cafeId,
          bindCafeBeforeWrite: true,
          statements,
          assertionIds: ids,
          target: jobId,
          action: "import.chunk",
          result: { chunkNo: no },
        };
      },
    );
    return json(result, requestId);
  }
  fields(input, []);
  const result = await command(env, actor, request, {}, authorize, async () => {
    const ids: string[] = [],
      statements = [memberGuard(env, ids, actor, cafeId, ["owner"])];
    if (action === "commit" && job.state === "committed")
      return {
        cafeId,
        statements,
        assertionIds: ids,
        target: jobId,
        action: "import.commit.replay",
        result: { id: jobId, state: "committed" },
      };
    if (action === "cancel" && job.state === "cancelled")
      return {
        cafeId,
        statements,
        assertionIds: ids,
        target: jobId,
        action: "import.cancel.replay",
        result: { id: jobId, state: "cancelled" },
      };
    statements.push(
      assertion(
        env,
        ids,
        "EXISTS(SELECT 1 FROM import_jobs j JOIN cafes c ON c.id=j.cafe_id JOIN datasets d ON d.cafe_id=j.cafe_id AND d.id=j.dataset_id WHERE j.cafe_id=? AND j.id=? AND j.state IN ('uploading','validating','ready','failed') AND c.write_mode='import' AND d.state='staging')",
        cafeId,
        jobId,
      ),
    );
    if (action === "validate") {
      const received = await env.DB.prepare(
        "SELECT count(*) n FROM import_chunks WHERE cafe_id=? AND job_id=?",
      )
        .bind(cafeId, jobId)
        .first<{ n: number }>();
      if (received?.n !== job.expected_chunks) fail(409, "IMPORT_INCOMPLETE");
      statements.push(
        assertion(
          env,
          ids,
          "(SELECT count(*) FROM import_chunks WHERE cafe_id=? AND job_id=?)=?",
          cafeId,
          jobId,
          job.expected_chunks,
        ),
      );
      const queries = dataTables.map((table) =>
        env.DB.prepare(
          `SELECT count(*) count ${["sales", "purchases", "expenses", "other_incomes", "payroll_extras", "sales_reconciliations", "inventory_items"].includes(table) ? `,coalesce(sum(${table === "sales" ? "coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0)" : table === "sales_reconciliations" ? "reported" : table === "inventory_items" ? "quantity_hundredths" : "amount"}),0) total` : ""} FROM ${table} WHERE cafe_id=? AND dataset_id=?`,
        ).bind(cafeId, job.dataset_id),
      );
      const sums = await env.DB.batch<Record<string, unknown>>(queries),
        counts = summaryResults(sums);
      const metadata = await env.DB.prepare(
        "SELECT metadata_json FROM datasets WHERE cafe_id=? AND id=?",
      )
        .bind(cafeId, job.dataset_id)
        .first<{ metadata_json: string }>();
      const meta = JSON.parse(metadata?.metadata_json ?? "{}");
      if (
        !meta.employment ||
        Number((counts.payroll_rates as any).count) !==
          Object.keys(meta.employment.rates).length
      )
        fail(409, "IMPORT_INCOMPLETE");
      statements.push(
        env.DB.prepare(
          "UPDATE import_jobs SET state='ready',summary_json=?,validated_revision=(SELECT revision+1 FROM cafes WHERE id=?) WHERE cafe_id=? AND id=?",
        ).bind(JSON.stringify(counts), cafeId, cafeId, jobId),
      );
    } else if (action === "commit") {
      statements.push(
        assertion(
          env,
          ids,
          "EXISTS(SELECT 1 FROM import_jobs j JOIN cafes c ON c.id=j.cafe_id WHERE j.cafe_id=? AND j.id=? AND j.state='ready' AND j.validated_revision=c.revision)",
          cafeId,
          jobId,
        ),
        assertion(
          env,
          ids,
          `EXISTS(SELECT 1 FROM cafes c WHERE c.id=? AND ${emptyPredicate()})`,
          cafeId,
        ),
        env.DB.prepare(
          "UPDATE datasets SET state='retired' WHERE cafe_id=? AND id=(SELECT active_dataset_id FROM cafes WHERE id=?)",
        ).bind(cafeId, cafeId),
        env.DB.prepare(
          "UPDATE datasets SET state='active' WHERE cafe_id=? AND id=? AND state='staging'",
        ).bind(cafeId, job.dataset_id),
        changed(env, ids),
        env.DB.prepare(
          "UPDATE cafes SET active_dataset_id=?,write_mode='open' WHERE id=?",
        ).bind(job.dataset_id, cafeId),
        env.DB.prepare(
          "UPDATE import_jobs SET state='committed' WHERE cafe_id=? AND id=?",
        ).bind(cafeId, jobId),
      );
    } else if (action === "cancel") {
      for (const table of deleteOrder)
        statements.push(
          env.DB.prepare(
            `DELETE FROM ${table} WHERE cafe_id=? AND dataset_id=?`,
          ).bind(cafeId, job.dataset_id),
        );
      statements.push(
        env.DB.prepare(
          "DELETE FROM import_chunks WHERE cafe_id=? AND job_id=?",
        ).bind(cafeId, jobId),
        env.DB.prepare(
          "DELETE FROM import_source_ids WHERE cafe_id=? AND job_id=?",
        ).bind(cafeId, jobId),
        env.DB.prepare(
          "UPDATE datasets SET metadata_json='{}' WHERE cafe_id=? AND id=?",
        ).bind(cafeId, job.dataset_id),
        env.DB.prepare(
          "UPDATE import_jobs SET state='cancelled',summary_json=NULL,validated_revision=NULL WHERE cafe_id=? AND id=?",
        ).bind(cafeId, jobId),
        env.DB.prepare("UPDATE cafes SET write_mode='open' WHERE id=?").bind(
          cafeId,
        ),
      );
    }
    return {
      cafeId,
      statements,
      assertionIds: ids,
      target: jobId,
      action: "import." + action,
      result: {
        id: jobId,
        state:
          action === "validate"
            ? "ready"
            : action === "commit"
              ? "committed"
              : "cancelled",
      },
    };
  });
  return json(result, requestId);
}
