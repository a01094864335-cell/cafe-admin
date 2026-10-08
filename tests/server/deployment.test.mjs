import test from "node:test";
import assert from "node:assert/strict";
import { deploymentConfig } from "./deployment-config.mjs";

test("deployment stays unconfigured without distinct provisioned DB IDs and an explicit target", () => {
  assert.throws(() => deploymentConfig({}));
  const env = {
    DEPLOY_TARGET: "test",
    APP_ORIGIN: "https://synthetic.example.invalid",
    GOOGLE_CLIENT_ID: "synthetic-client",
    D1_DATABASE_ID: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    OTHER_D1_DATABASE_ID: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    D1_DATABASE_NAME: "synthetic-test-only",
  };
  assert.throws(() =>
    deploymentConfig({ ...env, OTHER_D1_DATABASE_ID: env.D1_DATABASE_ID }),
  );
  assert.throws(() =>
    deploymentConfig({
      ...env,
      OTHER_D1_DATABASE_ID: env.D1_DATABASE_ID.toUpperCase(),
    }),
  );
  assert.throws(() => deploymentConfig({ ...env, DEPLOY_TARGET: "preview" }));
  assert.throws(() =>
    deploymentConfig({
      ...env,
      APP_ORIGIN: "http://synthetic.example.invalid",
    }),
  );
  assert.throws(() => deploymentConfig({ ...env, GOOGLE_CLIENT_ID: "" }));
  const config = deploymentConfig(env);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].database_id, env.D1_DATABASE_ID);
  assert.equal(config.vars.APP_ENV, "test");
  assert.equal(config.preview_urls, false);
});
