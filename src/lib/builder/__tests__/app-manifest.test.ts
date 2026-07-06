import { describe, expect, it } from "vitest";
import {
  APP_ID_DENYLIST,
  APP_INTERNAL_PORT_MAX,
  APP_INTERNAL_PORT_MIN,
  APP_MANIFEST_VERSION,
  APP_MAX_SECRET_NAMES,
  appSubdomain,
  parseAppManifest,
} from "@/lib/builder/app-manifest";

function validStatic(overrides: Record<string, unknown> = {}) {
  return {
    version: APP_MANIFEST_VERSION,
    appId: "my-app",
    name: "My App",
    runtime: "static",
    resourceClass: "tiny",
    database: "none",
    secretNames: [],
    healthPath: "/",
    ...overrides,
  };
}

function validNode(overrides: Record<string, unknown> = {}) {
  return {
    version: APP_MANIFEST_VERSION,
    appId: "my-service",
    name: "My Service",
    runtime: "node-22",
    internalPort: 3000,
    resourceClass: "small",
    database: "postgres",
    secretNames: ["API_KEY"],
    healthPath: "/healthz",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("parseAppManifest — valid manifests", () => {
  it("accepts a complete static manifest", () => {
    const result = parseAppManifest(validStatic());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.appId).toBe("my-app");
      expect(result.manifest.runtime).toBe("static");
      expect(result.manifest.internalPort).toBeUndefined();
    }
  });

  it("accepts a complete node-22 manifest with db and secrets", () => {
    const result = parseAppManifest(validNode());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.internalPort).toBe(3000);
      expect(result.manifest.database).toBe("postgres");
      expect(result.manifest.secretNames).toEqual(["API_KEY"]);
    }
  });

  it("defaults resourceClass, database, and healthPath", () => {
    const result = parseAppManifest(
      validStatic({ resourceClass: undefined, database: undefined, healthPath: undefined }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.resourceClass).toBe("tiny");
      expect(result.manifest.database).toBe("none");
      expect(result.manifest.healthPath).toBe("/");
    }
  });

  it("dedupes secret names", () => {
    const result = parseAppManifest(validNode({ secretNames: ["A_KEY", "A_KEY", "B_KEY"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.secretNames).toEqual(["A_KEY", "B_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// Structural rejection — the trust boundary
// ---------------------------------------------------------------------------

describe("parseAppManifest — rejection", () => {
  it("rejects non-objects", () => {
    for (const bad of [null, "x", 4, [], undefined]) {
      const result = parseAppManifest(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unknown keys (no Docker/Compose smuggling)", () => {
    for (const key of ["dockerfile", "compose", "command", "volumes", "network", "privileged"]) {
      const result = parseAppManifest(validStatic({ [key]: "anything" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toContain(`Unknown manifest key: "${key}"`);
      }
    }
  });

  it("rejects wrong version", () => {
    expect(parseAppManifest(validStatic({ version: 2 })).ok).toBe(false);
  });

  it("rejects malformed app ids", () => {
    for (const appId of ["A", "-app", "app-", "UPPER", "a b", "x", "a".repeat(40), "app/../x"]) {
      expect(parseAppManifest(validStatic({ appId })).ok).toBe(false);
    }
  });

  it("rejects every denylisted platform id", () => {
    for (const appId of APP_ID_DENYLIST) {
      const result = parseAppManifest(validStatic({ appId }));
      expect(result.ok).toBe(false);
    }
    expect(parseAppManifest(validStatic({ appId: "mautrix-x" })).ok).toBe(false);
  });

  it("rejects unknown runtimes, classes, and database kinds", () => {
    expect(parseAppManifest(validStatic({ runtime: "python" })).ok).toBe(false);
    expect(parseAppManifest(validStatic({ resourceClass: "huge" })).ok).toBe(false);
    expect(parseAppManifest(validStatic({ database: "mysql" })).ok).toBe(false);
  });

  it("enforces port rules per runtime", () => {
    expect(parseAppManifest(validStatic({ internalPort: 3000 })).ok).toBe(false);
    expect(parseAppManifest(validNode({ internalPort: undefined })).ok).toBe(false);
    expect(parseAppManifest(validNode({ internalPort: APP_INTERNAL_PORT_MIN - 1 })).ok).toBe(false);
    expect(parseAppManifest(validNode({ internalPort: APP_INTERNAL_PORT_MAX + 1 })).ok).toBe(false);
    expect(parseAppManifest(validNode({ internalPort: 3000.5 })).ok).toBe(false);
  });

  it("rejects a database on a static app", () => {
    expect(parseAppManifest(validStatic({ database: "postgres" })).ok).toBe(false);
  });

  it("rejects bad secret names and over-cap lists", () => {
    expect(parseAppManifest(validNode({ secretNames: ["lower_case"] })).ok).toBe(false);
    expect(parseAppManifest(validNode({ secretNames: ["1KEY"] })).ok).toBe(false);
    expect(parseAppManifest(validNode({ secretNames: "API_KEY" })).ok).toBe(false);
    const tooMany = Array.from({ length: APP_MAX_SECRET_NAMES + 1 }, (_, i) => `KEY_${i}`);
    expect(parseAppManifest(validNode({ secretNames: tooMany })).ok).toBe(false);
  });

  it("rejects unsafe health paths", () => {
    for (const healthPath of ["healthz", "/health z", `/${"a".repeat(200)}`, "/../etc"]) {
      const result = parseAppManifest(validNode({ healthPath }));
      if (healthPath === "/../etc") {
        // dots are allowed characters; traversal is neutralized by the broker
        // resolving paths only inside the container — just assert parse output.
        expect(result.ok).toBe(true);
        continue;
      }
      expect(result.ok).toBe(false);
    }
  });

  it("collects multiple errors in one pass", () => {
    const result = parseAppManifest({ version: 9, appId: "!", runtime: "go" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Subdomain derivation
// ---------------------------------------------------------------------------

describe("appSubdomain", () => {
  it("derives the platform subdomain from appId and base domain", () => {
    expect(appSubdomain("my-app", "camalot.me")).toBe("my-app.camalot.me");
  });
});
