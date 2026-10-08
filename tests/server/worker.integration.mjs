import test from "node:test";
import assert from "node:assert/strict";
import { unstable_dev, unstable_readConfig } from "wrangler";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Wrangler environment configs never inherit local DB into remote test/production", () => {
  const local = unstable_readConfig({ config: "wrangler.toml" });
  assert.equal(local.vars.APP_ENV, "local");
  assert.equal(local.d1_databases[0].database_id, "local-only");
  assert.equal(local.d1_databases[0].remote, false);
  for (const env of ["test", "production"]) {
    const config = unstable_readConfig({ config: "wrangler.toml", env });
    assert.equal(config.vars.APP_ENV, env);
    assert.deepEqual(config.d1_databases, []);
    assert.equal(config.preview_urls, false);
    assert.equal(config.workers_dev, false);
  }
});

test(
  "actual Workers Static Assets routing: app, hashed assets, SPA fallback and reserved API/auth",
  { timeout: 60000 },
  async (t) => {
    const persistTo = await mkdtemp(join(tmpdir(), "cafe-w04-routing-"));
    t.after(() => rm(persistTo, { recursive: true, force: true }));
    const worker = await unstable_dev("src/server/index.ts", {
      config: "wrangler.toml",
      local: true,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      persistTo,
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    });
    t.after(() => worker.stop());
    const home = await worker.fetch("/");
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<!doctype html>/i);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    const script = await worker.fetch(asset);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    const fallback = await worker.fetch("/future-client-route", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    assert.equal(fallback.status, 200);
    for (const path of [
      "/api",
      "/api/v1/cafes",
      "/auth",
      "/auth/google/start",
    ]) {
      const response = await worker.fetch(path, {
        headers: { "Sec-Fetch-Mode": "navigate" },
      });
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal((await response.json()).error.code, "NOT_FOUND");
    }
  },
);
