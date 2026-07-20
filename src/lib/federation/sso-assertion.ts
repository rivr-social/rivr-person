// src/lib/federation/sso-assertion.ts
//
// Sovereign-side verifier for the global→home SSO handoff assertion
// (issue rivr-social/rivr-app#102, no-mirror UM v0.4 work).
//
// This is the *verify half* of the assertion rail whose signer lives in
// global at `src/lib/federation/sso-assertion.ts`. A sovereign instance
// never mints these assertions; it only consumes them when global bounces
// one of its own home-instance users back here pre-authenticated.
//
// Why local verification (and not the older callback model):
// - The assertion is signed with global's Ed25519 private key. Because the
//   signature is asymmetric, this instance verifies it LOCALLY against
//   global's *public* key (resolved from the `nodes` row global already
//   federated to us) — no shared HMAC secret and no round-trip callback to
//   the home/issuer instance. This is the most-evolved (UM Signature
//   Profile A) auth rail: every check is offline and the signed surface is
//   audience-bound so it cannot be replayed against another peer.
//
// The signed surface, canonicalization, and field set are byte-for-byte
// identical to global's signer so `verifyPayloadSignature` (shared
// `federation-crypto` primitive) succeeds without any format negotiation.

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { nodes } from "@/db/schema";
import { verifyPayloadSignature } from "@/lib/federation-crypto";

/**
 * Claim set covered by global's Ed25519 signature. Mirrors
 * `SsoAssertionClaims` in the global signer exactly — any divergence would
 * change the canonical form and break verification.
 */
export interface SsoAssertionClaims {
  actorId: string;
  email?: string;
  handle?: string;
  name?: string;
  avatarUrl?: string;
  homeBaseUrl: string;
  globalIssuerBaseUrl: string;
  targetBaseUrl: string;
  credentialVersion: number;
  homeAuthorityVersion: number;
  instanceClass: "hosted-federated" | "sovereign";
  parentAgentId: string | null;
  iat: number;
  exp: number;
  nonce: string;
}

/** Fully signed assertion envelope as received from the wire. */
export interface SignedSsoAssertion extends SsoAssertionClaims {
  kid: string;
  signature: string;
}

/** Stable reason an assertion failed verification. */
export type SsoAssertionVerifyFailure =
  | "malformed"
  | "expired"
  | "not-yet-valid"
  | "audience-mismatch"
  | "issuer-mismatch"
  | "issuer-unknown"
  | "issuer-no-public-key"
  | "signature-invalid";

/** Outcome envelope for {@link verifySsoAssertion}. */
export type SsoAssertionVerifyResult =
  | { ok: true; claims: SsoAssertionClaims }
  | { ok: false; reason: SsoAssertionVerifyFailure; detail?: string };

/** Input to {@link verifySsoAssertion}. */
export interface VerifySsoAssertionInput {
  /** Full signed assertion as received from the wire. */
  assertion: unknown;
  /** Local base URL this peer advertises — must match `targetBaseUrl`. */
  expectedTargetBaseUrl: string;
  /**
   * When provided, trust is restricted to this single issuer so the signed
   * surface cannot be accepted from an unexpected origin even if a `nodes`
   * row exists for it. Callers pass the configured global authority URL.
   */
  expectedGlobalIssuerBaseUrl?: string;
  /** Maximum allowed clock skew in seconds. Default 60s, clamped to 300. */
  maxClockSkewSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
}

/** Minimal `nodes` lookup the verifier needs. Exported for mockability. */
export interface IssuerPublicKeyLookup {
  (baseUrl: string): Promise<string | null>;
}

/**
 * Default issuer-public-key lookup: search `nodes` by base URL. Returns the
 * PEM-encoded Ed25519 public key global already federated to this instance,
 * or `null` when no such peer row exists.
 */
async function defaultIssuerPublicKeyLookup(
  baseUrl: string,
): Promise<string | null> {
  const [node] = await db
    .select({ publicKey: nodes.publicKey })
    .from(nodes)
    .where(eq(nodes.baseUrl, baseUrl))
    .limit(1);
  return node?.publicKey ?? null;
}

/**
 * Verify a signed SSO assertion against this peer's expectations. Checks
 * run cheapest-first so a malformed or mis-audience'd payload is rejected
 * before the DB is queried for the issuer's public key.
 */
export async function verifySsoAssertion(
  input: VerifySsoAssertionInput,
  resolveIssuerPublicKey: IssuerPublicKeyLookup = defaultIssuerPublicKeyLookup,
): Promise<SsoAssertionVerifyResult> {
  const parsed = parseSignedAssertion(input.assertion);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }
  const { claims, signature } = parsed;

  // Audience binding — cheapest check that matters.
  const expectedTarget = normalizeBaseUrl(input.expectedTargetBaseUrl);
  const assertionTarget = normalizeBaseUrl(claims.targetBaseUrl);
  if (!expectedTarget || expectedTarget !== assertionTarget) {
    return { ok: false, reason: "audience-mismatch" };
  }

  // Issuer allow-listing. Two issuers are acceptable (Cameron, 2026-07-13 —
  // login must never break on this):
  //  1. the configured GLOBAL identity authority, and
  //  2. the asserted actor's OWN HOME instance (issuer == claims.homeBaseUrl)
  //     — a home may vouch for its own actors, the same principle as the
  //     owner-routed buyer rail's homeNodeId == peerNodeId rule. The
  //     signature check below still verifies against the REGISTERED key for
  //     that issuer, so an unregistered issuer dies as `issuer-unknown` and a
  //     key mismatch as `signature-invalid`; a registered peer can never
  //     vouch for a FOREIGN-homed actor (issuer != home != global rejects).
  // Fail CLOSED — the issuer check ALWAYS runs (F2). Previously it was skipped
  // entirely when `expectedGlobalIssuerBaseUrl` was unset, so an instance not
  // yet told its trust authority accepted ANY issuer. Now: an issuer is
  // acceptable only if it is the configured global authority OR the asserted
  // actor's own home. When no global authority is configured, only actor-home
  // issuers pass; an unrelated issuer (and a claim with no issuer/home) is
  // rejected. The signature check below still verifies against the REGISTERED
  // key, so an unregistered issuer dies as `issuer-unknown`.
  {
    const expectedIssuer = normalizeBaseUrl(input.expectedGlobalIssuerBaseUrl);
    const claimsIssuer = normalizeBaseUrl(claims.globalIssuerBaseUrl);
    const claimsHome = normalizeBaseUrl(claims.homeBaseUrl);
    const issuerIsGlobal = Boolean(expectedIssuer && claimsIssuer === expectedIssuer);
    const issuerIsActorHome = Boolean(claimsIssuer && claimsHome === claimsIssuer);
    if (!issuerIsGlobal && !issuerIsActorHome) {
      return { ok: false, reason: "issuer-mismatch" };
    }
  }

  // Expiry / iat sanity.
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const skew = clampSkew(input.maxClockSkewSec);
  if (claims.exp + skew <= nowSec) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iat - skew > nowSec) {
    return { ok: false, reason: "not-yet-valid" };
  }

  // Issuer public-key lookup (the only DB hit).
  const publicKey = await resolveIssuerPublicKey(claims.globalIssuerBaseUrl);
  if (publicKey === null) {
    return { ok: false, reason: "issuer-unknown" };
  }
  if (!publicKey) {
    return { ok: false, reason: "issuer-no-public-key" };
  }

  // Ed25519 signature verification over the canonical claim set. The signed
  // surface excludes `kid` and `signature` and strips undefined keys so it
  // matches global's signer byte-for-byte after canonicalization.
  const ok = verifyPayloadSignature(
    stripUndefined(claims) as unknown as Record<string, unknown>,
    signature,
    publicKey,
  );
  if (!ok) {
    return { ok: false, reason: "signature-invalid" };
  }

  return { ok: true, claims };
}

/**
 * Parse an unknown wire value into a {@link SignedSsoAssertion}. Returns
 * `null` when required fields are missing or wrong-typed.
 */
function parseSignedAssertion(
  raw: unknown,
): { claims: SsoAssertionClaims; signature: string; kid: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (
    typeof o.actorId !== "string" ||
    typeof o.homeBaseUrl !== "string" ||
    typeof o.globalIssuerBaseUrl !== "string" ||
    typeof o.targetBaseUrl !== "string" ||
    typeof o.credentialVersion !== "number" ||
    typeof o.homeAuthorityVersion !== "number" ||
    (o.instanceClass !== "hosted-federated" && o.instanceClass !== "sovereign") ||
    (o.parentAgentId !== null && typeof o.parentAgentId !== "string") ||
    typeof o.iat !== "number" ||
    typeof o.exp !== "number" ||
    typeof o.nonce !== "string" ||
    typeof o.kid !== "string" ||
    typeof o.signature !== "string"
  ) {
    return null;
  }
  if (o.email !== undefined && typeof o.email !== "string") return null;
  if (o.handle !== undefined && typeof o.handle !== "string") return null;
  if (o.name !== undefined && typeof o.name !== "string") return null;
  if (o.avatarUrl !== undefined && typeof o.avatarUrl !== "string") return null;

  const claims: SsoAssertionClaims = {
    actorId: o.actorId,
    ...(typeof o.email === "string" ? { email: o.email } : {}),
    ...(typeof o.handle === "string" ? { handle: o.handle } : {}),
    ...(typeof o.name === "string" ? { name: o.name } : {}),
    ...(typeof o.avatarUrl === "string" ? { avatarUrl: o.avatarUrl } : {}),
    homeBaseUrl: o.homeBaseUrl,
    globalIssuerBaseUrl: o.globalIssuerBaseUrl,
    targetBaseUrl: o.targetBaseUrl,
    credentialVersion: o.credentialVersion,
    homeAuthorityVersion: o.homeAuthorityVersion,
    instanceClass: o.instanceClass,
    parentAgentId: o.parentAgentId as string | null,
    iat: o.iat,
    exp: o.exp,
    nonce: o.nonce,
  };
  return { claims, signature: o.signature, kid: o.kid };
}

/** Normalize a base URL to its canonical origin, or null when invalid. */
function normalizeBaseUrl(input: string | undefined | null): string | null {
  if (!input) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

/** Clamp the caller-supplied skew into `[0, 300]` seconds. */
function clampSkew(requested: number | undefined): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested < 0
  ) {
    return 60;
  }
  return Math.min(Math.floor(requested), 300);
}

/**
 * Remove `undefined` keys before canonicalization so the verified surface
 * aligns with what global's signer produced.
 */
function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
