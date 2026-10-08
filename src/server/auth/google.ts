import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Env } from "../env.ts";
import { fail } from "../http.ts";
export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string;
}
export interface IdentityProvider {
  exchange(
    code: string,
    verifier: string,
    redirectUri: string,
    nonce: string,
    env: Env,
  ): Promise<GoogleIdentity>;
}
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export async function verifyGoogleToken(
  token: string,
  clientId: string,
  nonce: string,
  key: JWTVerifyGetKey = keys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"],
    maxTokenAge: "1h",
  });
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    payload.email_verified !== true ||
    typeof payload.email !== "string" ||
    !payload.email.includes("@") ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== clientId)
  )
    fail(401, "UNAUTHENTICATED");
  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : payload.email,
  };
}
export const googleProvider: IdentityProvider = {
  async exchange(code, verifier, redirectUri, nonce, env) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }).catch(() => fail(503, "TEMPORARILY_UNAVAILABLE"));
    if (response.status >= 500 || response.status === 429)
      fail(503, "TEMPORARILY_UNAVAILABLE");
    if (!response.ok) fail(401, "UNAUTHENTICATED");
    const value = (await response
      .json()
      .catch(() => fail(401, "UNAUTHENTICATED"))) as { id_token?: unknown };
    if (typeof value.id_token !== "string") fail(401, "UNAUTHENTICATED");
    try {
      return await verifyGoogleToken(
        value.id_token,
        env.GOOGLE_CLIENT_ID!,
        nonce,
      );
    } catch {
      return fail(401, "UNAUTHENTICATED");
    }
  },
};
