/**
 * @fileoverview Authenticated encryption-at-rest for stored third-party secrets.
 *
 * Connector secrets (OAuth access/refresh tokens, pasted API keys for DNS and
 * other providers) must never be persisted as plaintext. The person repo stores
 * connectors inside `agents.metadata.autobotSettings.connections` (a JSONB
 * blob), which previously held config values in the clear. This module wraps
 * AES-256-GCM so those fields hold ciphertext instead, while remaining backward
 * compatible with values written before encryption existed.
 *
 * Storage format (kept inside the existing JSON string fields — no schema
 * change):
 *
 *   enc:v1:<base64url(iv)>:<base64url(authTag)>:<base64url(ciphertext)>
 *
 * `decryptSecret` recognizes that prefix; any value WITHOUT it is treated as
 * legacy plaintext and returned unchanged, so reads keep working during the
 * transition. The next write re-stores the value as ciphertext via
 * `encryptSecret`, so plaintext is phased out lazily without a migration job.
 *
 * Key material — an ORDERED CHAIN. Index 0 is the WRITE key; every entry is a
 * candidate READ key, so adopting or rotating a key never orphans stored values:
 * - `CONNECTOR_ENCRYPTION_KEY` — 32 bytes, base64 or hex.
 * - `CONNECTOR_ENCRYPTION_KEY_PREVIOUS` — comma-separated retired keys,
 *   decrypt-only.
 * - `scrypt(AUTH_SECRET)` — the historical implicit key, kept as a READ fallback
 *   so an instance that ran without an explicit key can adopt one with zero
 *   downtime. Production deployments SHOULD set `CONNECTOR_ENCRYPTION_KEY`.
 *
 * Ported from the global app (`rivr-social/rivr-app` src/lib/crypto/secret-box.ts,
 * commit 4310ca2) so the person connector lane shares the same on-disk envelope
 * and key-derivation rules as the global `user_connections` lane.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

import { getEnv } from "@/lib/env";

/** Algorithm: 256-bit key, GCM authenticated mode. */
const ALGORITHM = "aes-256-gcm";
/** AES-256 key length in bytes. */
const KEY_LENGTH_BYTES = 32;
/** Recommended GCM IV length in bytes (96-bit nonce). */
const IV_LENGTH_BYTES = 12;
/** GCM authentication tag length in bytes. */
const AUTH_TAG_LENGTH_BYTES = 16;
/** Self-describing prefix marking a value as ciphertext written by this module. */
const CIPHERTEXT_PREFIX = "enc:v1:";
/** Fixed salt for the scrypt fallback key derivation from AUTH_SECRET. */
const SCRYPT_FALLBACK_SALT = "rivr.connector.secret-box.v1";

/** Memoized key chain so we derive/parse once per process. */
let cachedKeys: Buffer[] | null = null;

/**
 * Resolves the ordered key chain. Index 0 is the WRITE key; every entry is a
 * candidate READ key, tried in order.
 *
 * Order:
 *   1. `CONNECTOR_ENCRYPTION_KEY` — explicit, 32 bytes base64/hex.
 *   2. `CONNECTOR_ENCRYPTION_KEY_PREVIOUS` — comma-separated retired keys,
 *      decrypt-only, so a rotation does not orphan rows written under the key
 *      it replaced.
 *   3. The scrypt derivation from `AUTH_SECRET` — the historical implicit key.
 *      Retained as a READ fallback so instances that ran without an explicit
 *      key can adopt one with ZERO downtime and migrate rows afterwards.
 *
 * Rotation without this chain is destructive: `decryptSecret` THROWS on a wrong
 * key (GCM auth failure), so introducing `CONNECTOR_ENCRYPTION_KEY` on an
 * instance holding rows encrypted under the AUTH_SECRET derivation would break
 * every read of those rows. Verified 2026-08-01: global prod held 3 such
 * `agents.matrix_access_token` values, dev 4.
 *
 * @throws {Error} When no key material is configured at all.
 */
function resolveKeys(): Buffer[] {
  if (cachedKeys) return cachedKeys;

  const keys: Buffer[] = [];

  const explicit = process.env.CONNECTOR_ENCRYPTION_KEY?.trim();
  if (explicit) keys.push(parseKeyOrThrow(explicit, "CONNECTOR_ENCRYPTION_KEY"));

  const previous = process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previous) {
    for (const entry of previous.split(",").map((value) => value.trim()).filter(Boolean)) {
      keys.push(parseKeyOrThrow(entry, "CONNECTOR_ENCRYPTION_KEY_PREVIOUS"));
    }
  }

  const authSecret = getEnv("AUTH_SECRET");
  if (authSecret) {
    keys.push(scryptSync(authSecret, SCRYPT_FALLBACK_SALT, KEY_LENGTH_BYTES));
  }

  if (keys.length === 0) {
    throw new Error(
      "Cannot encrypt connector secrets: set CONNECTOR_ENCRYPTION_KEY (32 bytes base64/hex) or AUTH_SECRET.",
    );
  }

  cachedKeys = keys;
  return cachedKeys;
}

/** The key new ciphertext is written under (head of the chain). */
function resolveKey(): Buffer {
  return resolveKeys()[0];
}

/** Decodes and length-checks key material, naming the offending var on error. */
function parseKeyOrThrow(value: string, varName: string): Buffer {
  const decoded = decodeKeyMaterial(value);
  if (decoded.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${varName} must decode to ${KEY_LENGTH_BYTES} bytes (got ${decoded.length}). Provide 32 bytes as base64 or hex.`,
    );
  }
  return decoded;
}

/**
 * Test-only: clears the memoized key chain so a test can change env vars.
 * Production code never needs this — the chain is stable for a process.
 */
export function resetSecretBoxKeyCacheForTests(): void {
  cachedKeys = null;
}

/**
 * Decodes user-supplied key material as base64 first, then hex. A 64-char hex
 * string also happens to be valid base64, so hex is attempted only when base64
 * decoding does not yield exactly the key length.
 */
function decodeKeyMaterial(value: string): Buffer {
  const asBase64 = Buffer.from(value, "base64");
  if (asBase64.length === KEY_LENGTH_BYTES) return asBase64;
  const asHex = Buffer.from(value, "hex");
  if (asHex.length === KEY_LENGTH_BYTES) return asHex;
  // Return whichever we got so the length check upstream reports a clear error.
  return asBase64;
}

/**
 * Returns `true` when a stored value is ciphertext produced by this module.
 * Used to distinguish encrypted fields from legacy plaintext.
 */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX);
}

/**
 * Encrypts a plaintext secret into the self-describing ciphertext envelope.
 *
 * @param plaintext - The secret to protect (e.g. an OAuth token or API key).
 * @returns The `enc:v1:…` envelope string, or `null` when given null/empty.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  // Already encrypted — never double-wrap (defensive: re-encrypting a stored
  // ciphertext would make it undecryptable). Matches the group repo's guard.
  if (isEncryptedSecret(plaintext)) return plaintext;
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CIPHERTEXT_PREFIX.slice(0, -1), // "enc:v1"
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypts a value previously produced by {@link encryptSecret}. Values that are
 * not in the ciphertext envelope (legacy plaintext) are returned unchanged so
 * reads keep working until the row is rewritten.
 *
 * @throws {Error} When the envelope is malformed or authentication fails (which
 *                 indicates tampering or a wrong/rotated key).
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!isEncryptedSecret(stored)) return stored; // legacy plaintext

  const parts = stored.split(":");
  // ["enc","v1",iv,tag,ct]
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted secret envelope: expected enc:v1:iv:tag:ciphertext.");
  }
  const [, , ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");

  // Try each key in the chain. GCM authenticates, so a wrong key throws rather
  // than returning garbage — that makes "try the next one" safe, and it is what
  // lets a new CONNECTOR_ENCRYPTION_KEY be adopted without orphaning rows
  // written under a retired key or the AUTH_SECRET derivation.
  const keys = resolveKeys();
  let lastError: unknown;
  for (const key of keys) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to decrypt secret with any configured key (tried ${keys.length}). ` +
      "The value was written under a key that is no longer configured — restore it via " +
      "CONNECTOR_ENCRYPTION_KEY_PREVIOUS. " +
      `Underlying error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
