import test from "node:test";
import assert from "node:assert/strict";
import { database, seed, stmt, scalar } from "./helpers.mjs";
import {
  atomicCafeBatch,
  assertChanged,
} from "../../src/server/repositories/atomic.ts";

const command = (db) =>
  stmt(
    db,
    `INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('op','u1','a','a:PATCH:sales/s1','key','hash')`,
  );
const audit = (db) =>
  stmt(
    db,
    `INSERT INTO audit_logs(id,cafe_id,actor_id,operation_id,target,action,summary_json) VALUES ('audit','a','u1','op','s1','update','{}')`,
  );
async function unchanged(db) {
  assert.equal(
    await scalar(db, "SELECT card FROM sales WHERE id='s1'"),
    100000,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT quantity_hundredths FROM inventory_items WHERE id='i1'",
    ),
    250,
  );
  assert.equal(await scalar(db, "SELECT revision FROM cafes WHERE id='a'"), 0);
  for (const table of [
    "commands",
    "audit_logs",
    "inventory_movements",
    "transaction_assertions",
  ])
    assert.equal(await scalar(db, `SELECT count(*) FROM ${table}`), 0, table);
}

test("real D1 batch: middle SQL failure rolls back command, ledger, inventory, audit and revision", async (t) => {
  const db = await database(t);
  await seed(db);
  await assert.rejects(
    db.batch([
      command(db),
      stmt(db, "UPDATE sales SET card=1 WHERE id='s1'"),
      stmt(
        db,
        "UPDATE inventory_items SET quantity_hundredths=1 WHERE id='i1'",
      ),
      audit(db),
      stmt(db, "UPDATE cafes SET revision=revision+1 WHERE id='a'"),
      stmt(
        db,
        "INSERT INTO inventory_movements(cafe_id,dataset_id,id,item_id,delta_hundredths,operation_id,kind,created_by,updated_by) VALUES ('a','a-live','m1','missing',1,'op','adjustment','u1','u1')",
      ),
      stmt(db, "UPDATE sales SET cash=2 WHERE id='s1'"),
    ]),
    /FOREIGN KEY/,
  );
  await unchanged(db);
});

test("0-row UPDATE itself succeeds; immediate changes() assertion rolls back the complete command", async (t) => {
  const db = await database(t);
  await seed(db);
  const result = await stmt(
    db,
    "UPDATE sales SET card=1 WHERE id='s1' AND version=99",
  ).run();
  assert.equal(result.meta.changes, 0);
  await assert.rejects(
    atomicCafeBatch(
      db,
      "a",
      [
        command(db),
        audit(db),
        stmt(
          db,
          "UPDATE inventory_items SET quantity_hundredths=1 WHERE id='i1'",
        ),
        stmt(db, "UPDATE cafes SET revision=revision+1 WHERE id='a'"),
        stmt(
          db,
          "UPDATE sales SET card=1,version=version+1 WHERE cafe_id='a' AND dataset_id='a-live' AND id='s1' AND version=99",
        ),
        assertChanged(db, "version"),
      ],
      ["version"],
    ),
    /CHECK/,
  );
  await unchanged(db);
  await atomicCafeBatch(
    db,
    "a",
    [
      command(db),
      stmt(
        db,
        "UPDATE sales SET card=1,version=version+1 WHERE cafe_id='a' AND dataset_id='a-live' AND id='s1' AND version=1",
      ),
      assertChanged(db, "version"),
      audit(db),
      stmt(db, "UPDATE cafes SET revision=revision+1 WHERE id='a'"),
    ],
    ["version"],
  );
  assert.equal(await scalar(db, "SELECT version FROM sales WHERE id='s1'"), 2);
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
});

test("command uniqueness prevents repeated/concurrent application and scopes keys by user and resource", async (t) => {
  const db = await database(t);
  await seed(db);
  const write = () =>
    db.batch([
      command(db),
      stmt(db, "UPDATE cafes SET revision=revision+1 WHERE id='a'"),
    ]);
  const results = await Promise.allSettled([write(), write()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await scalar(db, "SELECT revision FROM cafes WHERE id='a'"), 1);
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('different','u1','a','a:PATCH:sales/s1','key','different-hash')",
    ).run(),
    /UNIQUE/,
  );
  await stmt(
    db,
    "INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('other','u1','b','b:PATCH:sales/s1','key','hash')",
  ).run();
});

test("owner exact-one assertion protects creation, demotion and failed transfer; valid transfer succeeds", async (t) => {
  const db = await database(t);
  await seed(db);
  await assert.rejects(
    atomicCafeBatch(db, "empty", [
      stmt(db, "INSERT INTO cafes(id,name) VALUES ('empty','ownerless')"),
      stmt(
        db,
        "INSERT INTO datasets(cafe_id,id,state) VALUES ('empty','d','active')",
      ),
      stmt(db, "UPDATE cafes SET active_dataset_id='d' WHERE id='empty'"),
    ]),
    /CHECK/,
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM cafes WHERE id='empty'"),
    0,
  );
  await assert.rejects(
    stmt(db, "UPDATE memberships SET role='owner' WHERE id='ma2'").run(),
    /UNIQUE/,
  );
  await assert.rejects(
    atomicCafeBatch(db, "a", [
      stmt(db, "UPDATE memberships SET status='inactive' WHERE id='ma1'"),
    ]),
    /CHECK/,
  );
  await assert.rejects(
    atomicCafeBatch(db, "a", [
      stmt(db, "UPDATE memberships SET role='admin' WHERE id='ma1'"),
      stmt(
        db,
        "UPDATE memberships SET role='owner' WHERE cafe_id='a' AND user_id='u3'",
      ),
    ]),
    /CHECK/,
  );
  assert.equal(
    await scalar(db, "SELECT role FROM memberships WHERE id='ma1'"),
    "owner",
  );
  await atomicCafeBatch(
    db,
    "a",
    [
      stmt(
        db,
        "UPDATE memberships SET role='admin',version=version+1 WHERE id='ma1' AND role='owner'",
      ),
      assertChanged(db, "old"),
      stmt(
        db,
        "UPDATE memberships SET role='owner',version=version+1 WHERE id='ma2' AND status='active'",
      ),
      assertChanged(db, "new"),
    ],
    ["old", "new"],
  );
  assert.equal(
    await scalar(
      db,
      "SELECT user_id FROM memberships WHERE cafe_id='a' AND role='owner' AND status='active'",
    ),
    "u2",
  );
});

test("dataset publication is atomic, staging is invisible and invalid final state restores old pointer", async (t) => {
  const db = await database(t);
  await seed(db);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM active_sales WHERE cafe_id='a' AND id='s2'",
    ),
    0,
  );
  await assert.rejects(
    atomicCafeBatch(db, "a", [
      stmt(
        db,
        "UPDATE datasets SET state='retired' WHERE cafe_id='a' AND id='a-live'",
      ),
      stmt(db, "UPDATE cafes SET active_dataset_id='a-stage' WHERE id='a'"),
    ]),
    /CHECK/,
  );
  assert.equal(
    await scalar(db, "SELECT id FROM active_sales WHERE cafe_id='a'"),
    "s1",
  );
  await atomicCafeBatch(db, "a", [
    stmt(
      db,
      "UPDATE datasets SET state='retired' WHERE cafe_id='a' AND id='a-live'",
    ),
    stmt(
      db,
      "UPDATE datasets SET state='active' WHERE cafe_id='a' AND id='a-stage'",
    ),
    stmt(
      db,
      "UPDATE cafes SET active_dataset_id='a-stage',revision=revision+1 WHERE id='a'",
    ),
  ]);
  assert.equal(
    await scalar(db, "SELECT id FROM active_sales WHERE cafe_id='a'"),
    "s2",
  );
  assert.equal(
    await scalar(db, "SELECT id FROM active_sales WHERE cafe_id='b'"),
    "s3",
  );
  await assert.rejects(
    stmt(db, "UPDATE cafes SET active_dataset_id='b-live' WHERE id='a'").run(),
    /FOREIGN KEY/,
  );
});

test("SQL rechecks write lock, active dataset and current membership before committing", async (t) => {
  const db = await database(t);
  await seed(db);
  const guarded = () =>
    stmt(
      db,
      `UPDATE sales SET card=123,version=version+1
    WHERE cafe_id='a' AND dataset_id='a-live' AND id='s1' AND version=1 AND deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM cafes c JOIN memberships m ON m.cafe_id=c.id
      WHERE c.id=sales.cafe_id AND c.active_dataset_id=sales.dataset_id AND c.write_mode='open'
      AND m.user_id='u1' AND m.status='active' AND m.role IN ('owner','admin'))`,
    );
  for (const [block, restore] of [
    [
      "UPDATE cafes SET write_mode='import' WHERE id='a'",
      "UPDATE cafes SET write_mode='open' WHERE id='a'",
    ],
    [
      "UPDATE cafes SET active_dataset_id='a-stage' WHERE id='a'",
      "UPDATE cafes SET active_dataset_id='a-live' WHERE id='a'",
    ],
    [
      "UPDATE memberships SET status='inactive' WHERE id='ma1'",
      "UPDATE memberships SET status='active' WHERE id='ma1'",
    ],
  ]) {
    await stmt(db, block).run();
    await assert.rejects(
      atomicCafeBatch(
        db,
        "a",
        [command(db), guarded(), assertChanged(db, "guard"), audit(db)],
        ["guard"],
      ),
      /CHECK/,
    );
    assert.equal(await scalar(db, "SELECT count(*) FROM commands"), 0);
    assert.equal(
      await scalar(db, "SELECT card FROM sales WHERE id='s1'"),
      100000,
    );
    await stmt(db, restore).run();
  }
});

test("new cafe creation succeeds only with owner and active dataset in one batch", async (t) => {
  const db = await database(t);
  await seed(db);
  await atomicCafeBatch(db, "new", [
    stmt(db, "INSERT INTO cafes(id,name) VALUES ('new','가상 새 카페')"),
    stmt(
      db,
      "INSERT INTO datasets(cafe_id,id,state) VALUES ('new','new-live','active')",
    ),
    stmt(
      db,
      "INSERT INTO memberships(id,cafe_id,user_id,role) VALUES ('new-owner','new','u3','owner')",
    ),
    stmt(db, "UPDATE cafes SET active_dataset_id='new-live' WHERE id='new'"),
  ]);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM memberships WHERE cafe_id='new' AND role='owner' AND status='active'",
    ),
    1,
  );
  assert.deepEqual(
    (await db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
});
