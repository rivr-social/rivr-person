// src/lib/federation/__tests__/sso-assertion-issuer.test.ts
//
// Focused coverage for the SSO-assertion issuer allow-list widening
// (2026-07-14 parity wave): the verifier accepts an assertion issued by the
// configured GLOBAL authority OR by the asserted actor's OWN HOME instance
// (issuer == claims.homeBaseUrl), while a foreign issuer still rejects with
// `issuer-mismatch`. The registered-key signature check is unchanged and
// remains mandatory, so a widened issuer that is not actually the signer dies
// as `signature-invalid`, never as an accepted forgery.

import { describe, it, expect } from "vitest";

import { generateNodeKeyPair, signPayload } from "@/lib/federation-crypto";
import {
  verifySsoAssertion,
  type SsoAssertionClaims,
} from "@/lib/federation/sso-assertion";

const GLOBAL_ISSUER = "https://app.rivr.social";
const HOME_INSTANCE = "https://person-bob.rivr.social";
const TARGET = "https://person-alice.rivr.social";

/** Build a fully-populated claim set (no undefined keys → stripUndefined no-op). */
function buildClaims(overrides: Partial<SsoAssertionClaims> = {}): SsoAssertionClaims {
  const now = Math.floor(1_752_000_000_000 / 1000);
  return {
    actorId: "agent-bob",
    homeBaseUrl: HOME_INSTANCE,
    globalIssuerBaseUrl: GLOBAL_ISSUER,
    targetBaseUrl: TARGET,
    credentialVersion: 1,
    homeAuthorityVersion: 1,
    instanceClass: "sovereign",
    parentAgentId: null,
    iat: now,
    exp: now + 300,
    nonce: "nonce-fixed-1",
    ...overrides,
  };
}

/** Sign a claim set with a keypair, returning the wire envelope + public key. */
function signAssertion(claims: SsoAssertionClaims) {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const signature = signPayload(
    claims as unknown as Record<string, unknown>,
    privateKey,
  );
  return {
    publicKey,
    assertion: { ...claims, kid: "kid-1", signature },
  };
}

const FIXED_NOW = 1_752_000_100_000; // between iat and exp

describe("verifySsoAssertion — issuer allow-list widening", () => {
  it("accepts an assertion issued by the configured GLOBAL authority", async () => {
    const claims = buildClaims({ globalIssuerBaseUrl: GLOBAL_ISSUER });
    const { publicKey, assertion } = signAssertion(claims);

    const result = await verifySsoAssertion(
      {
        assertion,
        expectedTargetBaseUrl: TARGET,
        expectedGlobalIssuerBaseUrl: GLOBAL_ISSUER,
        now: FIXED_NOW,
      },
      async () => publicKey,
    );

    expect(result.ok).toBe(true);
  });

  it("accepts an assertion whose issuer is the actor's OWN HOME instance", async () => {
    // issuer == homeBaseUrl, and issuer != the configured global authority.
    const claims = buildClaims({
      globalIssuerBaseUrl: HOME_INSTANCE,
      homeBaseUrl: HOME_INSTANCE,
    });
    const { publicKey, assertion } = signAssertion(claims);

    const result = await verifySsoAssertion(
      {
        assertion,
        expectedTargetBaseUrl: TARGET,
        expectedGlobalIssuerBaseUrl: GLOBAL_ISSUER,
        now: FIXED_NOW,
      },
      async () => publicKey,
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a foreign issuer (neither global authority nor actor home) as issuer-mismatch", async () => {
    // issuer is some third instance — not global, not the actor's home.
    const claims = buildClaims({
      globalIssuerBaseUrl: "https://evil.example.com",
      homeBaseUrl: HOME_INSTANCE,
    });
    const { publicKey, assertion } = signAssertion(claims);

    const result = await verifySsoAssertion(
      {
        assertion,
        expectedTargetBaseUrl: TARGET,
        expectedGlobalIssuerBaseUrl: GLOBAL_ISSUER,
        now: FIXED_NOW,
      },
      async () => publicKey,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("issuer-mismatch");
  });

  it("still enforces the registered-key signature for a widened home issuer", async () => {
    // issuer == home passes the allow-list, but the presented public key is a
    // DIFFERENT key than the signer → signature-invalid, never accepted.
    const claims = buildClaims({
      globalIssuerBaseUrl: HOME_INSTANCE,
      homeBaseUrl: HOME_INSTANCE,
    });
    const { assertion } = signAssertion(claims);
    const foreignKey = generateNodeKeyPair().publicKey;

    const result = await verifySsoAssertion(
      {
        assertion,
        expectedTargetBaseUrl: TARGET,
        expectedGlobalIssuerBaseUrl: GLOBAL_ISSUER,
        now: FIXED_NOW,
      },
      async () => foreignKey,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature-invalid");
  });
});
