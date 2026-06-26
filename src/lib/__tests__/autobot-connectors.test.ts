import { describe, expect, it } from "vitest";
import {
  AUTOBOT_CONNECTOR_DEFINITIONS,
  USER_CONNECTABLE_PROVIDERS,
  filterSharedConnections,
  sanitizeAutobotConnections,
  type AutobotConnectionProvider,
} from "@/lib/autobot-connectors";

const SETTINGS_PROVIDERS: AutobotConnectionProvider[] = USER_CONNECTABLE_PROVIDERS;

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

describe("connector sharing / inheritance", () => {
  it("preserves the shared flag through sanitization and drops falsey values", () => {
    const [sharedConnection, privateConnection] = sanitizeAutobotConnections([
      { provider: "slack", status: "connected", syncDirection: "import", config: {}, shared: true },
      { provider: "notion", status: "connected", syncDirection: "import", config: {}, shared: false },
    ]);

    expect(sharedConnection.shared).toBe(true);
    // A non-true value normalizes to undefined (private by default).
    expect(privateConnection.shared).toBeUndefined();
  });

  it("filterSharedConnections returns only the shared subset (persona inheritance)", () => {
    const connections = sanitizeAutobotConnections([
      { provider: "slack", status: "connected", syncDirection: "import", config: {}, shared: true },
      { provider: "notion", status: "connected", syncDirection: "import", config: {} },
      { provider: "telegram", status: "connected", syncDirection: "import", config: {}, shared: true },
    ]);

    const shared = filterSharedConnections(connections);

    expect(shared.map((connection) => connection.provider).sort()).toEqual([
      "slack",
      "telegram",
    ]);
  });
});
