// Offline deployment config generator. It never contacts Cloudflare or migrates data.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function deploymentConfig(env, root = process.cwd()) {
  const {
    DEPLOY_TARGET: target,
    D1_DATABASE_ID: id,
    OTHER_D1_DATABASE_ID: other,
    D1_DATABASE_NAME: name,
  } = env;
  if (!["test", "production"].includes(target))
    throw Error("Explicit test/production target required");
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(id ?? "") ||
    !uuid.test(other ?? "") ||
    id.toLowerCase() === other.toLowerCase()
  )
    throw Error("Two distinct provisioned D1 IDs required");
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw Error("Provisioned DB name required");
  return {
    name: `cafe-admin-${target}`,
    main: resolve(root, "src/server/index.ts"),
    compatibility_date: "2026-10-01",
    workers_dev: false,
    preview_urls: false,
    vars: { APP_ENV: target },
    assets: {
      directory: resolve(root, "dist"),
      binding: "ASSETS",
      run_worker_first: ["/api", "/api/*", "/auth", "/auth/*"],
      not_found_handling: "single-page-application",
    },
    d1_databases: [
      {
        binding: "DB",
        database_id: id,
        database_name: name,
        migrations_dir: resolve(root, "migrations"),
      },
    ],
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw Error("Output path required");
  await writeFile(
    process.argv[2],
    JSON.stringify(deploymentConfig(process.env), null, 2),
  );
}
