import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { database, seed, stmt, scalar } from "./helpers.mjs";

test("composite references reject other cafe and other dataset employees/items/jobs", async (t) => {
  const db = await database(t);
  await seed(db);
  for (const [dataset, employee] of [
    ["a-live", "e2"],
    ["a-live", "e3"],
    ["b-live", "e1"],
  ]) {
    await assert.rejects(
      stmt(
        db,
        `INSERT INTO work_logs(cafe_id,dataset_id,id,employee_id,business_date,start_time,end_time,break_minutes,created_by,updated_by)
      VALUES ('a',?,'bad',?,'2026-10-01','09:00','10:00',0,'u1','u1')`,
        dataset,
        employee,
      ).run(),
      /FOREIGN KEY/,
    );
  }
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO sales(cafe_id,dataset_id,id,business_date,created_by,updated_by) VALUES ('a','b-live','bad','2026-10-01','u1','u1')",
    ).run(),
    /FOREIGN KEY/,
  );
  await stmt(
    db,
    "INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('op','u1','a','a:inventory','key','hash')",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO inventory_movements(cafe_id,dataset_id,id,item_id,delta_hundredths,operation_id,kind,created_by,updated_by) VALUES ('a','a-stage','bad','i1',1,'op','adjustment','u1','u1')",
    ).run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO import_jobs(cafe_id,id,dataset_id,owner_id,file_hash,state,expected_chunks) VALUES ('a','bad','b-live','u1','hash','uploading',1)",
    ).run(),
    /FOREIGN KEY/,
  );
  assert.deepEqual(
    (await db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
});

test("soft-delete uniqueness, integer money, version and linked-user constraints", async (t) => {
  const db = await database(t);
  await seed(db);
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO sales(cafe_id,dataset_id,id,business_date,created_by,updated_by) VALUES ('a','a-live','duplicate','2026-10-01','u1','u1')",
    ).run(),
    /UNIQUE/,
  );
  await stmt(
    db,
    "UPDATE sales SET deleted_at='2026-10-08T00:00:00Z' WHERE id='s1'",
  ).run();
  await stmt(
    db,
    "INSERT INTO sales(cafe_id,dataset_id,id,business_date,card,cash,created_by,updated_by) VALUES ('a','a-live','replacement','2026-10-01',-10000,0,'u1','u1')",
  ).run();
  await assert.rejects(
    stmt(db, "UPDATE sales SET card=1.5 WHERE id='replacement'").run(),
    /INTEGER/,
  );
  await assert.rejects(
    stmt(
      db,
      "UPDATE sales SET card=1000000000001 WHERE id='replacement'",
    ).run(),
    /CHECK/,
  );
  await assert.rejects(
    stmt(db, "UPDATE sales SET version=0 WHERE id='replacement'").run(),
    /CHECK/,
  );
  await stmt(
    db,
    "UPDATE employees SET linked_user_id='u1' WHERE id='e1'",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO employees(cafe_id,dataset_id,id,name,linked_user_id,created_by,updated_by) VALUES ('a','a-live','dup','가상','u1','u1','u1')",
    ).run(),
    /UNIQUE/,
  );
});

test("import/chunk identity and one running job per cafe", async (t) => {
  const db = await database(t);
  await seed(db);
  await stmt(
    db,
    "INSERT INTO import_jobs(cafe_id,id,dataset_id,owner_id,file_hash,state,expected_chunks) VALUES ('a','job','a-stage','u1','file','uploading',1)",
  ).run();
  await stmt(
    db,
    "INSERT INTO datasets(cafe_id,id,state) VALUES ('a','stage2','staging')",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO import_jobs(cafe_id,id,dataset_id,owner_id,file_hash,state,expected_chunks) VALUES ('a','job2','stage2','u1','file2','uploading',1)",
    ).run(),
    /UNIQUE/,
  );
  await stmt(
    db,
    "INSERT INTO import_chunks VALUES ('a','job',0,'chunkhash',10)",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO import_chunks VALUES ('a','job',0,'changed',11)",
    ).run(),
    /UNIQUE/,
  );
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO import_chunks VALUES ('b','job',0,'chunkhash',10)",
    ).run(),
    /FOREIGN KEY/,
  );
  await stmt(
    db,
    "UPDATE import_jobs SET state='cancelled' WHERE id='job'",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO import_jobs(cafe_id,id,dataset_id,owner_id,file_hash,state,expected_chunks) VALUES ('a','job2','stage2','u1','file','uploading',1)",
    ).run(),
    /UNIQUE/,
  );
});

// Test-only mapping of the already synthetic W01 fixture; not the W12 production importer.
test("legacy synthetic data preserves other income, reconciliation, weekly confirmation, extras and employment settings", async (t) => {
  const db = await database(t);
  await seed(db);
  const f = JSON.parse(
    await readFile(
      new URL("../fixtures/legacy-v2.json", import.meta.url),
      "utf8",
    ),
  );
  const insert = async (table, data) => {
    const row = {
      cafe_id: "a",
      dataset_id: "a-stage",
      created_by: "u1",
      updated_by: "u1",
      ...data,
    };
    return stmt(
      db,
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
      ...Object.values(row),
    ).run();
  };
  await stmt(db, "DELETE FROM sales WHERE dataset_id='a-stage'").run();
  for (const s of f.sales)
    await insert("sales", {
      id: s.id,
      business_date: s.date,
      card: s.card,
      cash: s.cash,
      transfer: s.transfer,
      note: s.note,
    });
  for (const p of f.purchases)
    await insert(p.group === "월별 구매" ? "purchases" : "expenses", {
      id: p.id,
      business_date: p.date,
      vendor: p.vendor,
      item: p.item,
      amount: p.amount,
      note: p.note,
    });
  for (const i of f.incomes)
    await insert("other_incomes", {
      id: i.id,
      business_date: i.date,
      item: i.item,
      amount: i.amount,
      note: i.note,
    });
  for (const [month, v] of Object.entries(f.comparisons))
    await insert("sales_reconciliations", {
      id: month,
      month,
      reported: v.reported,
      note: v.note,
    });
  for (const [month, amount] of Object.entries(f.monthlyExtras))
    await insert("payroll_extras", {
      id: month,
      employee_id: "e3",
      month,
      amount,
    });
  for (const [week, v] of Object.entries(f.weeks))
    await insert("weekly_confirmations", {
      id: week,
      employee_id: "e3",
      week_start: week,
      agreed_hours: v.agreed,
      confirmation: v.confirmation,
      note: v.note,
    });
  for (const w of f.payroll)
    await insert("work_logs", {
      id: w.id,
      employee_id: "e3",
      business_date: w.date,
      start_time: w.start,
      end_time: w.end,
      break_minutes: w.breakMinutes,
      note: w.note,
    });
  await stmt(
    db,
    "INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('opening','u1','a','a:import:synthetic','opening','synthetic-hash')",
  ).run();
  for (const item of f.inventory) {
    await insert("inventory_items", {
      id: item.id,
      name: item.name,
      unit: item.unit,
      quantity_hundredths: item.qty * 100,
      minimum_hundredths: item.min * 100,
      cost: item.cost,
      supplier: item.supplier,
    });
    await insert("inventory_movements", {
      id: "opening-" + item.id,
      item_id: item.id,
      delta_hundredths: item.qty * 100,
      operation_id: "opening",
      kind: "opening",
    });
  }
  assert.equal(
    await scalar(
      db,
      "SELECT SUM(delta_hundredths) FROM inventory_movements WHERE dataset_id='a-stage'",
    ),
    250,
  );
  const e = f.employment;
  await stmt(
    db,
    "UPDATE employees SET hire_date=?,end_date=? WHERE cafe_id='a' AND dataset_id='a-stage' AND id='e3'",
    e.hireDate,
    e.endDate,
  ).run();
  const settings = {
    id: "settings",
    employee_id: "e3",
    effective_from: e.start,
    effective_to: e.end,
    first_week: e.firstWeek,
    weekly_hours: e.weeklyHours,
    holiday_day: e.holidayDay,
    normal_days: e.normalDays,
    calculation_start: e.start,
    calculation_end: e.end,
    threshold: e.threshold,
    cap_hours: e.capHours,
    max_weekly: e.maxWeekly,
    average_weeks: e.averageWeeks,
  };
  await insert("payroll_settings", settings);
  for (const [year, rate] of Object.entries(e.rates))
    await stmt(
      db,
      "INSERT INTO payroll_rates VALUES ('a','a-stage','settings',?,?)",
      Number(year),
      rate,
    ).run();
  await assert.rejects(
    insert("payroll_settings", { ...settings, id: "overlap" }),
    /payroll_period_overlap/,
  );
  await insert("payroll_settings", {
    ...settings,
    id: "future",
    effective_from: "2028-01-01",
    effective_to: null,
  });
  await assert.rejects(
    stmt(
      db,
      "UPDATE payroll_settings SET effective_from='2027-01-01' WHERE id='future'",
    ).run(),
    /payroll_period_overlap/,
  );
  await stmt(
    db,
    "UPDATE datasets SET metadata_json=? WHERE cafe_id='a' AND id='a-stage'",
    JSON.stringify({
      checks: f.checks,
      lastBackup: f.lastBackup,
      sourceVersion: f.sourceVersion,
      sourceControls: f.sourceControls,
    }),
  ).run();
  const sums = {
    sales: 110000,
    purchases: 28000,
    expenses: 5000,
    other_incomes: 3000,
    payroll_extras: 1000,
    sales_reconciliations: 999999,
  };
  for (const [table, total] of Object.entries(sums)) {
    const expression =
      table === "sales"
        ? "COALESCE(card,0)+COALESCE(cash,0)+COALESCE(transfer,0)"
        : table === "sales_reconciliations"
          ? "reported"
          : "amount";
    assert.equal(
      await scalar(
        db,
        `SELECT SUM(${expression}) FROM ${table} WHERE cafe_id='a' AND dataset_id='a-stage'`,
      ),
      total,
      table,
    );
  }
  assert.equal(
    await scalar(db, "SELECT card FROM sales WHERE id='sale-3'"),
    null,
  );
  assert.equal(await scalar(db, "SELECT card FROM sales WHERE id='sale-2'"), 0);
  assert.equal(
    await scalar(db, "SELECT confirmation FROM weekly_confirmations"),
    "개근·재직 확인",
  );
  assert.equal(
    await scalar(db, "SELECT hourly_rate FROM payroll_rates WHERE year=2027"),
    11000,
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM active_sales WHERE cafe_id='a'"),
    1,
  );
});

test("inventory purchase references and linked accounts cannot escape cafe/dataset", async (t) => {
  const db = await database(t);
  await seed(db);
  await stmt(
    db,
    "INSERT INTO purchases(cafe_id,dataset_id,id,business_date,item,amount,created_by,updated_by) VALUES ('b','b-live','foreign-purchase','2026-10-01','가상',1,'u2','u2')",
  ).run();
  await stmt(
    db,
    "INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('op','u1','a','a:inventory','key','hash')",
  ).run();
  await assert.rejects(
    stmt(
      db,
      "INSERT INTO inventory_movements(cafe_id,dataset_id,id,item_id,delta_hundredths,operation_id,purchase_id,kind,created_by,updated_by) VALUES ('a','a-live','bad','i1',1,'op','foreign-purchase','purchase','u1','u1')",
    ).run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    stmt(db, "UPDATE employees SET linked_user_id='u3' WHERE id='e1'").run(),
    /FOREIGN KEY/,
  );
});
