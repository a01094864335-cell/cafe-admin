import test from "node:test";
import assert from "node:assert/strict";
import { database, seed, stmt, scalar } from "./helpers.mjs";
import { randomToken, hash } from "../../src/server/auth/crypto.ts";
import worker from "../../src/server/index.ts";
import { setup, ok } from "./api-helpers.mjs";

test("two cafes expose current per-cafe roles and deny staff/nonmembers member data", async (t) => {
  const { request } = await setup(t);
  const cafes = ok(await request("u1", "/api/v1/cafes"));
  assert.deepEqual(
    cafes.map((c) => [c.id, c.role]),
    [
      ["a", "owner"],
      ["b", "staff"],
    ],
  );
  assert.equal((await request("u3", "/api/v1/cafes/a")).status, 404);
  assert.equal((await request("u1", "/api/v1/cafes/b/members")).status, 403);
  assert.equal(ok(await request("u2", "/api/v1/cafes/a/members")).length, 2);
});

test("cafe creation defaults deny, validates timezone and atomically replays one authorized creation", async (t) => {
  const { request, db, env } = await setup(t),
    key = randomToken(),
    payload = { name: "가상 신규", timezone: "Asia/Seoul" };
  assert.equal(
    (await request("u2", "/api/v1/cafes", "POST", payload)).status,
    403,
  );
  env.CAFE_CREATOR_IDS = "";
  assert.equal(
    (await request("u1", "/api/v1/cafes", "POST", payload)).status,
    403,
  );
  env.CAFE_CREATOR_IDS = "u1";
  assert.equal(
    (
      await request("u1", "/api/v1/cafes", "POST", {
        ...payload,
        timezone: "Invalid/Zone",
      })
    ).status,
    400,
  );
  const result = ok(
    await request("u1", "/api/v1/cafes", "POST", payload, key),
    201,
  );
  assert.equal(
    ok(await request("u1", "/api/v1/cafes", "POST", payload, key), 201).id,
    result.id,
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM cafes"), 3);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM memberships WHERE cafe_id=? AND role='owner' AND status='active'",
      result.id,
    ),
    1,
  );
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes",
        "POST",
        { ...payload, name: "다른" },
        key,
      )
    ).body.error.code,
    "IDEMPOTENCY_MISMATCH",
  );
  assert.equal(
    await scalar(db, "SELECT count(*) FROM transaction_assertions"),
    0,
  );
});

test("member authority, stale versions and revocation apply to the next request and replay", async (t) => {
  const { request, db } = await setup(t);
  assert.equal(
    (
      await request("u2", "/api/v1/cafes/a/members/u1", "PATCH", {
        role: "staff",
        expectedVersion: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/members/u1", "DELETE", {
        expectedVersion: 1,
      })
    ).status,
    403,
  );
  const before = await scalar(db, "SELECT count(*) FROM commands");
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/members/u2", "PATCH", {
        role: "staff",
        expectedVersion: 99,
      })
    ).status,
    409,
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM commands"), before);
  ok(
    await request("u1", "/api/v1/cafes/a/members/u2", "PATCH", {
      role: "staff",
      expectedVersion: 1,
    }),
  );
  assert.equal((await request("u2", "/api/v1/cafes/a/members")).status, 403);
  const key = randomToken();
  ok(
    await request(
      "u1",
      "/api/v1/cafes/a",
      "PATCH",
      { name: "수정", timezone: "Asia/Seoul", expectedVersion: 1 },
      key,
    ),
  );
  ok(
    await request("u1", "/api/v1/cafes/a/members/u2", "DELETE", {
      expectedVersion: 2,
    }),
  );
  assert.equal((await request("u2", "/api/v1/cafes/a")).status, 404);
  assert.equal(ok(await request("u2", "/api/v1/cafes")).length, 1);
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/a",
        "PATCH",
        { name: "수정", timezone: "Asia/Seoul", expectedVersion: 1 },
        key,
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
});

test("ownership transfer rejects lock/missing member and concurrent replay preserves one owner", async (t) => {
  const { request, db } = await setup(t);
  await stmt(db, "UPDATE cafes SET write_mode='import' WHERE id='a'").run();
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/ownership-transfer", "POST", {
        userId: "u2",
        expectedVersion: 1,
      })
    ).body.error.code,
    "CAFE_WRITE_LOCKED",
  );
  await stmt(db, "UPDATE cafes SET write_mode='open' WHERE id='a'").run();
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a/ownership-transfer", "POST", {
        userId: "u3",
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    await scalar(db, "SELECT role FROM memberships WHERE id='ma1'"),
    "owner",
  );
  const key = randomToken(),
    payload = { userId: "u2", expectedVersion: 1 };
  const responses = await Promise.all([
    request("u1", "/api/v1/cafes/a/ownership-transfer", "POST", payload, key),
    request("u1", "/api/v1/cafes/a/ownership-transfer", "POST", payload, key),
  ]);
  assert.ok(responses.some((r) => r.status === 200));
  responses.forEach((r) =>
    assert.ok([200, 403].includes(r.status), JSON.stringify(r.body)),
  );
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/a/ownership-transfer",
        "POST",
        payload,
        key,
      )
    ).status,
    403,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM memberships WHERE cafe_id='a' AND role='owner' AND status='active'",
    ),
    1,
  );
  assert.equal(
    await scalar(db, "SELECT role FROM memberships WHERE id='ma1'"),
    "admin",
  );
  assert.equal(
    (
      await request("u1", "/api/v1/cafes/a", "PATCH", {
        name: "no",
        timezone: "Asia/Seoul",
        expectedVersion: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM commands WHERE scope LIKE '%ownership-transfer'",
    ),
    1,
  );
});

test("invitation enforces email, verified account, one-time concurrent acceptance and token hashes only", async (t) => {
  const { request, db } = await setup(t);
  assert.equal(
    (
      await request("u2", "/api/v1/cafes/a/invitations", "POST", {
        email: "staff@example.invalid",
        role: "admin",
      })
    ).status,
    403,
  );
  const key = randomToken();
  const invite = ok(
    await request(
      "u1",
      "/api/v1/cafes/a/invitations",
      "POST",
      { email: "staff@example.invalid", role: "staff" },
      key,
    ),
    201,
  );
  assert.equal(
    ok(
      await request(
        "u1",
        "/api/v1/cafes/a/invitations",
        "POST",
        { email: "staff@example.invalid", role: "staff" },
        key,
      ),
      201,
    ).token,
    invite.token,
  );
  const path = "/api/v1/invitations/" + invite.token;
  assert.equal((await request("u2", path)).status, 403);
  assert.equal((await request("u3", path)).status, 403);
  await stmt(db, "UPDATE users SET email_verified=1 WHERE id='u3'").run();
  ok(await request("u3", path));
  const acceptKey = randomToken();
  const results = await Promise.all([
    request("u3", path + "/accept", "POST", undefined, acceptKey),
    request("u3", path + "/accept", "POST", undefined, acceptKey),
  ]);
  results.forEach((r) => ok(r));
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) FROM memberships WHERE cafe_id='a' AND user_id='u3'",
    ),
    1,
  );
  assert.equal((await request("u3", path + "/accept", "POST")).status, 409);
  const commands = JSON.stringify(
    (await db.prepare("SELECT * FROM commands").all()).results,
  );
  assert.equal(commands.includes(invite.token), false);
  assert.equal(
    await scalar(
      db,
      "SELECT token_hash FROM invitations WHERE id=?",
      invite.id,
    ),
    await hash(invite.token),
  );
  const v = await scalar(
    db,
    "SELECT version FROM memberships WHERE cafe_id='a' AND user_id='u3'",
  );
  ok(
    await request("u1", "/api/v1/cafes/a/members/u3", "DELETE", {
      expectedVersion: v,
    }),
  );
  assert.equal(
    (await request("u3", path + "/accept", "POST", undefined, acceptKey))
      .status,
    404,
  );
});

test("invitation expires/cancels and rechecks inviter current authority", async (t) => {
  const { request, db } = await setup(t);
  await stmt(db, "UPDATE users SET email_verified=1 WHERE id='u3'").run();
  async function invite() {
    return ok(
      await request("u2", "/api/v1/cafes/a/invitations", "POST", {
        email: "staff@example.invalid",
        role: "staff",
      }),
      201,
    );
  }
  const expired = await invite();
  await stmt(
    db,
    "UPDATE invitations SET expires_at='2000-01-01' WHERE id=?",
    expired.id,
  ).run();
  assert.equal(
    (
      await request(
        "u3",
        "/api/v1/invitations/" + expired.token + "/accept",
        "POST",
      )
    ).status,
    404,
  );
  const cancelled = await invite();
  ok(
    await request(
      "u2",
      "/api/v1/cafes/a/invitations/" + cancelled.id,
      "DELETE",
    ),
  );
  assert.equal(
    (
      await request(
        "u3",
        "/api/v1/invitations/" + cancelled.token + "/accept",
        "POST",
      )
    ).status,
    404,
  );
  const stale = await invite();
  ok(
    await request("u1", "/api/v1/cafes/a/members/u2", "PATCH", {
      role: "staff",
      expectedVersion: 1,
    }),
  );
  assert.equal(
    (
      await request(
        "u3",
        "/api/v1/invitations/" + stale.token + "/accept",
        "POST",
      )
    ).status,
    404,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT consumed_by FROM invitations WHERE id=?",
      stale.id,
    ),
    null,
  );
});

test("membership lists paginate without truncation and bind cursors to actor/cafe", async (t) => {
  const { request } = await setup(t);
  const first = await request("u1", "/api/v1/cafes?limit=1");
  ok(first);
  assert.equal(first.body.data.length, 1);
  assert.ok(first.body.nextCursor);
  const second = await request(
    "u1",
    "/api/v1/cafes?limit=1&cursor=" + encodeURIComponent(first.body.nextCursor),
  );
  ok(second);
  assert.equal(second.body.data[0].id, "b");
  assert.equal(second.body.nextCursor, null);
  assert.equal(
    (
      await request(
        "u2",
        "/api/v1/cafes?cursor=" + encodeURIComponent(first.body.nextCursor),
      )
    ).status,
    400,
  );
  assert.equal((await request("u1", "/api/v1/cafes?limit=101")).status, 400);
  const members = await request("u1", "/api/v1/cafes/a/members?limit=1");
  ok(members);
  assert.ok(members.body.nextCursor);
  const more = await request(
    "u1",
    "/api/v1/cafes/a/members?cursor=" +
      encodeURIComponent(members.body.nextCursor),
  );
  ok(more);
  assert.equal(more.body.data[0].userId, "u2");
});

test("untrusted actor fields, malformed bodies and oversized payloads are rejected without commands", async (t) => {
  const { request, db, env, sessions } = await setup(t);
  assert.equal(
    (await request("u1", "/api/v1/cafes", "POST", { name: "x", userId: "u2" }))
      .status,
    400,
  );
  assert.equal(
    (await request("u1", "/api/v1/cafes", "POST", { name: "x".repeat(17000) }))
      .status,
    413,
  );
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes",
        "POST",
        { name: "x" },
        randomToken(),
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  const response = await worker.fetch(
    new Request(env.APP_ORIGIN + "/api/v1/cafes", {
      method: "POST",
      headers: {
        Cookie: "__Host-session=" + sessions.u1.token,
        Origin: env.APP_ORIGIN,
        "X-CSRF-Token": sessions.u1.csrf,
        "Content-Type": "application/json",
      },
      body: '{"name":',
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(await scalar(db, "SELECT count(*) FROM commands"), 0);
});

test("expired/revoked sessions and missing CSRF cannot mutate cafes", async (t) => {
  const { request, db, sessions } = await setup(t);
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes",
        "POST",
        { name: "x" },
        randomToken(),
        { "X-CSRF-Token": "" },
      )
    ).status,
    403,
  );
  await stmt(
    db,
    "UPDATE sessions SET revoked_at=? WHERE token_hash=?",
    new Date().toISOString(),
    await hash(sessions.u1.token),
  ).run();
  assert.equal(
    (await request("u1", "/api/v1/cafes", "POST", { name: "x" })).status,
    401,
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM commands"), 0);
});
