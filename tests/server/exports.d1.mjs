import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import { stmt, scalar } from "./helpers.mjs";
import { randomToken } from "../../src/server/auth/crypto.ts";
test("owner exports a stable paginated snapshot without account IDs; completion releases only that cafe", async (t) => {
  const { request, db } = await setup(t),
    base = "/api/v1/cafes/a/exports";
  await db.batch(
    Array.from({ length: 55 }, (_, i) =>
      stmt(
        db,
        "INSERT INTO expenses(cafe_id,dataset_id,id,business_date,amount,item,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?)",
        "a",
        "a-live",
        "export-" + i,
        "2026-10-08",
        i,
        "가상 지출",
        "u1",
        "u1",
      ),
    ),
  );
  const job = ok(await request("u1", base, "POST", {}), 201),
    path = base + "/" + job.id;
  const snapshot = ok(await request("u1", path));
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.summary.expenses.count, 55);
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/sales", "POST", {
        businessDate: "2026-10-08",
        card: 1,
      })
    ).body.error.code,
    "CAFE_WRITE_LOCKED",
  );
  const page = await request("u1", path + "/pages?table=expenses");
  assert.equal(ok(page).length, 50);
  assert.ok(page.body.nextCursor);
  const next = ok(
    await request(
      "u1",
      path +
        "/pages?table=expenses&cursor=" +
        encodeURIComponent(page.body.nextCursor),
    ),
  );
  assert.equal(next.length, 5);
  assert.equal(new Set([...page.body.data, ...next].map((r) => r.id)).size, 55);
  for (const r of [...page.body.data, ...next])
    for (const key of [
      "cafe_id",
      "dataset_id",
      "created_by",
      "updated_by",
      "linked_user_id",
      "operation_id",
    ])
      assert.equal(key in r, false, key);
  assert.equal(
    (
      await request(
        "u1",
        path +
          "/pages?table=sales&cursor=" +
          encodeURIComponent(page.body.nextCursor),
      )
    ).status,
    400,
  );
  assert.equal((await request("u2", path + "/pages?table=sales")).status, 403);
  assert.equal((await request("u3", path + "/pages?table=sales")).status, 404);
  const key = randomToken();
  ok(await request("u1", path + "/complete", "POST", {}, key));
  ok(await request("u1", path + "/complete", "POST", {}, key));
  assert.equal(
    await scalar(db, "SELECT write_mode FROM cafes WHERE id='a'"),
    "open",
  );
  assert.equal((await request("u1", path + "/pages?table=sales")).status, 409);
  assert.equal(
    await scalar(db, "SELECT card FROM sales WHERE cafe_id='b' AND id='s3'"),
    9000,
  );
});
test("expired exports unlock on the next write; revision and ownership changes invalidate pages", async (t) => {
  const { request, db } = await setup(t),
    base = "/api/v1/cafes/a/exports";
  const job = ok(await request("u1", base, "POST", {}), 201),
    path = base + "/" + job.id;
  await stmt(
    db,
    "UPDATE export_jobs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    job.id,
  ).run();
  ok(
    await request("u1", "/api/v1/cafes/a/sales", "POST", {
      businessDate: "2026-10-09",
      card: 1,
    }),
    201,
  );
  assert.equal(
    (await request("u1", path + "/complete", "POST", {})).status,
    409,
  );
  assert.equal(
    await scalar(db, "SELECT state FROM export_jobs WHERE id=?", job.id),
    "failed",
  );
  const current = ok(await request("u1", base, "POST", {}), 201),
    active = base + "/" + current.id;
  await stmt(db, "UPDATE cafes SET revision=revision+1 WHERE id='a'").run();
  assert.equal(
    (await request("u1", active + "/pages?table=sales")).status,
    409,
  );
  assert.equal(
    (await request("u1", active + "/complete", "POST", {})).status,
    409,
  );
  ok(await request("u1", active + "/cancel", "POST", {}));
  const third = ok(await request("u1", base, "POST", {}), 201);
  await db.batch([
    stmt(
      db,
      "UPDATE memberships SET role='admin' WHERE cafe_id='a' AND user_id='u1'",
    ),
    stmt(
      db,
      "UPDATE memberships SET role='owner' WHERE cafe_id='a' AND user_id='u2'",
    ),
  ]);
  assert.equal(
    (await request("u1", base + "/" + third.id + "/pages?table=sales")).status,
    403,
  );
  assert.equal(
    (await request("u2", base + "/" + third.id + "/pages?table=sales")).status,
    404,
  );
});
