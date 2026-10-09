import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/server/index.ts";
import { createApi } from "../../src/client/cloud/http.js";

test("D1 overload yields request ID/Retry-After and logs no URL, token, SQL or PII", async () => {
  const logs = [],
    old = console.warn;
  console.warn = (x) => logs.push(x);
  try {
    const response = await worker.fetch(
      new Request("https://cafe.invalid/api/v1/me?private=secret", {
        headers: {
          Cookie: "__Host-session=" + "a".repeat(43),
          "X-Request-ID": "ATTACKER-ID",
        },
      }),
      {
        DB: {
          prepare() {
            throw Error(
              "D1_ERROR: database overloaded PRIVATE_EMAIL secret SQL",
            );
          },
        },
      },
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    const data = await response.json();
    assert.equal(data.requestId, response.headers.get("X-Request-ID"));
    assert.equal(data.error.code, "TEMPORARILY_UNAVAILABLE");
    assert.doesNotMatch(
      logs.join(" ") + JSON.stringify(data),
      /PRIVATE|secret|SQL|ATTACKER|https|Cookie/,
    );
    assert.equal(JSON.parse(logs[0]).requestId, data.requestId);
  } finally {
    console.warn = old;
  }
});

test("HTML quota response preserves write key, throttles client calls and never auto-retries", async () => {
  let time = 0,
    calls = 0;
  const keys = [];
  const api = createApi({
    csrfToken: () => "csrf",
    messages: { RATE_LIMITED: "요청 제한" },
    now: () => time,
    fetcher: async (_path, init) => {
      calls++;
      keys.push(init.headers["Idempotency-Key"]);
      return calls === 1
        ? new Response("<html>PRIVATE</html>", {
            status: 429,
            headers: { "Retry-After": "60" },
          })
        : Response.json({ data: { saved: true } });
    },
  });
  const write = () =>
    api("/api/v1/cafes/a/sales", {
      method: "POST",
      data: { card: 1 },
      key: "same-retry-key",
    });
  await assert.rejects(write, { code: "RATE_LIMITED", message: "요청 제한" });
  await assert.rejects(write, { code: "RATE_LIMITED" });
  assert.equal(calls, 1);
  time = 61000;
  assert.equal((await write()).data.saved, true);
  assert.equal(calls, 2);
  assert.deepEqual(keys, ["same-retry-key", "same-retry-key"]);
});
