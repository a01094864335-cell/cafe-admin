import test from "node:test";
import assert from "node:assert/strict";
import { setup, ok } from "./api-helpers.mjs";
import {
  encryptToken,
  decryptToken,
  syncCafe,
  sheetRequests,
} from "../../src/server/services/google-sheets.ts";
import { scalar } from "./helpers.mjs";

async function linked(db, env) {
  await db
    .prepare(
      "INSERT INTO google_sheet_links(cafe_id,owner_id,spreadsheet_id,refresh_cipher,requested_revision) VALUES (?,?,?,?,?)",
    )
    .bind(
      "a",
      "u1",
      "test-sheet",
      await encryptToken(env, "a", "test-refresh"),
      0,
    )
    .run();
}
test("sheet connections require owner, CSRF and use narrow offline OAuth", async (t) => {
  const { request, env, db } = await setup(t);
  env.GOOGLE_CLIENT_ID = "test";
  env.GOOGLE_CLIENT_SECRET = "secret";
  assert.equal(
    (await request("u2", "/api/v1/cafes/a/google-sheet")).status,
    403,
  );
  assert.equal(
    (
      await request(
        "u1",
        "/api/v1/cafes/a/google-sheet/connect",
        "POST",
        {},
        undefined,
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  const connected = ok(
    await request("u1", "/api/v1/cafes/a/google-sheet/connect", "POST", {}),
  );
  const url = new URL(connected.url);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(
    url.searchParams.get("scope"),
    "openid email profile https://www.googleapis.com/auth/drive.file",
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM google_sheet_oauth"), 1);
  await linked(db, env);
  const state = ok(await request("u1", "/api/v1/cafes/a/google-sheet"));
  assert.equal(state.connected, true);
  assert.equal(state.refresh_cipher, undefined);
  ok(
    await request("u1", "/api/v1/cafes/a/google-sheet/disconnect", "POST", {}),
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM google_sheet_links"), 0);
  assert.equal(await scalar(db, "SELECT count(*) FROM google_sheet_oauth"), 0);
});
test("encrypted token is bound to cafe; trigger queues committed revisions only", async (t) => {
  const { db, env } = await setup(t);
  const cipher = await encryptToken(env, "a", "secret");
  assert.equal(await decryptToken(env, "a", cipher), "secret");
  await assert.rejects(decryptToken(env, "b", cipher));
  await linked(db, env);
  await db.prepare("UPDATE cafes SET revision=revision+1 WHERE id='a'").run();
  assert.equal(
    await scalar(
      db,
      "SELECT requested_revision FROM google_sheet_links WHERE cafe_id='a'",
    ),
    1,
  );
  await assert.rejects(
    db.batch([
      db.prepare("UPDATE cafes SET revision=revision+1 WHERE id='a'"),
      db.prepare("INSERT INTO transaction_assertions(id,ok) VALUES ('bad',0)"),
    ]),
  );
  assert.equal(
    await scalar(
      db,
      "SELECT requested_revision FROM google_sheet_links WHERE cafe_id='a'",
    ),
    1,
  );
});
test("snapshot writes 14 tabs with explicit strings, excludes other datasets, clears deleted rows, and queues overlapping revision", async (t) => {
  const { db, env } = await setup(t);
  await linked(db, env);
  let writes = 0,
    payload;
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/token"))
      return Response.json({ access_token: "fake" });
    writes++;
    payload = JSON.parse(init.body);
    await db.prepare("UPDATE cafes SET revision=revision+1 WHERE id='a'").run();
    return Response.json({});
  };
  await Promise.all([syncCafe(env, "a"), syncCafe(env, "a")]);
  assert.equal(writes, 1);
  const updates = payload.requests
    .filter((r) => r.updateCells)
    .map((r) => r.updateCells);
  assert.equal(updates.length, 14);
  assert.deepEqual(updates[1].rows[1].values[1].userEnteredValue, {
    numberValue: 100000,
  });
  assert.equal(updates[1].rows.length, 2);
  assert.deepEqual(updates[1].range, { sheetId: 1 });
  const link = await db
    .prepare("SELECT * FROM google_sheet_links WHERE cafe_id='a'")
    .first();
  assert.equal(link.synced_revision, 0);
  assert.equal(link.requested_revision, 1);
  await db
    .prepare("UPDATE sales SET deleted_at='2026-11-01' WHERE cafe_id='a'")
    .run();
  await syncCafe(env, "a");
  assert.equal(
    payload.requests.filter((r) => r.updateCells)[1].updateCells.rows.length,
    1,
  );
  const formula = sheetRequests([
    { name: "test", rows: [["header"], ['=IMPORTXML("x")']] },
  ]);
  assert.deepEqual(formula[1].updateCells.rows[1].values[0].userEnteredValue, {
    stringValue: '=IMPORTXML("x")',
  });
});
test("Google failure preserves pending work and backs off; changed owner sends no data", async (t) => {
  const { db, env } = await setup(t);
  await linked(db, env);
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 });
  await syncCafe(env, "a");
  const link = await db
    .prepare("SELECT * FROM google_sheet_links WHERE cafe_id='a'")
    .first();
  assert.equal(link.error, "RECONNECT_REQUIRED");
  assert.equal(link.synced_revision, -1);
  assert.ok(link.retry_at > Date.now());
  await db
    .prepare(
      "UPDATE google_sheet_links SET lease_until=0,retry_at=0 WHERE cafe_id='a'",
    )
    .run();
  await db.prepare("UPDATE memberships SET role='admin' WHERE id='ma1'").run();
  globalThis.fetch = async () => {
    throw new Error("must not contact Google");
  };
  await syncCafe(env, "a");
  assert.equal(
    await scalar(db, "SELECT error FROM google_sheet_links WHERE cafe_id='a'"),
    "OWNER_CHANGED",
  );
});

test("callback consumes browser-bound state, persists encrypted tokens, and reconnects the same spreadsheet", async (t) => {
  const { db, env, sessions } = await setup(t);
  const { sheetsRoute, sheetsCallback } =
    await import("../../src/server/routes/google-sheets.ts");
  env.GOOGLE_CLIENT_ID = "test";
  env.GOOGLE_CLIENT_SECRET = "secret";
  await db
    .prepare(
      "INSERT INTO auth_identities(provider,subject,user_id) VALUES ('google','subject-u1','u1')",
    )
    .run();
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let created = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/token"))
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        id_token: "test-jwt",
        scope: "https://www.googleapis.com/auth/drive.file",
      });
    created++;
    return Response.json({ spreadsheetId: "created-sheet" });
  };
  const verify = async () => ({
    subject: "subject-u1",
    email: "owner@example.invalid",
    name: "owner",
  });
  async function flow() {
    const response = await sheetsRoute(
      new Request(env.APP_ORIGIN + "/api/v1/cafes/a/google-sheet/connect", {
        method: "POST",
        headers: {
          Cookie: "__Host-session=" + sessions.u1.token,
          Origin: env.APP_ORIGIN,
          "X-CSRF-Token": sessions.u1.csrf,
        },
      }),
      env,
      "test",
    );
    const state = new URL((await response.json()).data.url).searchParams.get(
      "state",
    );
    return new Request(
      env.APP_ORIGIN +
        "/auth/google/callback?state=" +
        state +
        "&code=synthetic",
      {
        headers: {
          Cookie:
            response.headers.get("Set-Cookie").split(";")[0] +
            "; __Host-session=" +
            sessions.u1.token,
        },
      },
    );
  }
  const req = await flow();
  const response = await sheetsCallback(req, env, verify);
  assert.match(response.headers.get("Location"), /sheet=connected/);
  assert.equal(created, 1);
  const link = await db
    .prepare("SELECT * FROM google_sheet_links WHERE cafe_id='a'")
    .first();
  assert.notEqual(link.refresh_cipher, "refresh");
  assert.equal(await decryptToken(env, "a", link.refresh_cipher), "refresh");
  assert.equal(await sheetsCallback(req, env, verify), null);
  assert.match(
    (await sheetsCallback(await flow(), env, verify)).headers.get("Location"),
    /sheet=connected/,
  );
  assert.equal(created, 1);
  const mismatch = await flow();
  assert.match(
    (
      await sheetsCallback(mismatch, env, async () => ({
        subject: "another",
        email: "x@example.invalid",
        name: "x",
      }))
    ).headers.get("Location"),
    /sheet=failed/,
  );
  assert.equal(created, 1);
});
