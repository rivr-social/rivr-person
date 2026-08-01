/**
 * Tests for GPU-provider-key redaction and the shared secret sentinel.
 *
 * Origin (2026-08-01): `autobotSettings.gpuProviderApiKey` was stored as
 * PLAINTEXT inside `agents.metadata` and served to anyone through the public
 * profile route — a live 64-character Vast.ai key. Unlike connector configs it
 * never passed through `encryptConnectorConfig`, because it is a top-level
 * settings field rather than a connector `config` entry.
 *
 * The DB-backed encrypt/decrypt path is covered by the settings module itself;
 * these pin the two pure pieces that are easy to regress:
 *   1. redaction never emits the secret, and
 *   2. the sentinel has exactly ONE definition shared by client and server —
 *      duplicating a rule across the boundary is what made the tier upgrade
 *      unreachable in July.
 */
import { describe, it, expect } from "vitest";
import { REDACTED_SECRET_PLACEHOLDER } from "@/lib/autobot-connectors";
import { REDACTED_SECRET_PLACEHOLDER as SERVER_SENTINEL } from "@/lib/autobot-connector-secrets";
import {
  redactGpuApiKey,
  REDACTED_GPU_API_KEY,
  type AutobotUserSettings,
} from "@/lib/autobot-user-settings";

const LIVE_KEY = "453e65aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Minimal settings object; only the GPU field matters here. */
function settingsWith(gpuProviderApiKey: string): AutobotUserSettings {
  return { gpuProviderApiKey, voiceMode: "browser" } as AutobotUserSettings;
}

describe("the redaction sentinel is shared, not mirrored", () => {
  it("resolves to the same value on the client-safe and server modules", () => {
    expect(SERVER_SENTINEL).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(REDACTED_GPU_API_KEY).toBe(REDACTED_SECRET_PLACEHOLDER);
  });

  it("is a value no real credential could collide with", () => {
    expect(REDACTED_SECRET_PLACEHOLDER).toBe("__stored__");
  });
});

describe("redactGpuApiKey", () => {
  it("replaces a configured key with the sentinel, never the secret", () => {
    const redacted = redactGpuApiKey(settingsWith(LIVE_KEY));
    expect(redacted.gpuProviderApiKey).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(JSON.stringify(redacted)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(redacted)).not.toContain("453e65");
  });

  it("leaves an unset key empty so the UI can tell configured from not-set", () => {
    expect(redactGpuApiKey(settingsWith("")).gpuProviderApiKey).toBe("");
  });

  it("does not leak a stored ciphertext envelope either", () => {
    const redacted = redactGpuApiKey(settingsWith("enc:v1:aaa:bbb:ccc"));
    expect(redacted.gpuProviderApiKey).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(JSON.stringify(redacted)).not.toContain("enc:v1:");
  });

  it("preserves the rest of the settings object", () => {
    const redacted = redactGpuApiKey(settingsWith(LIVE_KEY));
    expect(redacted.voiceMode).toBe("browser");
  });

  it("does not mutate its input", () => {
    const original = settingsWith(LIVE_KEY);
    redactGpuApiKey(original);
    expect(original.gpuProviderApiKey).toBe(LIVE_KEY);
  });

  it("is idempotent — redacting a redacted object stays redacted", () => {
    const once = redactGpuApiKey(settingsWith(LIVE_KEY));
    expect(redactGpuApiKey(once).gpuProviderApiKey).toBe(REDACTED_SECRET_PLACEHOLDER);
  });
});
