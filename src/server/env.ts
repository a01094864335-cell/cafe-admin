import type { D1Database, Fetcher } from "@cloudflare/workers-types";
export interface Env {
  INVITATION_TOKEN_KEY?: string;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: "local" | "test" | "production";
}
