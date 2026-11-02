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
    "/api/v1/cafes/a/sales?sort=oldest&limit=1&from=2026-10-02&to=2026-10-03",
  );
  ok(first);
  assert.equal(first.body.data[0].businessDate, "2026-10-02");
  const cursor = encodeURIComponent(first.body.nextCursor);
  const second = await request(
    "u1",
    "/api/v1/cafes/a/sales?sort=oldest&limit=1&from=2026-10-02&to=2026-10-03&cursor=" +
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

test("cost categories filter before pagination and bind cursors to category", async (t) => {
  const { request } = await setup(t);
  for (const item of ["화장지", "멸균우유", "키친타올", "명함 디자인", "분류불명"]) {
    ok(await request("u1", "/api/v1/cafes/a/expenses", "POST", {
      businessDate: "2026-10-10", item, vendor: "쿠팡", amount: 100,
    }), 201);
  }
  const url = "/api/v1/cafes/a/expenses?category=" + encodeURIComponent("청소·위생용품") + "&limit=1";
  const firstResult = await request("u1", url);
  ok(firstResult);
  const first = firstResult.body;
  assert.equal(first.data.length, 1);
  assert.equal(first.data[0].category, "청소·위생용품");
  assert.ok(first.nextCursor);
  const secondResult = await request("u1", url + "&cursor=" + encodeURIComponent(first.nextCursor));
  ok(secondResult);
  const second = secondResult.body;
  assert.equal(second.data.length, 1);
  assert.notEqual(first.data[0].id, second.data[0].id);
  assert.equal(second.nextCursor, null);
  assert.equal((await request("u1", "/api/v1/cafes/a/expenses?category=" + encodeURIComponent("홍보·인쇄") + "&cursor=" + encodeURIComponent(first.nextCursor))).status, 400);
  assert.equal((await request("u1", "/api/v1/cafes/a/expenses?category=invalid")).status, 400);
  assert.equal((await request("u3", url)).status, 404);
});


test("ledger sort defaults descending and supports amounts across tied pages", async (t) => {
  const { request } = await setup(t);
  for (const [businessDate, amount] of [["2026-10-01",100],["2026-10-02",500],["2026-10-03",500],["2026-10-04",-50]]) {
    ok(await request("u1", "/api/v1/cafes/a/expenses", "POST", {businessDate, amount, item:"정렬 테스트"}),201);
  }
  const newest = await request("u1", "/api/v1/cafes/a/expenses");
  assert.equal(ok(newest)[0].businessDate,"2026-10-04");
  for (const [sort, expected] of [["highest",[500,500,100,-50]],["lowest",[-50,100,500,500]]]) {
    let cursor = null;
    const amounts = [], ids = new Set();
    do {
      const response = await request("u1", "/api/v1/cafes/a/expenses?limit=1&sort="+sort+(cursor ? "&cursor="+encodeURIComponent(cursor):""));
      for(const row of ok(response)) {amounts.push(row.amount);ids.add(row.id);}
      cursor=response.body.nextCursor;
    } while(cursor);
    assert.deepEqual(amounts,expected);
    assert.equal(ids.size,4);
  }
});

test("scorecards aggregate all filtered rows rather than the current page", async (t) => {
  const {request} = await setup(t);
  for(const [item,amount] of [["키친타올",100],["화장지",200],["세정제",-50],["명함",900]]) ok(await request("u1","/api/v1/cafes/a/expenses","POST",{businessDate:"2026-10-10",item,amount}),201);
  const url="/api/v1/cafes/a/expenses?limit=1&category="+encodeURIComponent("청소·위생용품");
  const first=await request("u1",url); ok(first);
  assert.equal(first.body.data.length,1);
  assert.deepEqual(first.body.summary,{count:3,recorded:3,total:250,minimum:-50,maximum:200,refunds:-50});
  const next=await request("u1",url+"&cursor="+encodeURIComponent(first.body.nextCursor));ok(next);
  assert.deepEqual(next.body.summary,first.body.summary);
  const empty=await request("u1",url+"&from=2026-01-01&to=2026-01-02");ok(empty);
  assert.equal(empty.body.summary.total,0);assert.equal(empty.body.summary.maximum,null);
});
