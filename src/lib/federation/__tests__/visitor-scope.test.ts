/**
 * Tests for `src/lib/federation/visitor-scope.ts`.
 *
 * Covers the visitor capability model + owner-policy resolver:
 *   - sanitizeCapabilities narrows to known, non-baseline, de-duplicated values
 *   - defaultVisitorScope is the safe read-only default
 *   - visitorCan reflects the resolved scope's capability set
 *   - resolveVisitorScope:
 *       - no row → default
 *       - row → baseline + sanitized extras, honoring enabled/ttl/recordVisits
 *       - bad/zero ttl → falls back to DEFAULT_VISITOR_TTL_MINUTES
 *       - db throws (pre-migration / missing table) → default (never throws)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `vi.mock` is hoisted; drive it from a mutable controller. `throwOnSelect`
// lets us simulate the pre-migration "table does not exist" path.
const dbMockController: {
  rows: unknown[];
  throwOnSelect: boolean;
  selectCalls: number;
} = { rows: [], throwOnSelect: false, selectCalls: 0 };

vi.mock("@/db", () => {
  return {
    db: {
      select: (...args: unknown[]) => {
        dbMockController.selectCalls += 1;
        void args;
        return {
          from: () => ({
            where: () => ({
              limit: async () => {
                if (dbMockController.throwOnSelect) {
                  throw new Error('relation "federated_visitor_settings" does not exist');
                }
                return dbMockController.rows;
              },
            }),
          }),
        };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import {
  BASELINE_VISITOR_CAPABILITY,
  DEFAULT_VISITOR_TTL_MINUTES,
  defaultVisitorScope,
  requiredVisitorCapability,
  resolveVisitorScope,
  sanitizeCapabilities,
  visitorCan,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";
import { resetInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

function makeRow(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    instanceId: INSTANCE_ID,
    enabled: true,
    allowedCapabilities: ["react", "comment"],
    sessionTtlMinutes: 30,
    recordVisits: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.INSTANCE_ID = INSTANCE_ID;
  process.env.INSTANCE_TYPE = "person";
  resetInstanceConfig();
  dbMockController.rows = [];
  dbMockController.throwOnSelect = false;
  dbMockController.selectCalls = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetInstanceConfig();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// sanitizeCapabilities
// ---------------------------------------------------------------------------

describe("sanitizeCapabilities", () => {
  it("returns an empty array for non-array input", () => {
    expect(sanitizeCapabilities(null)).toEqual([]);
    expect(sanitizeCapabilities("react")).toEqual([]);
    expect(sanitizeCapabilities(undefined)).toEqual([]);
    expect(sanitizeCapabilities(42)).toEqual([]);
  });

  it("drops the implicit baseline 'read'", () => {
    expect(sanitizeCapabilities(["read"])).toEqual([]);
    expect(sanitizeCapabilities(["read", "react"])).toEqual(["react"]);
  });

  it("drops unknown / forged / non-string values", () => {
    const result = sanitizeCapabilities(["react", "fly", 42, null, "comment"]);
    expect(result.sort()).toEqual(["comment", "react"].sort());
  });

  it("de-duplicates repeated capabilities", () => {
    expect(sanitizeCapabilities(["react", "react", "rsvp"]).sort()).toEqual(
      ["react", "rsvp"].sort(),
    );
  });

  it("keeps the full known non-baseline set", () => {
    const result = sanitizeCapabilities([
      "react",
      "comment",
      "rsvp",
      "message",
    ]);
    expect(result.sort()).toEqual(
      ["comment", "message", "react", "rsvp"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// defaultVisitorScope
// ---------------------------------------------------------------------------

describe("defaultVisitorScope", () => {
  it("is enabled, read-only, default TTL, and records visits", () => {
    const scope = defaultVisitorScope();
    expect(scope.enabled).toBe(true);
    expect(scope.capabilities).toEqual([BASELINE_VISITOR_CAPABILITY]);
    expect(scope.ttlMinutes).toBe(DEFAULT_VISITOR_TTL_MINUTES);
    expect(scope.recordVisits).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// visitorCan
// ---------------------------------------------------------------------------

describe("visitorCan", () => {
  const scope: VisitorScope = {
    enabled: true,
    capabilities: ["read", "react"],
    ttlMinutes: 30,
    recordVisits: true,
  };

  it("returns true for a granted capability", () => {
    expect(visitorCan(scope, "read")).toBe(true);
    expect(visitorCan(scope, "react")).toBe(true);
  });

  it("returns false for an un-granted capability", () => {
    expect(visitorCan(scope, "comment")).toBe(false);
    expect(visitorCan(scope, "message")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requiredVisitorCapability
// ---------------------------------------------------------------------------

describe("requiredVisitorCapability", () => {
  it("maps reaction actions to 'react'", () => {
    expect(requiredVisitorCapability("react")).toBe("react");
    expect(requiredVisitorCapability("toggleReaction")).toBe("react");
  });

  it("maps createComment to 'comment'", () => {
    expect(requiredVisitorCapability("createComment")).toBe("comment");
  });

  it("maps rsvp to 'rsvp' and message_thread_start to 'message'", () => {
    expect(requiredVisitorCapability("rsvp")).toBe("rsvp");
    expect(requiredVisitorCapability("message_thread_start")).toBe("message");
  });

  it("returns null for owner/peer-only and unknown actions", () => {
    expect(requiredVisitorCapability("connect")).toBeNull();
    expect(requiredVisitorCapability("follow")).toBeNull();
    expect(requiredVisitorCapability("toggleFollowAgent")).toBeNull();
    expect(requiredVisitorCapability("createPostResource")).toBeNull();
    expect(requiredVisitorCapability("applyMembershipProjection")).toBeNull();
    expect(requiredVisitorCapability("kg_push_doc")).toBeNull();
    expect(requiredVisitorCapability("totally-made-up")).toBeNull();
    expect(requiredVisitorCapability(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveVisitorScope
// ---------------------------------------------------------------------------

describe("resolveVisitorScope", () => {
  it("returns the safe default when no row exists", async () => {
    dbMockController.rows = [];
    const scope = await resolveVisitorScope();
    expect(scope).toEqual(defaultVisitorScope());
  });

  it("returns the safe default (never throws) when the table is missing", async () => {
    dbMockController.throwOnSelect = true;
    const scope = await resolveVisitorScope();
    expect(scope).toEqual(defaultVisitorScope());
  });

  it("merges baseline + sanitized extras from the row", async () => {
    dbMockController.rows = [
      makeRow({ allowedCapabilities: ["read", "react", "fly", "comment"] }),
    ];
    const scope = await resolveVisitorScope();
    expect(scope.capabilities[0]).toBe(BASELINE_VISITOR_CAPABILITY);
    expect(scope.capabilities.sort()).toEqual(
      ["comment", "react", "read"].sort(),
    );
  });

  it("honors enabled=false, ttl, and recordVisits from the row", async () => {
    dbMockController.rows = [
      makeRow({
        enabled: false,
        sessionTtlMinutes: 120,
        recordVisits: false,
        allowedCapabilities: [],
      }),
    ];
    const scope = await resolveVisitorScope();
    expect(scope.enabled).toBe(false);
    expect(scope.ttlMinutes).toBe(120);
    expect(scope.recordVisits).toBe(false);
    expect(scope.capabilities).toEqual([BASELINE_VISITOR_CAPABILITY]);
  });

  it("falls back to the default TTL when the row's TTL is non-positive or non-integer", async () => {
    dbMockController.rows = [makeRow({ sessionTtlMinutes: 0 })];
    expect((await resolveVisitorScope()).ttlMinutes).toBe(
      DEFAULT_VISITOR_TTL_MINUTES,
    );

    dbMockController.rows = [makeRow({ sessionTtlMinutes: 12.5 })];
    expect((await resolveVisitorScope()).ttlMinutes).toBe(
      DEFAULT_VISITOR_TTL_MINUTES,
    );
  });
});
