import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../env.ts";
import { authenticate, csrf, origin } from "../auth/session.ts";
import { hash, randomToken } from "../auth/crypto.ts";
import { verifyGoogleToken } from "../auth/google.ts";
import { cookie, cookieHeader, fail, json } from "../http.ts";
import { membership } from "../services/memberships.ts";
import {
  encryptToken,
  googleRequest,
  sheetNames,
} from "../services/google-sheets.ts";

export async function sheetsRoute(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/v1\/cafes\/([A-Za-z0-9_-]+)\/google-sheet(?:\/(connect|sync|disconnect))?$/,
  );
  if (!match) return null;
  const [, cafeId, action] = match;
  const actor = await authenticate(request, env);
  await membership(env, actor, cafeId, ["owner"]);
  if (!action && request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT spreadsheet_id,requested_revision,synced_revision,last_success,error FROM google_sheet_links WHERE cafe_id=?",
    )
      .bind(cafeId)
      .first();
    return json(
      row
        ? {
            connected: true,
            url: `https://docs.google.com/spreadsheets/d/${row.spreadsheet_id}/edit`,
            pending:
              Number(row.requested_revision) > Number(row.synced_revision),
            lastSuccess: row.last_success,
            error: row.error,
          }
        : { connected: false },
      requestId,
    );
  }
  if (request.method !== "POST") return null;
  await csrf(request, env, actor);
  const guarded = async (statements: D1PreparedStatement[]) => {
    const assertionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transaction_assertions(id,ok) SELECT ?, EXISTS(SELECT 1 FROM memberships m JOIN sessions s ON s.user_id=m.user_id WHERE m.cafe_id=? AND m.user_id=? AND m.role='owner' AND m.status='active' AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?)`,
      ).bind(
        assertionId,
        cafeId,
        actor.userId,
        actor.sessionHash,
        new Date().toISOString(),
      ),
      ...statements,
      env.DB.prepare("DELETE FROM transaction_assertions WHERE id=?").bind(
        assertionId,
      ),
    ]);
  };
  if (action === "disconnect") {
    await guarded([
      env.DB.prepare("DELETE FROM google_sheet_links WHERE cafe_id=?").bind(
        cafeId,
      ),
      env.DB.prepare("DELETE FROM google_sheet_oauth WHERE cafe_id=?").bind(
        cafeId,
      ),
    ]);
    return json({ disconnected: true }, requestId);
  }
  if (action === "sync") {
    await guarded([
      env.DB.prepare(
        "UPDATE google_sheet_links SET synced_revision=-1,retry_at=0 WHERE cafe_id=?",
      ).bind(cafeId),
    ]);
    return json({ queued: true }, requestId);
  }
  if (action !== "connect") return null;
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.INVITATION_TOKEN_KEY
  )
    fail(503, "TEMPORARILY_UNAVAILABLE");
  const state = randomToken(),
    browser = randomToken(),
    nonce = randomToken(),
    verifier = randomToken();
  await guarded([
    env.DB.prepare("DELETE FROM google_sheet_oauth WHERE cafe_id=?").bind(
      cafeId,
    ),
    env.DB.prepare(
      "INSERT INTO google_sheet_oauth(state_hash,browser_hash,cafe_id,owner_id,session_hash,nonce,verifier,expires_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      await hash(state),
      await hash(browser),
      cafeId,
      actor.userId,
      actor.sessionHash,
      nonce,
      verifier,
      new Date(Date.now() + 600000).toISOString(),
    ),
  ]);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: origin(env) + "/auth/google/callback",
    response_type: "code",
    scope: "openid email profile https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    login_hint: actor.email,
    state,
    nonce,
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
  }).toString();
  const response = json({ url: target.href }, requestId);
  response.headers.append(
    "Set-Cookie",
    cookieHeader("__Host-sheet-oauth", browser, 600),
  );
  return response;
}

export async function sheetsCallback(
  request: Request,
  env: Env,
  verifyIdentity = verifyGoogleToken,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/auth/google/callback" || request.method !== "GET")
    return null;
  const state = url.searchParams.get("state"),
    browser = cookie(request, "__Host-sheet-oauth");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser) return null;
  const tx = await env.DB.prepare(
    "UPDATE google_sheet_oauth SET consumed=1 WHERE state_hash=? AND browser_hash=? AND expires_at>? AND consumed=0 RETURNING *",
  )
    .bind(await hash(state), await hash(browser), new Date().toISOString())
    .first<{
      cafe_id: string;
      owner_id: string;
      session_hash: string;
      nonce: string;
      verifier: string;
    }>();
  if (!tx) return null;
  let result = "connected";
  try {
    const actor = await authenticate(request, env);
    if (actor.userId !== tx.owner_id || actor.sessionHash !== tx.session_hash)
      fail(401, "UNAUTHENTICATED");
    await membership(env, actor, tx.cafe_id, ["owner"]);
    const code = url.searchParams.get("code");
    if (
      url.searchParams.has("error") ||
      !code ||
      code.length > 4096 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1
    )
      throw new Error("CANCELLED");
    const tokens = await googleRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: tx.verifier,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: origin(env) + "/auth/google/callback",
        grant_type: "authorization_code",
      }),
    });
    if (
      typeof tokens.id_token !== "string" ||
      typeof tokens.refresh_token !== "string" ||
      typeof tokens.access_token !== "string" ||
      !String(tokens.scope)
        .split(" ")
        .includes("https://www.googleapis.com/auth/drive.file")
    )
      throw new Error("SCOPE_REQUIRED");
    const identity = await verifyIdentity(
      tokens.id_token,
      env.GOOGLE_CLIENT_ID!,
      tx.nonce,
    );
    const same = await env.DB.prepare(
      "SELECT 1 FROM auth_identities WHERE provider='google' AND subject=? AND user_id=?",
    )
      .bind(identity.subject, actor.userId)
      .first();
    if (!same) throw new Error("ACCOUNT_MISMATCH");
    const old = await env.DB.prepare(
      "SELECT spreadsheet_id FROM google_sheet_links WHERE cafe_id=? AND owner_id=?",
    )
      .bind(tx.cafe_id, actor.userId)
      .first<{ spreadsheet_id: string }>();
    const cafe = await env.DB.prepare(
      "SELECT name,revision FROM cafes WHERE id=?",
    )
      .bind(tx.cafe_id)
      .first<{ name: string; revision: number }>();
    if (!cafe) throw new Error("NOT_FOUND");
    const cipher = await encryptToken(env, tx.cafe_id, tokens.refresh_token);
    let id = old?.spreadsheet_id;
    if (!id) {
      const created = await googleRequest(
        "https://sheets.googleapis.com/v4/spreadsheets",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: {
              title: `${cafe.name} · 매장 기록`,
              locale: "ko_KR",
              timeZone: "Asia/Seoul",
            },
            sheets: sheetNames.map((title: string, sheetId: number) => ({
              properties: {
                sheetId,
                title,
                gridProperties: { frozenRowCount: 1 },
              },
            })),
          }),
        },
      );
      id = created.spreadsheetId;
    }
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("INVALID_SHEET");
    // Final authorization check is part of the same SQL statement that persists credentials.
    const saved = await env.DB.prepare(
      `INSERT INTO google_sheet_links(cafe_id,owner_id,spreadsheet_id,refresh_cipher,requested_revision)
      SELECT c.id,?,?,?,c.revision FROM cafes c JOIN memberships m ON m.cafe_id=c.id JOIN sessions s ON s.user_id=m.user_id
      WHERE c.id=? AND m.user_id=? AND m.role='owner' AND m.status='active' AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND EXISTS(SELECT 1 FROM google_sheet_oauth WHERE state_hash=? AND consumed=1)
      ON CONFLICT(cafe_id) DO UPDATE SET owner_id=excluded.owner_id,spreadsheet_id=excluded.spreadsheet_id,refresh_cipher=excluded.refresh_cipher,requested_revision=excluded.requested_revision,synced_revision=-1,error=NULL,retry_at=0`,
    )
      .bind(
        actor.userId,
        id,
        cipher,
        tx.cafe_id,
        actor.userId,
        actor.sessionHash,
        new Date().toISOString(),
        await hash(state),
      )
      .run();
    if (saved.meta.changes !== 1) throw new Error("CONNECTION_CANCELLED");
  } catch {
    result = "failed";
  }
  await env.DB.prepare("DELETE FROM google_sheet_oauth WHERE state_hash=?")
    .bind(await hash(state))
    .run();
  return new Response(null, {
    status: 302,
    headers: {
      Location:
        origin(env) +
        "/cloud?sheet=" +
        result +
        "&cafe=" +
        encodeURIComponent(tx.cafe_id),
      "Cache-Control": "no-store",
      "Set-Cookie": cookieHeader("__Host-sheet-oauth", "", 0),
    },
  });
}
