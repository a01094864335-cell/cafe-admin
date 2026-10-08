import type { Env } from "../env.ts";
import { cookie, cookieHeader, fail, json } from "../http.ts";
import { hash, randomToken } from "./crypto.ts";
import { authenticate, csrf, origin } from "./session.ts";
import { googleProvider } from "./google.ts";
import type { IdentityProvider } from "./google.ts";
const now = () => new Date().toISOString();
function config(env: Env) {
  const base = origin(env);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    fail(503, "TEMPORARILY_UNAVAILABLE");
  return { base, redirectUri: base + "/auth/google/callback" };
}
function redirect(location: string, cookies: string[]) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
// Dependency injection exists only for tests; the Worker always uses googleProvider.
export async function authRoute(
  request: Request,
  env: Env,
  requestId: string,
  provider: IdentityProvider = googleProvider,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/auth/google/start" && request.method === "GET") {
    const { redirectUri } = config(env);
    const invite = url.searchParams.get("invite");
    if (
      url.searchParams.getAll("invite").length > 1 ||
      (invite !== null && !/^[A-Za-z0-9_-]{43}$/.test(invite))
    )
      fail(400, "VALIDATION_ERROR");
    const state = randomToken(),
      browser = randomToken(),
      nonce = randomToken(),
      verifier = randomToken();
    await env.DB.prepare(
      "INSERT INTO oauth_transactions(state_hash,browser_hash,nonce,verifier,expires_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        await hash(state),
        await hash(browser),
        nonce,
        verifier,
        new Date(Date.now() + 600000).toISOString(),
      )
      .run();
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    }).toString();
    return redirect(target.href, [
      cookieHeader("__Host-oauth", browser, 600),
      cookieHeader("__Host-invite", invite ?? "", invite ? 600 : 0),
    ]);
  }
  if (path === "/auth/google/callback" && request.method === "GET") {
    const { base, redirectUri } = config(env),
      browser = cookie(request, "__Host-oauth");
    const state = url.searchParams.get("state"),
      code = url.searchParams.get("code");
    if (
      !browser ||
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !code ||
      code.length > 4096 ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.has("error")
    )
      fail(401, "UNAUTHENTICATED");
    const tx = await env.DB.prepare(
      `UPDATE oauth_transactions SET consumed_at=? WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>?
      RETURNING nonce,verifier`,
    )
      .bind(now(), await hash(state), await hash(browser), now())
      .first<{ nonce: string; verifier: string }>();
    if (!tx) fail(401, "UNAUTHENTICATED");
    const identity = await provider.exchange(
      code,
      tx.verifier,
      redirectUri,
      tx.nonce,
      env,
    );
    const token = randomToken(),
      csrfToken = randomToken(),
      candidate = crypto.randomUUID();
    const old = cookie(request, "__Host-session");
    const statements = [
      env.DB.prepare(
        `INSERT INTO users(id,name,email,email_verified) SELECT ?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM auth_identities WHERE provider='google' AND subject=?)`,
      ).bind(candidate, identity.name, identity.email, identity.subject),
      env.DB.prepare(
        `INSERT INTO auth_identities(provider,subject,user_id) SELECT 'google',?,? WHERE NOT EXISTS(SELECT 1 FROM auth_identities WHERE provider='google' AND subject=?)`,
      ).bind(identity.subject, candidate, identity.subject),
      env.DB.prepare(
        `UPDATE users SET name=?,email=?,email_verified=1 WHERE id=(SELECT user_id FROM auth_identities WHERE provider='google' AND subject=?)`,
      ).bind(identity.name, identity.email, identity.subject),
      env.DB.prepare(
        `INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) SELECT ?,user_id,?,? FROM auth_identities WHERE provider='google' AND subject=?`,
      ).bind(
        await hash(token),
        await hash(csrfToken),
        new Date(Date.now() + 7 * 86400000).toISOString(),
        identity.subject,
      ),
    ];
    if (old)
      statements.push(
        env.DB.prepare(
          "UPDATE sessions SET revoked_at=? WHERE token_hash=?",
        ).bind(now(), await hash(old)),
      );
    await env.DB.batch(statements);
    const invite = cookie(request, "__Host-invite");
    return redirect(
      base + "/cloud.html" + (invite ? "#invite=" + invite : ""),
      [
        cookieHeader("__Host-invite", "", 0),
        cookieHeader("__Host-oauth", "", 0),
        cookieHeader("__Host-session", token, 604800),
        cookieHeader("__Host-csrf", csrfToken, 604800, false),
      ],
    );
  }
  if (path === "/api/v1/me" && request.method === "GET") {
    const actor = await authenticate(request, env);
    const value = cookie(request, "__Host-csrf");
    return json(
      {
        id: actor.userId,
        canCreateCafe: (env.CAFE_CREATOR_IDS ?? "")
          .split(",")
          .map((v) => v.trim())
          .includes(actor.userId),
        name: actor.name,
        email: actor.email,
        csrfToken:
          value && (await hash(value)) === actor.csrfHash ? value : null,
      },
      requestId,
    );
  }
  if (path === "/auth/logout" && request.method === "POST") {
    const actor = await authenticate(request, env);
    await csrf(request, env, actor);
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?")
      .bind(now(), actor.sessionHash)
      .run();
    const response = json({ loggedOut: true }, requestId);
    response.headers.append(
      "Set-Cookie",
      cookieHeader("__Host-session", "", 0),
    );
    response.headers.append(
      "Set-Cookie",
      cookieHeader("__Host-csrf", "", 0, false),
    );
    return response;
  }
  return null;
}
