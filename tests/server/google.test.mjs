import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { verifyGoogleToken } from "../../src/server/auth/google.ts";

test("ID token verifies RSA signature, issuer, audience, nonce, expiry, authorized party and verified email", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (extra = {}) =>
    new SignJWT({
      sub: "subject",
      email: "a@example.invalid",
      email_verified: true,
      nonce: "nonce",
      iss: "https://accounts.google.com",
      aud: "client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(privateKey);
  assert.equal(
    (await verifyGoogleToken(await sign(), "client", "nonce", keys)).subject,
    "subject",
  );
  for (const extra of [
    { iss: "https://evil.invalid" },
    { aud: "other" },
    { nonce: "wrong" },
    { exp: 1 },
    { email_verified: false },
    { azp: "other" },
    { aud: ["client", "other"] },
  ]) {
    await assert.rejects(
      verifyGoogleToken(await sign(extra), "client", "nonce", keys),
    );
  }
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT({ sub: "subject" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(other.privateKey);
  await assert.rejects(verifyGoogleToken(forged, "client", "nonce", keys));
});
