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
import {
  REDACTED_SECRET_PLACEHOLDER,
  type AutobotConnection,
} from "@/lib/autobot-connectors";
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

/**
 * Placeholder returned to clients in place of a stored secret value.
 * Sourced from the client-safe connector module so the browser and the server
 * share ONE definition rather than mirroring the string; re-exported here to
 * keep this module's existing import surface intact.
 */
export { REDACTED_SECRET_PLACEHOLDER };

/**
 * Providers whose secret config values are encrypted at rest. Scoped to the new
 * credential-bearing connectors (the Claude Code token and the DNS/deploy API
 * keys) so the existing connectors' read paths keep working unchanged. The
 * decrypt helpers pass plaintext through, so this set can grow without a
 * migration as more providers adopt encryption.
 */
export const ENCRYPTED_SECRET_PROVIDERS: ReadonlySet<string> = new Set([
  "claude_code",
  "cloudflare",
  "squarespace",
  "namecheap",
  "github",
]);

/**
 * Encrypts a connector's secret config values only when the provider is opted
 * into encryption-at-rest; otherwise returns the config unchanged.
 */
export function encryptConnectorConfigForProvider(
  provider: string,
  config: Record<string, string>,
): Record<string, string> {
  if (!ENCRYPTED_SECRET_PROVIDERS.has(provider)) return config;
  return encryptConnectorConfig(config);
}

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
 * Resolves the decrypted Claude Code token from an agent's connector lane, if a
 * connected `claude_code` connector with a token is present. Used to drive the
 * assistant chat AND the builder off the agent's own pasted token (A4), so one
 * credential powers both surfaces for that agent.
 *
 * @param connections - The agent's connector lane (from autobot settings).
 * @returns The cleartext token, or `undefined` when none is configured.
 */
export function resolveClaudeCodeConnectorToken(
  connections: AutobotConnection[] | undefined,
): string | undefined {
  if (!Array.isArray(connections)) return undefined;
  const connector = connections.find(
    (connection) => connection.provider === "claude_code",
  );
  if (!connector) return undefined;
  const token = decryptConnectorSecret(connector.config.token);
  return token || undefined;
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
