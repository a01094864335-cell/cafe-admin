import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalRepository,
  LEDGER_KEY,
} from "../src/client/data/local-repository.ts";
import { seed } from "../src/shared/seed.js";
function memory(initial) {
  const values = new Map(initial ? [[LEDGER_KEY, initial]] : []);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
test("existing v2 JSON round-trips and saving does not mutate the input", () => {
  const db = seed();
  db.store = "가상 카페";
  const storage = memory(JSON.stringify(db)),
    repo = createLocalRepository(() => storage);
  assert.equal(repo.load().data.store, "가상 카페");
  const before = JSON.stringify(db);
  repo.save(db);
  assert.equal(JSON.stringify(db), before);
  assert.equal(storage.values.get(LEDGER_KEY), before);
});
test("corrupt JSON and blocked storage return a temporary ledger without overwriting", () => {
  const storage = memory("{broken"),
    repo = createLocalRepository(() => storage);
  assert.equal(repo.load().ok, false);
  assert.equal(storage.values.get(LEDGER_KEY), "{broken");
  const blocked = createLocalRepository(() => {
    throw Error("denied");
  });
  assert.equal(blocked.load().ok, false);
  assert.throws(() => blocked.save(seed()), /denied/);
});
test("invalid backup and write failure preserve the previously saved ledger", () => {
  const original = JSON.stringify(seed()),
    storage = memory(original),
    repo = createLocalRepository(() => storage);
  assert.throws(() => repo.save({ ...seed(), version: 1 }));
  assert.equal(storage.values.get(LEDGER_KEY), original);
  storage.setItem = () => {
    throw Error("quota exceeded");
  };
  assert.throws(() => repo.save(seed()), /quota/);
  assert.equal(storage.values.get(LEDGER_KEY), original);
});
test("theme storage remains separate from the ledger", () => {
  const storage = memory(),
    repo = createLocalRepository(() => storage);
  repo.save(seed());
  repo.saveTheme("dark");
  assert.equal(repo.loadTheme(), "dark");
  assert.equal(repo.load().data.store, "내 카페");
});
