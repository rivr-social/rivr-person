import { describe, expect, it } from "vitest";
import {
  AUTOBOT_CONNECTOR_DEFINITIONS,
  sanitizeAutobotConnections,
  type AutobotConnectionProvider,
} from "@/lib/autobot-connectors";

const SETTINGS_PROVIDERS: AutobotConnectionProvider[] = [
  "google_docs",
  "google_calendar",
  "gmail",
  "notion",
  "telegram",
  "whatsapp_business",
  "signal",
  "slack",
  "facebook",
  "instagram",
  "substack",
  "luma",
  "x",
];

describe("settings connector catalog", () => {
  it("defines every provider exposed by user settings", () => {
    const definitions = new Map(
      AUTOBOT_CONNECTOR_DEFINITIONS.map((definition) => [definition.provider, definition]),
    );

    expect(SETTINGS_PROVIDERS.every((provider) => definitions.has(provider))).toBe(true);
    expect(definitions.get("google_docs")?.label).toBe("Google Drive");
  });

  it("retains the added connector records during sanitization", () => {
    const sanitized = sanitizeAutobotConnections(
      SETTINGS_PROVIDERS.map((provider) => ({
        provider,
        status: "connected",
        syncDirection: "import",
        config: {},
      })),
    );

    expect(sanitized.map((connection) => connection.provider)).toEqual(SETTINGS_PROVIDERS);
  });
});
