import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readdir, readFile } from "node:fs/promises";

export async function database(t) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } };',
      compatibilityDate: "2026-10-01",
      d1Databases: { DB: "w04-synthetic-tests" },
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of (
    await readdir(new URL("../../migrations/", import.meta.url))
  )
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    // D1 exec supports migrations including trigger bodies; keep SQL on one line for its parser.
    const sql = (
      await readFile(
        new URL("../../migrations/" + name, import.meta.url),
        "utf8",
      )
    )
      .replace(/^--.*$/gm, "")
      .replace(/\n/g, " ");
    await db.exec(sql);
  }
  return db;
}
export const stmt = (db, sql, ...values) =>
  values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
export async function seed(db) {
  const sql = await readFile(
    new URL("./fixtures/synthetic.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
}
export async function scalar(db, sql, ...values) {
  return (await stmt(db, sql, ...values).raw())[0][0];
}
