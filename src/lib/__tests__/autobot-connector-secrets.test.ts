import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REDACTED_SECRET_PLACEHOLDER,
  decryptConnectorConfig,
  decryptConnectorSecret,
  encryptConnectorConfig,
  isSecretConfigKey,
  redactConnectorConfig,
} from "../autobot-connector-secrets";
import { isEncryptedSecret } from "../crypto/secret-box";

describe("autobot-connector-secrets", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AUTH_SECRET: "test-auth-secret-for-connector-secrets",
    };
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("identifies secret keys case-insensitively", () => {
    expect(isSecretConfigKey("apiKey")).toBe(true);
    expect(isSecretConfigKey("APIKEY")).toBe(true);
    expect(isSecretConfigKey("token")).toBe(true);
    expect(isSecretConfigKey("zoneId")).toBe(false);
    expect(isSecretConfigKey("domain")).toBe(false);
  });

  it("encrypts only secret-bearing config values", () => {
    const encrypted = encryptConnectorConfig({
      apiKey: "cf-secret-key",
      zoneId: "zone-123",
      domain: "example.com",
    });

    expect(isEncryptedSecret(encrypted.apiKey)).toBe(true);
    expect(encrypted.zoneId).toBe("zone-123");
    expect(encrypted.domain).toBe("example.com");
    expect(decryptConnectorConfig(encrypted).apiKey).toBe("cf-secret-key");
  });

  it("is idempotent — does not double-encrypt an already-encrypted value", () => {
    const once = encryptConnectorConfig({ apiKey: "k" });
    const twice = encryptConnectorConfig(once);
    expect(twice.apiKey).toBe(once.apiKey);
    expect(decryptConnectorConfig(twice).apiKey).toBe("k");
  });

  it("round-trips a single secret via decryptConnectorSecret", () => {
    const encrypted = encryptConnectorConfig({ token: "ghp_xyz" });
    expect(decryptConnectorSecret(encrypted.token)).toBe("ghp_xyz");
    expect(decryptConnectorSecret(null)).toBe("");
    expect(decryptConnectorSecret(undefined)).toBe("");
  });

  it("passes through legacy plaintext on decrypt", () => {
    expect(decryptConnectorConfig({ apiKey: "legacy-plain" }).apiKey).toBe(
      "legacy-plain",
    );
  });

  it("redacts present secrets and omits absent ones for client output", () => {
    const redacted = redactConnectorConfig({
      apiKey: encryptConnectorConfig({ apiKey: "real" }).apiKey,
      zoneId: "zone-123",
    });
    expect(redacted.apiKey).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(redacted.zoneId).toBe("zone-123");

    const noSecret = redactConnectorConfig({ zoneId: "z" });
    expect(noSecret.apiKey).toBeUndefined();
  });
});
