import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setup, ok } from "./api-helpers.mjs";
import { scalar, stmt } from "./helpers.mjs";
import { createImportPlan, digest } from "../../src/shared/import-plan.js";
import { createCalculations } from "../../src/shared/calculations/ledger.js";
import { randomToken } from "../../src/server/auth/crypto.ts";
test("missing hours and break inputs remain missing, including payroll calculation", async (t) => {
  const f = await fixture();
  f.employment.weeklyHours = null;
  f.payroll[0].breakMinutes = null;
  const { request, base, plan } = await prepare(t, f);
  const job = ok(
    await request("u1", base + "imports", "POST", {
      version: 2,
      manifest: plan.manifest,
    }),
    201,
  );
  for (const [i, chunk] of plan.chunks.entries())
    ok(
      await request(
        "u1",
        base + "imports/" + job.id + "/chunks/" + i,
        "PUT",
        chunk,
      ),
    );
  ok(await request("u1", base + "imports/" + job.id + "/validate", "POST", {}));
  ok(await request("u1", base + "imports/" + job.id + "/commit", "POST", {}));
  const employee = ok(await request("u1", base + "employees"))[0];
  assert.equal(
    ok(
      await request(
        "u1",
        base + "employees/" + employee.id + "/payroll-settings",
      ),
    )[0].weeklyHours,
    null,
  );
  assert.equal(
    ok(await request("u1", base + "work-logs?employeeId=" + employee.id))[0]
      .breakMinutes,
    null,
  );
  const dashboard = ok(
      await request("u1", base + "dashboard?from=2026-10-01&to=2026-10-31"),
    ),
    expected = createCalculations(f, "2026-10-01", "2026-10-31").metrics();
  assert.equal(dashboard.wages, expected.wages);
  assert.equal(dashboard.pending, expected.pending);
});
async function fixture() {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/legacy-v2.json", import.meta.url),
      "utf8",
    ),
  );
}
async function prepare(t, value) {
  const h = await setup(t),
    cafe = ok(
      await h.request("u1", "/api/v1/cafes", "POST", {
        name: "이전 대상",
        timezone: "Asia/Seoul",
      }),
      201,
    ),
    base = "/api/v1/cafes/" + cafe.id + "/",
    plan = await createImportPlan(value, 1000);
  return { ...h, cafe, base, plan };
}
test("v2 chunks stay hidden until owner commits; totals and payroll survive publication and duplicate commit", async (t) => {
  const f = await fixture(),
    { request, db, base, plan, cafe } = await prepare(t, f),
    key = randomToken();
  const job = ok(
    await request(
      "u1",
      base + "imports",
      "POST",
      { version: 2, manifest: plan.manifest },
      key,
    ),
    201,
  );
  assert.equal(
    ok(
      await request(
        "u1",
        base + "imports",
        "POST",
        { version: 2, manifest: plan.manifest },
        key,
      ),
      201,
    ).id,
    job.id,
  );
  assert.equal((await request("u2", base + "imports/" + job.id)).status, 404);
  assert.equal(
    (await request("u1", base + "imports/" + job.id + "/validate", "POST", {}))
      .body.error.code,
    "IMPORT_INCOMPLETE",
  );
  for (const [i, chunk] of plan.chunks.entries())
    ok(
      await request(
        "u1",
        base + "imports/" + job.id + "/chunks/" + i,
        "PUT",
        chunk,
      ),
    );
  assert.deepEqual(ok(await request("u1", base + "sales")), []);
  assert.equal(
    (
      await request("u1", base + "sales", "POST", {
        businessDate: "2026-10-10",
        card: 1,
      })
    ).body.error.code,
    "CAFE_WRITE_LOCKED",
  );
  ok(await request("u1", base + "imports/" + job.id + "/validate", "POST", {}));
  const preview = ok(await request("u1", base + "imports/" + job.id));
  assert.equal(preview.summary.sales.total, 110000);
  assert.equal(preview.summary.work_logs.count, 2);
  const commitKey = randomToken();
  ok(
    await request(
      "u1",
      base + "imports/" + job.id + "/commit",
      "POST",
      {},
      commitKey,
    ),
  );
  ok(
    await request(
      "u1",
      base + "imports/" + job.id + "/commit",
      "POST",
      {},
      commitKey,
    ),
  );
  assert.equal(ok(await request("u1", base + "sales")).length, 4);
  const dashboard = ok(
      await request("u1", base + "dashboard?from=2026-10-01&to=2026-10-31"),
    ),
    expected = createCalculations(f, "2026-10-01", "2026-10-31").metrics();
  for (const [a, b] of [
    ["revenue", "revenue"],
    ["other", "other"],
    ["purchases", "purchases"],
    ["expenses", "misc"],
    ["wages", "wages"],
    ["profit", "profit"],
    ["pending", "pending"],
  ])
    assert.equal(dashboard[a], expected[b], a);
  assert.equal(
    await scalar(db, "SELECT write_mode FROM cafes WHERE id=?", cafe.id),
    "open",
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
  const duplicate = ok(
    await request("u1", base + "imports", "POST", {
      version: 2,
      manifest: plan.manifest,
    }),
    201,
  );
  assert.equal(duplicate.id, job.id);
  assert.equal(ok(await request("u1", base + "sales")).length, 4);
  assert.equal(
    await scalar(db, "SELECT card FROM sales WHERE cafe_id='b' AND id='s3'"),
    9000,
  );
});
test("failed chunks leave no partial rows, cancel clears staging, same file can restart", async (t) => {
  const { request, db, base, plan } = await prepare(t, await fixture());
  const job = ok(
    await request("u1", base + "imports", "POST", {
      version: 2,
      manifest: plan.manifest,
    }),
    201,
  );
  ok(
    await request(
      "u1",
      base + "imports/" + job.id + "/chunks/0",
      "PUT",
      plan.chunks[0],
    ),
  );
  const changed = structuredClone(plan.chunks[1]);
  changed.rows[0].rate = 999;
  assert.equal(
    (
      await request(
        "u1",
        base + "imports/" + job.id + "/chunks/1",
        "PUT",
        changed,
      )
    ).body.error.code,
    "IMPORT_CHUNK_MISMATCH",
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM payroll_rates"), 0);
  ok(await request("u1", base + "imports/" + job.id + "/cancel", "POST", {}));
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM import_chunks WHERE job_id=?",
      job.id,
    ),
    0,
  );
  assert.equal(
    (await request("u1", base + "imports/" + job.id + "/commit", "POST", {}))
      .status,
    409,
  );
  assert.equal(
    ok(
      await request("u1", base + "imports", "POST", {
        version: 2,
        manifest: plan.manifest,
      }),
      201,
    ).id,
    job.id,
  );
  ok(
    await request(
      "u1",
      base + "imports/" + job.id + "/chunks/0",
      "PUT",
      plan.chunks[0],
    ),
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
});
test("import rejects occupied cafe, declared oversize and duplicate IDs across separate chunks", async (t) => {
  const { request, db, base, plan } = await prepare(t, await fixture());
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/imports", "POST", {
        version: 2,
        manifest: plan.manifest,
      })
    ).status,
    409,
  );
  const oversized = [
    { kind: "meta", count: 1, bytes: 128 * 1024, hash: "a".repeat(43) },
    ...Array.from({ length: 160 }, () => ({
      kind: "sales",
      count: 10,
      bytes: 128 * 1024,
      hash: "a".repeat(43),
    })),
  ];
  assert.equal(
    (
      await request("u1", base + "imports", "POST", {
        version: 2,
        manifest: oversized,
      })
    ).status,
    413,
  );
  const duplicate = {
    kind: "sales",
    rows: [plan.chunks.find((c) => c.kind === "sales").rows[0]],
  };
  const chunks = [plan.chunks[0], duplicate, duplicate],
    manifest = [];
  for (const c of chunks)
    manifest.push({
      kind: c.kind,
      count: c.rows.length,
      hash: await digest(c),
      bytes: new TextEncoder().encode(JSON.stringify(c)).length,
    });
  const job = ok(
    await request("u1", base + "imports", "POST", { version: 2, manifest }),
    201,
  );
  for (let i = 0; i < 2; i++)
    ok(
      await request(
        "u1",
        base + "imports/" + job.id + "/chunks/" + i,
        "PUT",
        chunks[i],
      ),
    );
  assert.equal(
    (
      await request(
        "u1",
        base + "imports/" + job.id + "/chunks/2",
        "PUT",
        chunks[2],
      )
    ).status,
    409,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM import_chunks WHERE job_id=?",
      job.id,
    ),
    2,
  );
});
