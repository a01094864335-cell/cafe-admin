import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import { stmt, scalar } from "./helpers.mjs";
import {
  limitMutation,
  cleanupExpired,
} from "../../src/server/services/operations.ts";

test("audit is cafe-scoped, newest-first, paginated and excludes private command data", async (t) => {
  const { db, request } = await setup(t);
  for (let i = 0; i < 3; i++)
    ok(
      await request("u1", "/api/v1/cafes/a/sales", "POST", {
        businessDate: `2026-10-${String(9 + i).padStart(2, "0")}`,
        card: i,
        cash: null,
        transfer: null,
        note: "PRIVATE_NOTE",
      }),
      201,
    );
  const first = await request("u2", "/api/v1/cafes/a/audit?limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.body.data.length, 2);
  assert.ok(first.body.nextCursor);
  for (const row of first.body.data) {
    assert.equal(row.outcome, "success");
    assert.match(row.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(row.actorId, "u1");
  }
  const next = await request(
    "u2",
    "/api/v1/cafes/a/audit?limit=2&cursor=" +
      encodeURIComponent(first.body.nextCursor),
  );
  assert.equal(next.body.data.length, 1);
  assert.equal(
    new Set([...first.body.data, ...next.body.data].map((r) => r.id)).size,
    3,
  );
  assert.doesNotMatch(
    JSON.stringify(first.body),
    /PRIVATE_NOTE|csrf|token|email|summary_json|payload|result_json/,
  );
  assert.equal((await request("u3", "/api/v1/cafes/a/audit")).status, 404);
  assert.equal((await request("u1", "/api/v1/cafes/b/audit")).status, 403);
  assert.equal(
    (
      await request(
        "u2",
        "/api/v1/cafes/b/audit?cursor=" +
          encodeURIComponent(first.body.nextCursor),
      )
    ).status,
    400,
  );
  await stmt(
    db,
    "UPDATE memberships SET role='staff' WHERE cafe_id='a' AND user_id='u2'",
  ).run();
  assert.equal((await request("u2", "/api/v1/cafes/a/audit")).status, 403);
});

test("mutation window atomically caps concurrent retries, resets and does not change ledger on denial", async (t) => {
  const { db, env, request } = await setup(t),
    now = Date.now(),
    window = Math.floor(now / 60000);
  await stmt(
    db,
    "INSERT INTO request_windows(user_id,window,count) VALUES (?,?,119)",
    "u1",
    window,
  ).run();
  const attempts = await Promise.allSettled([
    limitMutation(env, "u1", now),
    limitMutation(env, "u1", now),
  ]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal(
    attempts.find((a) => a.status === "rejected").reason.code,
    "RATE_LIMITED",
  );
  const denied = await request("u1", "/api/v1/cafes/a/sales", "POST", {
    businessDate: "2026-10-09",
    card: 1,
    cash: null,
    transfer: null,
    note: "",
  });
  assert.equal(denied.status, 429);
  assert.equal(await scalar(db, "SELECT count(*) FROM sales"), 3);
  await limitMutation(env, "u1", now + 60000);
  assert.equal(
    await scalar(db, "SELECT count FROM request_windows WHERE user_id='u1'"),
    1,
  );
});

test("cleanup removes expired credentials only and leaves active sessions and ledger untouched", async (t) => {
  const { db, env } = await setup(t);
  await stmt(
    db,
    "INSERT INTO oauth_transactions VALUES ('old','browser','nonce','verifier','2000-01-01T00:00:00.000Z',NULL)",
  ).run();
  await stmt(
    db,
    "INSERT INTO oauth_transactions VALUES ('live','browser','nonce','verifier','2999-01-01T00:00:00.000Z',NULL)",
  ).run();
  await stmt(
    db,
    "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='u3'",
  ).run();
  await cleanupExpired(env);
  assert.equal(await scalar(db, "SELECT count(*) FROM oauth_transactions"), 1);
  assert.equal(await scalar(db, "SELECT count(*) FROM sessions"), 2);
  assert.equal(await scalar(db, "SELECT count(*) FROM memberships"), 4);
});
