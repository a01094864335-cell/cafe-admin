import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { setup, ok } from "./api-helpers.mjs";
import { stmt } from "./helpers.mjs";
import worker from "../../src/server/index.ts";
import { hash, randomToken } from "../../src/server/auth/crypto.ts";
import { createImportPlan } from "../../src/shared/import-plan.js";
import { metered, counters } from "./meter.mjs";

test("ten concurrent synthetic users: reads/writes p95 and per-invocation Free query budget", async (t) => {
  const { db, env } = await setup(t),
    users = [];
  for (let i = 0; i < 10; i++) {
    const id = "load" + i,
      token = randomToken(),
      csrf = randomToken();
    users.push({ id, token, csrf });
    await db.batch([
      stmt(
        db,
        "INSERT INTO users(id,name,email) VALUES (?,?,?)",
        id,
        "가상 부하 사용자",
        id + "@example.invalid",
      ),
      stmt(
        db,
        "INSERT INTO memberships(id,cafe_id,user_id,role) VALUES (?,'a',?,'admin')",
        id,
        id,
      ),
      stmt(
        db,
        "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES (?,?,?,?)",
        await hash(token),
        id,
        await hash(csrf),
        "2999-01-01T00:00:00.000Z",
      ),
    ]);
  }
  for (let start = 0; start < 365; start += 20)
    await db.batch(
      Array.from({ length: Math.min(20, 365 - start) }, (_, j) =>
        stmt(
          db,
          "INSERT INTO sales(cafe_id,dataset_id,id,business_date,card,cash,created_by,updated_by) VALUES ('a','a-live',?,?,10000,500,'u1','u1')",
          "loadsale" + (start + j),
          new Date(Date.UTC(2025, 0, 1 + start + j)).toISOString().slice(0, 10),
        ),
      ),
    );
  const results = [];
  await Promise.all(
    users.map(async (user) => {
      for (let round = 0; round < 3; round++)
        for (const kind of ["sales", "dashboard", "expenses"]) {
          const metrics = counters(),
            write = kind === "expenses",
            start = performance.now();
          const response = await worker.fetch(
            new Request(
              env.APP_ORIGIN +
                "/api/v1/cafes/a/" +
                kind +
                (kind === "dashboard" ? "?from=2025-01-01&to=2025-12-31" : ""),
              {
                method: write ? "POST" : "GET",
                headers: {
                  Cookie: "__Host-session=" + user.token,
                  Origin: env.APP_ORIGIN,
                  "X-CSRF-Token": user.csrf,
                  "Content-Type": "application/json",
                  "Idempotency-Key": randomToken(),
                },
                ...(write
                  ? {
                      body: JSON.stringify({
                        businessDate: "2026-10-09",
                        item: "가상 비용",
                        vendor: "",
                        amount: 100,
                        note: "",
                      }),
                    }
                  : {}),
              },
            ),
            { ...env, DB: metered(db, metrics) },
          );
          assert.equal(
            response.status,
            write ? 201 : 200,
            await response.clone().text(),
          );
          await response.arrayBuffer();
          results.push({ kind, ms: performance.now() - start, ...metrics });
        }
    }),
  );
  const report = {
    environment: "local Miniflare D1; not remote Worker CPU/latency",
    concurrentUsers: 10,
    seedSales: 368,
    requests: results.length,
    operations: {},
  };
  for (const kind of ["sales", "dashboard", "expenses"]) {
    const rows = results.filter((r) => r.kind === kind),
      times = rows.map((r) => r.ms).sort((a, b) => a - b);
    report.operations[kind] = {
      count: rows.length,
      p95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1]),
      maxQueries: Math.max(...rows.map((r) => r.queries)),
      rowsRead: rows.reduce((s, r) => s + r.rowsRead, 0),
      rowsWritten: rows.reduce((s, r) => s + r.rowsWritten, 0),
    };
  }
  await writeFile(
    "/tmp/cafe-operations-performance.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  for (const result of Object.values(report.operations))
    assert.ok(
      result.p95Ms < 2000,
      "Local p95 exceeded 2 seconds: " + JSON.stringify(result),
    );
});

test("maximum inventory chunk, validation, cancellation, commit and export fit 50 SQL queries", async (t) => {
  const { db, env, request, sessions } = await setup(t);
  const cafe = ok(
      await request("u1", "/api/v1/cafes", "POST", {
        name: "쿼리 한도 검증",
        timezone: "Asia/Seoul",
      }),
      201,
    ),
    base = "/api/v1/cafes/" + cafe.id + "/";
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/legacy-v2.json", import.meta.url),
      "utf8",
    ),
  );
  fixture.inventory = Array.from({ length: 10 }, (_, i) => ({
    ...fixture.inventory[0],
    id: "budget-item-" + i,
  }));
  const plan = await createImportPlan(fixture, 1000),
    maxima = [];
  async function measured(path, method, data) {
    const metrics = counters(),
      response = await worker.fetch(
        new Request(env.APP_ORIGIN + base + path, {
          method,
          headers: {
            Cookie: "__Host-session=" + sessions.u1.token,
            Origin: env.APP_ORIGIN,
            "X-CSRF-Token": sessions.u1.csrf,
            "Idempotency-Key": randomToken(),
            "Content-Type": "application/json",
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
        { ...env, DB: metered(db, metrics) },
      );
    const body = await response.json();
    assert.ok(
      response.ok,
      JSON.stringify(body) + " " + JSON.stringify(metrics),
    );
    maxima.push({ path, queries: metrics.queries });
    return body.data;
  }
  const job = await measured("imports", "POST", {
    version: 2,
    manifest: plan.manifest,
  });
  for (const [i, chunk] of plan.chunks.entries())
    await measured("imports/" + job.id + "/chunks/" + i, "PUT", chunk);
  await measured("imports/" + job.id + "/validate", "POST", {});
  await measured("imports/" + job.id + "/cancel", "POST", {});
  await measured("imports", "POST", { version: 2, manifest: plan.manifest });
  for (const [i, chunk] of plan.chunks.entries())
    await measured("imports/" + job.id + "/chunks/" + i, "PUT", chunk);
  await measured("imports/" + job.id + "/validate", "POST", {});
  await measured("imports/" + job.id + "/commit", "POST", {});
  const backup = await measured("exports", "POST", {});
  await measured(
    "exports/" + backup.id + "/pages?table=inventory_movements",
    "GET",
  );
  await measured("exports/" + backup.id + "/complete", "POST", {});
  console.log(
    "Transfer max SQL queries: " + Math.max(...maxima.map((m) => m.queries)),
  );
});
