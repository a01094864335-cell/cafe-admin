import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import { scalar, stmt } from "./helpers.mjs";
import { randomToken } from "../../src/server/auth/crypto.ts";
const base = "/api/v1/cafes/b/";
test("staff work is resolved by authenticated linkage; other employees, payroll and cafes stay private", async (t) => {
  const { request } = await setup(t);
  assert.equal(
    (await request("u1", base + "my/work-logs")).body.error.code,
    "EMPLOYEE_NOT_LINKED",
  );
  const employee = ok(
    await request("u2", base + "employees", "POST", {
      name: "연결 직원",
      linkedUserId: "u1",
    }),
    201,
  );
  const unlinked = ok(
    await request("u2", base + "employees", "POST", { name: "계정 없는 직원" }),
    201,
  );
  assert.equal(unlinked.linkedUserId, null);
  const mine = ok(
    await request("u1", base + "my/work-logs", "POST", {
      businessDate: "2026-10-08",
      startTime: "22:00",
      endTime: "02:00",
      breakMinutes: 30,
    }),
    201,
  );
  assert.equal(mine.employeeId, employee.id);
  assert.equal(
    (
      await request("u1", base + "my/work-logs", "POST", {
        employeeId: unlinked.id,
        businessDate: "2026-10-09",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("u1", base + "my/work-logs?employeeId=" + unlinked.id))
      .status,
    400,
  );
  const other = ok(
    await request("u2", base + "work-logs", "POST", {
      employeeId: unlinked.id,
      businessDate: "2026-10-08",
      startTime: "09:00",
      endTime: "18:00",
    }),
    201,
  );
  assert.equal(
    (await request("u1", base + "my/work-logs/" + other.id)).status,
    404,
  );
  assert.equal((await request("u1", base + "work-logs")).status, 403);
  assert.equal((await request("u1", base + "employees")).status, 403);
  assert.equal(ok(await request("u1", base + "my/work-logs")).length, 1);
  assert.equal(ok(await request("u2", base + "work-logs")).length, 2);
  ok(
    await request("u1", base + "my/work-logs/" + mine.id, "PATCH", {
      expectedVersion: 1,
      endTime: "03:00",
    }),
  );
  assert.equal(
    (
      await request("u1", base + "my/work-logs/" + mine.id, "PATCH", {
        expectedVersion: 1,
        endTime: "04:00",
      })
    ).status,
    409,
  );
  ok(
    await request("u2", base + "employees/" + employee.id, "PATCH", {
      linkedUserId: null,
      expectedVersion: 1,
    }),
  );
  assert.equal((await request("u1", base + "my/work-logs")).status, 403);
  assert.equal(
    ok(await request("u2", base + "work-logs/" + mine.id)).endTime,
    "03:00",
  );
});
test("employee links require active same-cafe membership and work references cannot cross datasets", async (t) => {
  const { request, db } = await setup(t);
  for (const linkedUserId of ["u3", "missing"])
    assert.equal(
      (
        await request("u2", base + "employees", "POST", {
          name: "invalid",
          linkedUserId,
        })
      ).status,
      409,
    );
  assert.equal(
    (
      await request("u2", base + "work-logs", "POST", {
        employeeId: "e1",
        businessDate: "2026-10-08",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/work-logs", "POST", {
        employeeId: "e3",
        businessDate: "2026-10-08",
      })
    ).status,
    404,
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM work_logs"), 0);
  const key = randomToken(),
    input = { employeeId: "e2", businessDate: "2026-10-08" };
  const log = ok(
    await request("u2", base + "work-logs", "POST", input, key),
    201,
  );
  assert.equal(
    ok(await request("u2", base + "work-logs", "POST", input, key), 201).id,
    log.id,
  );
  for (const patch of [
    { startTime: "25:00" },
    { breakMinutes: -1 },
    { businessDate: "2026-02-30" },
  ])
    assert.equal(
      (
        await request("u2", base + "work-logs/" + log.id, "PATCH", {
          expectedVersion: 1,
          ...patch,
        })
      ).status,
      400,
    );
  await stmt(
    db,
    "UPDATE memberships SET status='inactive' WHERE cafe_id='b' AND user_id='u1'",
  ).run();
  assert.equal(
    (
      await request("u2", base + "employees", "POST", {
        name: "inactive",
        linkedUserId: "u1",
      })
    ).status,
    409,
  );
});
