import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/server/index.ts";

test("API/auth roots and unknown nested routes return no-store JSON without touching DB/assets", async () => {
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("unexpected binding access");
      },
    },
  );
  for (const path of ["/api", "/api/", "/api/missing", "/auth"]) {
    const response = await worker.fetch(
      new Request("https://example.invalid" + path),
      env,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.ok(body.requestId);
  }
});
test("static paths including similar non-API prefixes reach asset binding", async () => {
  for (const path of ["/", "/assets/app.js", "/apiary", "/authentication"]) {
    let actual;
    const response = await worker.fetch(
      new Request("https://example.invalid" + path),
      {
        ASSETS: {
          fetch(req) {
            actual = new URL(req.url).pathname;
            return new Response("asset");
          },
        },
      },
    );
    assert.equal(actual, path);
    assert.equal(await response.text(), "asset");
  }
});
