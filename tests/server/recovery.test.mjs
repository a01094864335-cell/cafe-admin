import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("offline full DB and individual cafe recovery rehearsal", () => {
  const result = spawnSync("python3", ["tests/recovery_test.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
