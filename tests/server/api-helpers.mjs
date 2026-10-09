import assert from "node:assert/strict";
import { database, seed, stmt } from "./helpers.mjs";
import { randomToken, hash } from "../../src/server/auth/crypto.ts";
import worker from "../../src/server/index.ts";
export async function setup(t) {
  const db = await database(t);
  await seed(db);
  const env = {
    DB: db,
    APP_ENV: "test",
    APP_ORIGIN: "https://cafe.example.invalid",
    INVITATION_TOKEN_KEY: randomToken(),
  };
  const sessions = {};
  for (const id of ["u1", "u2", "u3"]) {
    const token = randomToken(),
      csrf = randomToken();
    sessions[id] = { token, csrf };
    await stmt(
      db,
      "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES (?,?,?,?)",
      await hash(token),
      id,
      await hash(csrf),
      new Date(Date.now() + 86400000).toISOString(),
    ).run();
  }
  async function request(
    id,
    path,
    method = "GET",
    data = undefined,
    key = randomToken(),
    headers = {},
  ) {
    const session = sessions[id];
    const result = await worker.fetch(
      new Request(env.APP_ORIGIN + path, {
        method,
        headers: {
          Cookie: "__Host-session=" + session.token,
          Origin: env.APP_ORIGIN,
          "X-CSRF-Token": session.csrf,
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          "Idempotency-Key": key,
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      env,
    );
    return { status: result.status, body: await result.json() };
  }
  return { db, env, request, sessions };
}
export function ok(r, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body.data;
}
