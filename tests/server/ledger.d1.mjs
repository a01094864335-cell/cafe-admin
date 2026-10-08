import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import { scalar, stmt } from "./helpers.mjs";
import { randomToken } from "../../src/server/auth/crypto.ts";

test("owner sales are shared with same-cafe admin, hidden from staff/nonmember and staging", async (t) => {
  const { request } = await setup(t);
  const sale = ok(
    await request("u1", "/api/v1/cafes/a/sales", "POST", {
      businessDate: "2026-10-08",
      card: 12000,
      cash: 0,
      transfer: null,
      note: "공유",
    }),
    201,
  );
  const visible = ok(await request("u2", "/api/v1/cafes/a/sales/" + sale.id));
  assert.equal(visible.card, 12000);
  assert.equal(visible.transfer, null);
  assert.equal(visible.cash, 0);
  assert.equal("datasetId" in visible, false);
  assert.equal((await request("u3", "/api/v1/cafes/a/sales")).status, 404);
  assert.equal((await request("u1", "/api/v1/cafes/b/sales")).status, 403);
  assert.equal(
    (await request("u2", "/api/v1/cafes/b/sales/" + sale.id)).status,
    404,
  );
  assert.equal((await request("u1", "/api/v1/cafes/a/sales/s2")).status, 404);
});

test("sales concurrency preserves inputs, current latest DTO and atomic audit/revision", async (t) => {
  const { request, db } = await setup(t);
  const sale = ok(
    await request("u1", "/api/v1/cafes/a/sales", "POST", {
      businessDate: "2026-10-08",
      card: 100,
    }),
    201,
  );
  const responses = await Promise.all([
    request("u1", "/api/v1/cafes/a/sales/" + sale.id, "PATCH", {
      card: 200,
      expectedVersion: 1,
    }),
    request("u2", "/api/v1/cafes/a/sales/" + sale.id, "PATCH", {
      card: 300,
      expectedVersion: 1,
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const conflict = responses.find((r) => r.status === 409);
  assert.equal(conflict.body.error.details.latest.version, 2);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM commands WHERE scope LIKE '%sales%'",
    ),
    2,
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM audit_logs WHERE target=?", sale.id),
    2,
  );
  assert.equal(await scalar(db, "SELECT revision FROM cafes WHERE id='a'"), 2);
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
});

test("ledger idempotency, validation, write locks and soft-delete protect stored data", async (t) => {
  const { request, db } = await setup(t),
    key = randomToken(),
    data = { businessDate: "2026-10-08", card: null, cash: 0, transfer: -5000 };
  const a = ok(
    await request("u1", "/api/v1/cafes/a/sales", "POST", data, key),
    201,
  );
  assert.equal(
    ok(await request("u1", "/api/v1/cafes/a/sales", "POST", data, key), 201).id,
    a.id,
  );
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/a/sales",
        "POST",
        { ...data, card: 1 },
        key,
      )
    ).body.error.code,
    "IDEMPOTENCY_MISMATCH",
  );
  for (const invalid of [
    { ...data, businessDate: "2026-02-30" },
    { ...data, card: 0.5 },
    { ...data, actorId: "u2" },
  ])
    assert.equal(
      (await request("u1", "/api/v1/cafes/a/sales", "POST", invalid)).status,
      400,
    );
  await stmt(db, "UPDATE cafes SET write_mode='import' WHERE id='a'").run();
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/sales/" + a.id, "PATCH", {
        card: 1,
        expectedVersion: 1,
      })
    ).body.error.code,
    "CAFE_WRITE_LOCKED",
  );
  await stmt(db, "UPDATE cafes SET write_mode='open' WHERE id='a'").run();
  const delKey = randomToken();
  ok(
    await request(
      "u1",
      "/api/v1/cafes/a/sales/" + a.id,
      "DELETE",
      { expectedVersion: 1 },
      delKey,
    ),
  );
  ok(
    await request(
      "u1",
      "/api/v1/cafes/a/sales/" + a.id,
      "DELETE",
      { expectedVersion: 1 },
      delKey,
    ),
  );
  assert.equal(
    (await request("u2", "/api/v1/cafes/a/sales/" + a.id)).status,
    404,
  );
  assert.equal(
    await scalar(db, "SELECT transfer FROM sales WHERE id=?", a.id),
    -5000,
  );
});

test("ledger date pagination binds filters, cafe, active dataset and actor", async (t) => {
  const { request } = await setup(t);
  for (let i = 2; i <= 3; i++)
    ok(
      await request("u1", "/api/v1/cafes/a/sales", "POST", {
        businessDate: "2026-10-0" + i,
        card: i,
      }),
      201,
    );
  const first = await request(
    "u1",
    "/api/v1/cafes/a/sales?limit=1&from=2026-10-02&to=2026-10-03",
  );
  ok(first);
  assert.equal(first.body.data[0].businessDate, "2026-10-02");
  const cursor = encodeURIComponent(first.body.nextCursor);
  const second = await request(
    "u1",
    "/api/v1/cafes/a/sales?limit=1&from=2026-10-02&to=2026-10-03&cursor=" +
      cursor,
  );
  ok(second);
  assert.equal(second.body.data[0].businessDate, "2026-10-03");
  assert.equal(second.body.nextCursor, null);
  assert.equal(
    (await request("u1", "/api/v1/cafes/a/sales?cursor=" + cursor)).status,
    400,
  );
});
