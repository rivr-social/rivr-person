/**
 * @fileoverview Server-only encryption-at-rest for sensitive connector config.
 *
 * Connector configuration is persisted inside
 * `agents.metadata.autobotSettings.connections[].config` (a JSONB string map).
 * Some of those keys hold secrets — pasted API keys, OAuth/bot tokens, app
 * passwords. Per the connector rearch locked decision, secret config values
 * (starting with the DNS/deploy connectors) MUST be stored encrypted-at-rest,
 * never as plaintext in the blob.
 *
 * This module wraps `@/lib/crypto/secret-box` (AES-256-GCM, self-describing
 * `enc:v1:` envelope) with connector-aware helpers:
 *
 * - `encryptConnectorConfig` walks a config map and encrypts the values of
 *   known-secret keys, leaving non-secret keys untouched. It is idempotent:
 *   already-encrypted values are left as-is, so re-saving a connector does not
 *   double-encrypt.
 * - `decryptConnectorConfig` is the inverse, used by server-side consumers
 *   (deploy/DNS/test code) that need the cleartext. Legacy plaintext values
 *   pass through unchanged via the envelope's backward-compatibility rule.
 * - `redactConnectorConfig` masks secret values for any response that may reach
 *   the browser, so the connections API never ships token material to the client.
 *
 * IMPORTANT: this module imports Node `crypto` (via secret-box). It must only be
 * imported from server code — never from `@/lib/autobot-connectors`, which is
 * shared with client components.
 */
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/crypto/secret-box";

/**
 * Config keys whose values are secrets and must be encrypted at rest. Matched
 * case-insensitively against the connector config map. Covers the DNS/deploy
 * connectors (`apiKey`) plus the common credential field names used across the
 * connector catalog so the encryption posture extends cleanly as more providers
 * adopt it.
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(
  [
    "apiKey",
    "token",
    "accessToken",
    "refreshToken",
    "botToken",
    "bearerToken",
    "appPassword",
    "appSecret",
    "appKey",
    "clientSecret",
    "webhookSecret",
    "verifyToken",
    "licenseKey",
    "smtpPass",
  ].map((key) => key.toLowerCase()),
);

/** Placeholder returned to clients in place of a stored secret value. */
export const REDACTED_SECRET_PLACEHOLDER = "__stored__";

/** Returns true when a config key holds a secret that must be encrypted. */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key.toLowerCase());
}

/**
 * Encrypts the secret-bearing values of a connector config map. Non-secret keys
 * and already-encrypted values are passed through unchanged (idempotent).
 *
 * @param config - The connector config map (plaintext or partially encrypted).
 * @returns A new config map with secret values encrypted at rest.
 */
export function encryptConnectorConfig(
  config: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key) && value && !isEncryptedSecret(value)) {
      const encrypted = encryptSecret(value);
      next[key] = encrypted ?? value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Decrypts the secret-bearing values of a connector config map for server-side
 * use. Legacy plaintext values pass through unchanged.
 *
 * @param config - The stored connector config map.
 * @returns A new config map with secret values in cleartext.
 */
export function decryptConnectorConfig(
  config: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key) && value) {
      next[key] = decryptSecret(value) ?? value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Decrypts a single stored secret value (e.g. a connector API key) for use when
 * calling the provider. Plaintext passes through unchanged.
 */
export function decryptConnectorSecret(value: string | null | undefined): string {
  if (!value) return "";
  return decryptSecret(value) ?? "";
}

/**
 * Replaces secret config values with a non-reversible placeholder so they can be
 * safely returned to the client. A present secret becomes
 * {@link REDACTED_SECRET_PLACEHOLDER}; an absent one is omitted, letting the UI
 * distinguish "configured" from "not set" without exposing the value.
 *
 * @param config - The stored connector config map.
 * @returns A new config map safe to serialize to the browser.
 */
export function redactConnectorConfig(
  config: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key)) {
      if (value) next[key] = REDACTED_SECRET_PLACEHOLDER;
    } else {
      next[key] = value;
    }
  }
  return next;
}
