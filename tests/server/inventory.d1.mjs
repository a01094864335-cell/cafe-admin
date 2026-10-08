import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import { scalar } from "./helpers.mjs";
import { randomToken } from "../../src/server/auth/crypto.ts";
const base = "/api/v1/cafes/a/";
test("inventory opening and concurrent adjustments are atomic, scoped and idempotent", async (t) => {
  const { request, db } = await setup(t),
    key = randomToken();
  const input = { name: "원두", unit: "kg", quantityHundredths: 250 };
  const item = ok(
    await request("u1", base + "inventory/items", "POST", input, key),
    201,
  );
  assert.equal(
    ok(await request("u1", base + "inventory/items", "POST", input, key), 201)
      .id,
    item.id,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM inventory_movements WHERE item_id=?",
      item.id,
    ),
    1,
  );
  const responses = await Promise.all(
    ["u1", "u2"].map((u) =>
      request(u, base + "inventory/movements", "POST", {
        itemId: item.id,
        deltaHundredths: 100,
        expectedVersion: 1,
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    ok(await request("u1", base + "inventory/items/" + item.id))
      .quantityHundredths,
    350,
  );
  assert.equal(
    (await request("u1", "/api/v1/cafes/b/inventory/items")).status,
    403,
  );
  assert.equal(
    (await request("u2", "/api/v1/cafes/b/inventory/items/" + item.id)).status,
    404,
  );
  const history = ok(
    await request("u1", base + "inventory/movements?itemId=" + item.id),
  );
  assert.equal(history.length, 2);
  assert.equal(
    (
      await request("u1", base + "inventory/items/" + item.id, "PATCH", {
        quantityHundredths: 10,
        expectedVersion: 2,
      })
    ).status,
    400,
  );
});
test("purchase, stock and audit commit together; stock replacement and deletion append reversals", async (t) => {
  const { request, db } = await setup(t);
  const item = ok(
    await request("u1", base + "inventory/items", "POST", {
      name: "우유",
      unit: "L",
    }),
    201,
  );
  const payload = {
    businessDate: "2026-10-08",
    item: "우유",
    amount: 12000,
    stock: { itemId: item.id, deltaHundredths: 200, expectedItemVersion: 1 },
  };
  const p = ok(await request("u1", base + "purchases", "POST", payload), 201);
  assert.equal(
    ok(await request("u1", base + "inventory/items/" + item.id))
      .quantityHundredths,
    200,
  );
  const failed = await request("u1", base + "purchases", "POST", payload);
  assert.equal(failed.status, 409);
  assert.equal(await scalar(db, "SELECT count(*) FROM purchases"), 1);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM audit_logs WHERE action=?",
      "purchases.create",
    ),
    1,
  );
  ok(
    await request("u2", base + "purchases/" + p.id, "PATCH", {
      expectedVersion: 1,
      stock: { itemId: item.id, deltaHundredths: 350, expectedItemVersion: 2 },
    }),
  );
  assert.equal(
    ok(await request("u1", base + "inventory/items/" + item.id))
      .quantityHundredths,
    350,
  );
  const key = randomToken();
  ok(
    await request(
      "u1",
      base + "purchases/" + p.id,
      "DELETE",
      { expectedVersion: 2 },
      key,
    ),
  );
  ok(
    await request(
      "u1",
      base + "purchases/" + p.id,
      "DELETE",
      { expectedVersion: 2 },
      key,
    ),
  );
  assert.equal(
    ok(await request("u1", base + "inventory/items/" + item.id))
      .quantityHundredths,
    0,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT sum(delta_hundredths) FROM inventory_movements WHERE purchase_id=?",
      p.id,
    ),
    0,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM inventory_movements WHERE purchase_id=?",
      p.id,
    ),
    3,
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
});
test("cross-cafe stock references cannot partially save a purchase", async (t) => {
  const { request, db } = await setup(t);
  const item = ok(
    await request("u2", "/api/v1/cafes/b/inventory/items", "POST", {
      name: "격리",
      unit: "개",
    }),
    201,
  );
  const r = await request("u1", base + "purchases", "POST", {
    businessDate: "2026-10-08",
    item: "잘못된 연결",
    amount: 1,
    stock: { itemId: item.id, deltaHundredths: 100, expectedItemVersion: 1 },
  });
  assert.equal(r.status, 404);
  assert.equal(await scalar(db, "SELECT count(*) FROM purchases"), 0);
  assert.equal(
    ok(await request("u2", "/api/v1/cafes/b/inventory/items/" + item.id))
      .quantityHundredths,
    0,
  );
});
