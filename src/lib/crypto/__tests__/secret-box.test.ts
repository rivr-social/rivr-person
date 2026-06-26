import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secret-box";

/**
 * The key is memoized per-process inside secret-box, so these tests rely on a
 * stable AUTH_SECRET fallback set before the first encrypt/decrypt call. We set
 * it in beforeEach and never change it within a run.
 */
describe("crypto/secret-box", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AUTH_SECRET: "test-auth-secret-for-secret-box-deterministic",
    };
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("round-trips a plaintext secret through the enc:v1 envelope", () => {
    const plaintext = "cf_dns_api_key_abc123XYZ";
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).toBeTruthy();
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted!.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces distinct ciphertext for the same plaintext (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("treats null/empty as null on both encrypt and decrypt", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(encryptSecret("")).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });

  it("passes through legacy plaintext unchanged on decrypt", () => {
    // A value written before encryption existed has no envelope prefix.
    expect(isEncryptedSecret("legacy-plaintext-token")).toBe(false);
    expect(decryptSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("throws on a tampered ciphertext envelope (auth tag mismatch)", () => {
    const encrypted = encryptSecret("tamper-target")!;
    const parts = encrypted.split(":");
    // Flip the ciphertext segment to a different valid-length base64url payload.
    parts[4] = Buffer.from("different-bytes-here").toString("base64url");
    const tampered = parts.join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed envelope shape", () => {
    expect(() => decryptSecret("enc:v1:onlytwo")).toThrow(
      /Malformed encrypted secret envelope/,
    );
  });
});
