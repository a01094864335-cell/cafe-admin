import type { Env } from "../env.ts";
import { backupSheets } from "../../shared/backup-sheets.js";
import { dataTables } from "../repositories/import-records.ts";
import { base64url } from "../auth/crypto.ts";

type Link = {
  cafe_id: string;
  owner_id: string;
  spreadsheet_id: string;
  refresh_cipher: string;
  requested_revision: number;
  synced_revision: number;
  attempts: number;
  lease: string;
};
export class SheetsError extends Error {}
const decode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
async function key(env: Env) {
  if (!env.INVITATION_TOKEN_KEY) throw new SheetsError("CONFIG_REQUIRED");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.INVITATION_TOKEN_KEY),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("cafe-google-sheets-v1"),
      info: new TextEncoder().encode("refresh-token"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptToken(env: Env, cafeId: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(cafeId) },
    await key(env),
    new TextEncoder().encode(token),
  );
  return base64url(iv) + "." + base64url(new Uint8Array(encrypted));
}
export async function decryptToken(env: Env, cafeId: string, cipher: string) {
  const [iv, value] = cipher.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(iv),
        additionalData: new TextEncoder().encode(cafeId),
      },
      await key(env),
      decode(value),
    ),
  );
}
export async function googleRequest(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    throw new SheetsError(
      response.status === 401 || value.error === "invalid_grant"
        ? "RECONNECT_REQUIRED"
        : response.status === 403
          ? "GOOGLE_PERMISSION_REQUIRED"
          : response.status === 404
            ? "SHEET_NOT_FOUND"
            : "GOOGLE_RETRY",
    );
  }
  return response.json() as Promise<any>;
}
export const sheetNames = backupSheets({
  tables: {},
  cafe: { name: "" },
  exportedAt: "",
}).map((s: { name: string }) => s.name);
export function sheetRequests(sheets: { name: string; rows: unknown[][] }[]) {
  return sheets.flatMap((sheet, sheetId) => {
    const columns = sheet.rows[0].length;
    return [
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: Math.max(100, sheet.rows.length),
              columnCount: columns,
              frozenRowCount: 1,
            },
          },
          fields: "gridProperties",
        },
      },
      {
        updateCells: {
          range: { sheetId },
          rows: sheet.rows.map((row) => ({
            values: row.map((value) => ({
              userEnteredValue:
                value == null
                  ? {}
                  : typeof value === "number"
                    ? { numberValue: value }
                    : { stringValue: String(value) },
            })),
          })),
          fields: "userEnteredValue",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.12, green: 0.28, blue: 0.25 },
              textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
              },
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: columns,
          },
        },
      },
    ];
  });
}
export async function syncCafe(env: Env, cafeId: string) {
  const lease = crypto.randomUUID(),
    now = Date.now();
  const link = await env.DB.prepare(
    `UPDATE google_sheet_links SET lease=?,lease_until=? WHERE cafe_id=? AND requested_revision>synced_revision AND retry_at<=? AND lease_until<? RETURNING *`,
  )
    .bind(lease, now + 300000, cafeId, now, now)
    .first<Link>();
  if (!link) return;
  try {
    const owner = await env.DB.prepare(
      "SELECT 1 FROM memberships WHERE cafe_id=? AND user_id=? AND role='owner' AND status='active'",
    )
      .bind(cafeId, link.owner_id)
      .first();
    if (!owner) throw new SheetsError("OWNER_CHANGED");
    const refreshToken = await decryptToken(env, cafeId, link.refresh_cipher);
    const tokens = await googleRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const snapshot = await env.DB.batch([
      env.DB.prepare("SELECT name,revision FROM cafes WHERE id=?").bind(cafeId),
      ...dataTables.map((table) =>
        env.DB.prepare(
          `SELECT * FROM ${table} WHERE cafe_id=? AND dataset_id=(SELECT active_dataset_id FROM cafes WHERE id=?) ORDER BY ${table === "payroll_rates" ? "settings_id,year" : "id"} LIMIT 10001`,
        ).bind(cafeId, cafeId),
      ),
    ]);
    if (snapshot.slice(1).some((result) => result.results.length > 10000))
      throw new SheetsError("SHEET_TOO_LARGE");
    const cafe = snapshot[0].results[0] as { name: string; revision: number };
    const tables = Object.fromEntries(
      dataTables.map((table, index) => [table, snapshot[index + 1].results]),
    );
    const sheets = backupSheets({
      tables,
      cafe,
      exportedAt: new Date().toISOString(),
    });
    sheets[0].rows.push([
      "자동 동기화",
      "사이트 기록이 기준입니다. 이 탭들은 다음 동기화 때 덮어씁니다. 별도 탭을 추가해 분석하세요.",
    ]);
    const payload = JSON.stringify({ requests: sheetRequests(sheets) });
    if (new TextEncoder().encode(payload).length > 2 * 1024 * 1024)
      throw new SheetsError("SHEET_TOO_LARGE");
    // Recheck after network and snapshot work. A disconnected link cannot start a new write.
    const live = await env.DB.prepare(
      `SELECT 1 FROM google_sheet_links l JOIN memberships m ON m.cafe_id=l.cafe_id AND m.user_id=l.owner_id WHERE l.cafe_id=? AND l.lease=? AND m.role='owner' AND m.status='active'`,
    )
      .bind(cafeId, lease)
      .first();
    if (!live) return;
    await googleRequest(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(link.spreadsheet_id)}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: payload,
      },
    );
    await env.DB.prepare(
      "UPDATE google_sheet_links SET synced_revision=?,last_success=?,error=NULL,attempts=0,retry_at=0,lease=NULL,lease_until=0 WHERE cafe_id=? AND lease=? AND spreadsheet_id=? AND refresh_cipher=?",
    )
      .bind(
        cafe.revision,
        new Date().toISOString(),
        cafeId,
        lease,
        link.spreadsheet_id,
        link.refresh_cipher,
      )
      .run();
  } catch (error) {
    const code = error instanceof SheetsError ? error.message : "GOOGLE_RETRY";
    // A timed-out Google write may still finish. Keep the lease for five minutes before retrying.
    await env.DB.prepare(
      "UPDATE google_sheet_links SET error=?,attempts=attempts+1,retry_at=?,lease=NULL,lease_until=? WHERE cafe_id=? AND lease=?",
    )
      .bind(
        code,
        Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(link.attempts, 6)),
        now + 300000,
        cafeId,
        lease,
      )
      .run();
  }
}
export async function syncPending(env: Env) {
  const pending = await env.DB.prepare(
    "SELECT cafe_id FROM google_sheet_links WHERE requested_revision>synced_revision AND retry_at<=? AND lease_until<? LIMIT 5",
  )
    .bind(Date.now(), Date.now())
    .all<{ cafe_id: string }>();
  await Promise.all(pending.results.map((row) => syncCafe(env, row.cafe_id)));
  await env.DB.prepare("DELETE FROM google_sheet_oauth WHERE expires_at<?")
    .bind(new Date().toISOString())
    .run();
}
