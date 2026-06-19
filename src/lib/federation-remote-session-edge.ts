// src/lib/federation-remote-session-edge.ts
//
// Edge-safe verifier for the `rivr_remote_viewer` cookie.
//
// Why this exists:
// - `federation-remote-session.ts` (the node encoder/decoder) imports
//   `node:crypto`, which is unavailable in the Next.js edge runtime where
//   `middleware.ts` runs.
// - The middleware needs to accept the signed `rivr_remote_viewer` cookie as
//   an authenticated session alongside the NextAuth JWT, so it can let a
//   cross-instance SSO visitor browse without being bounced to /auth/login.
// - This module reproduces the node verification using the Web Crypto API
//   (`globalThis.crypto.subtle`), which is available in both the edge runtime
//   and modern Node runtimes.
//
// Signing parity (must match `signPackedPayload` in the node module):
// - The node module signs the base64url-encoded payload STRING, not the raw
//   JSON bytes: `HMAC-SHA256(secret, payloadB64)`. This verifier therefore
//   HMACs the ASCII bytes of `payloadB64`, not the decoded JSON.
// - Secret resolution mirrors `resolveFederationSecret()`:
//   `AUTH_SECRET` first, then `NODE_ADMIN_KEY`.
//
// Security properties (parity with the node verifier):
// - Signature verified with HMAC-SHA256 before any payload trust.
// - Constant-time comparison via `crypto.subtle.verify` (timing-safe).
// - `type`, `localInstanceId`, and `expiresAt` are all enforced on decode.

import {
  REMOTE_VIEWER_TOKEN_TYPE,
  type RemoteViewerSessionPayload,
} from "@/lib/federation-remote-session-types";

/**
 * Resolve the HMAC secret the cookie was signed with. Mirrors
 * `resolveFederationSecret()` in `federation-remote-session.ts`.
 *
 * @returns The signing secret, or `null` when none is configured.
 */
export function resolveFederationSecretEdge(): string | null {
  const authSecret = (process.env.AUTH_SECRET ?? "").trim();
  if (authSecret.length > 0) return authSecret;
  const adminKey = (process.env.NODE_ADMIN_KEY ?? "").trim();
  if (adminKey.length > 0) return adminKey;
  return null;
}

/**
 * Decode and verify a `rivr_remote_viewer` cookie using Web Crypto.
 *
 * @param cookieValue   Raw cookie value (may be undefined/null when missing).
 * @param secret        HMAC signing secret — must match the encoder's secret.
 * @param localInstanceId Instance id this cookie must be bound to.
 * @param now           Optional fixed clock for tests (ms since epoch).
 * @returns The verified payload, or `null` when the cookie is missing or
 *          fails verification / instance-binding / expiry.
 */
export async function decodeRemoteViewerSessionEdge(
  cookieValue: string | undefined | null,
  secret: string,
  localInstanceId: string,
  now?: number,
): Promise<RemoteViewerSessionPayload | null> {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return null;
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    // The node encoder HMACs the base64url payload STRING, so sign the ASCII
    // bytes of `payloadB64` (not the decoded JSON).
    //
    // Pass `Uint8Array` views directly. The Next.js edge-runtime SubtleCrypto
    // rejects a bare `ArrayBuffer` for the data/signature arguments and throws
    // a `TypeError`, which would silently invalidate every otherwise-valid
    // cookie. An `ArrayBufferView` is accepted in both the edge and Node Web
    // Crypto implementations.
    const data = new TextEncoder().encode(payloadB64);
    valid = await subtle.verify(
      "HMAC",
      key,
      sigBytes as BufferSource,
      data as BufferSource,
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }
  if (!isRemoteViewerPayload(parsed)) return null;
  if (parsed.localInstanceId !== localInstanceId) return null;

  const expiresAtMs = Date.parse(parsed.expiresAt);
  const nowMs = typeof now === "number" ? now : Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;

  return parsed;
}

// ---------------------------------------------------------------------------
// Internal helpers — edge-safe (no node:crypto, no Buffer).
// ---------------------------------------------------------------------------

function fromBase64Url(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const normalized =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  // `atob` is available in edge and modern Node runtimes.
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isRemoteViewerPayload(v: unknown): v is RemoteViewerSessionPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === REMOTE_VIEWER_TOKEN_TYPE &&
    typeof o.actorId === "string" &&
    typeof o.homeBaseUrl === "string" &&
    typeof o.localInstanceId === "string" &&
    typeof o.issuedAt === "string" &&
    typeof o.expiresAt === "string" &&
    typeof o.nonce === "string"
  );
}
