import test from "node:test";
import assert from "node:assert/strict";
import { database, seed, stmt, scalar } from "./helpers.mjs";
import { authRoute } from "../../src/server/auth/routes.ts";
import { hash, randomToken } from "../../src/server/auth/crypto.ts";
import worker from "../../src/server/index.ts";

const config = (db) => ({
  DB: db,
  APP_ORIGIN: "https://cafe.example.invalid",
  GOOGLE_CLIENT_ID: "synthetic-client",
  GOOGLE_CLIENT_SECRET: "synthetic-secret",
  APP_ENV: "test",
});
const cookieValue = (response, name) =>
  response.headers
    .getSetCookie()
    .find((x) => x.startsWith(name + "="))
    .split(";")[0];
async function begin(env) {
  const response = await authRoute(
    new Request(env.APP_ORIGIN + "/auth/google/start"),
    env,
    "test",
  );
  const params = new URL(response.headers.get("Location")).searchParams;
  return {
    response,
    params,
    cookie: cookieValue(response, "__Host-oauth"),
    url:
      env.APP_ORIGIN +
      "/auth/google/callback?" +
      new URLSearchParams({
        state: params.get("state"),
        code: "synthetic-code",
      }),
  };
}

test("OAuth state/browser/nonce/PKCE and one-use callback create secure hashed session", async (t) => {
  const db = await database(t),
    env = config(db),
    flow = await begin(env);
  assert.equal(flow.params.get("code_challenge_method"), "S256");
  assert.equal(
    flow.params.get("redirect_uri"),
    env.APP_ORIGIN + "/auth/google/callback",
  );
  assert.match(
    flow.response.headers.get("Set-Cookie"),
    /Secure; SameSite=Lax; HttpOnly/,
  );
  let calls = 0;
  const provider = {
    async exchange(code, verifier, redirect, nonce) {
      calls++;
      assert.equal(code, "synthetic-code");
      assert.equal(await hash(verifier), flow.params.get("code_challenge"));
      assert.equal(nonce, flow.params.get("nonce"));
      assert.equal(redirect, flow.params.get("redirect_uri"));
      return { subject: "google-a", email: "a@example.invalid", name: "가상" };
    },
  };
  await assert.rejects(
    authRoute(
      new Request(flow.url, {
        headers: { Cookie: "__Host-oauth=" + randomToken() },
      }),
      env,
      "test",
      provider,
    ),
    (e) => e.status === 401,
  );
  const response = await authRoute(
    new Request(flow.url, { headers: { Cookie: flow.cookie } }),
    env,
    "test",
    provider,
  );
  assert.equal(response.status, 302);
  assert.equal(calls, 1);
  const session = cookieValue(response, "__Host-session"),
    csrf = cookieValue(response, "__Host-csrf");
  const token = session.split("=")[1];
  assert.equal(
    await scalar(db, "SELECT token_hash FROM sessions"),
    await hash(token),
  );
  assert.notEqual(
    await scalar(db, "SELECT csrf_hash FROM sessions"),
    csrf.split("=")[1],
  );
  assert.match(
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-session=")),
    /Max-Age=604800; Secure; SameSite=Lax; HttpOnly/,
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM users"), 1);
  await assert.rejects(
    authRoute(
      new Request(flow.url, { headers: { Cookie: flow.cookie } }),
      env,
      "test",
      provider,
    ),
    (e) => e.status === 401,
  );
  assert.equal(calls, 1);
  const me = await worker.fetch(
    new Request(env.APP_ORIGIN + "/api/v1/me", {
      headers: { Cookie: session + "; " + csrf },
    }),
    env,
  );
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.csrfToken, csrf.split("=")[1]);
  const wrong = await worker.fetch(
    new Request(env.APP_ORIGIN + "/auth/logout", {
      method: "POST",
      headers: {
        Cookie: session,
        Origin: "https://evil.invalid",
        "X-CSRF-Token": csrf.split("=")[1],
      },
    }),
    env,
  );
  assert.equal(wrong.status, 403);
  const logout = await worker.fetch(
    new Request(env.APP_ORIGIN + "/auth/logout", {
      method: "POST",
      headers: {
        Cookie: session,
        Origin: env.APP_ORIGIN,
        "X-CSRF-Token": csrf.split("=")[1],
      },
    }),
    env,
  );
  assert.equal(logout.status, 200);
  assert.equal(
    (
      await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/v1/me", {
          headers: { Cookie: session },
        }),
        env,
      )
    ).status,
    401,
  );
});

test("Google subject is identity: same email never merges distinct identities and repeated subject reuses account", async (t) => {
  const db = await database(t),
    env = config(db);
  for (const subject of ["one", "two", "one"]) {
    const flow = await begin(env);
    await authRoute(
      new Request(flow.url, { headers: { Cookie: flow.cookie } }),
      env,
      "test",
      {
        async exchange() {
          return { subject, email: "same@example.invalid", name: subject };
        },
      },
    );
  }
  assert.equal(await scalar(db, "SELECT count(*) FROM users"), 2);
  assert.equal(await scalar(db, "SELECT count(*) FROM auth_identities"), 2);
});

test("expired OAuth, provider failure and expired/revoked session fail closed", async (t) => {
  const db = await database(t),
    env = config(db),
    flow = await begin(env);
  await stmt(
    db,
    "UPDATE oauth_transactions SET expires_at='2000-01-01T00:00:00Z'",
  ).run();
  await assert.rejects(
    authRoute(
      new Request(flow.url, { headers: { Cookie: flow.cookie } }),
      env,
      "test",
      {
        async exchange() {
          throw Error("must not call");
        },
      },
    ),
    (e) => e.status === 401,
  );
  const next = await begin(env);
  await assert.rejects(
    authRoute(
      new Request(next.url, { headers: { Cookie: next.cookie } }),
      env,
      "test",
      {
        async exchange() {
          throw Error("synthetic provider failure");
        },
      },
    ),
  );
  assert.equal(await scalar(db, "SELECT count(*) FROM sessions"), 0);
  await seed(db);
  const token = randomToken();
  await stmt(
    db,
    "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES (?,'u1','hash','2000-01-01T00:00:00Z')",
    await hash(token),
  ).run();
  assert.equal(
    (
      await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/v1/me", {
          headers: { Cookie: "__Host-session=" + token },
        }),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(new Request(env.APP_ORIGIN + "/auth/google/start"), {
        DB: db,
        APP_ENV: "production",
      })
    ).status,
    503,
  );
});
