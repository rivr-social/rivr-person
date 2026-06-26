/**
 * Tests for `src/lib/federation/visitor-access-policy.ts`.
 *
 * Covers parse/validation of the owner-submitted visitor access policy:
 *   - rejects non-object / wrong-typed fields
 *   - enforces the TTL bounds
 *   - narrows capabilities to the known, non-baseline set
 *   - accepts a fully-valid payload
 */

import { describe, expect, it } from "vitest";

import {
  MAX_VISITOR_TTL_MINUTES,
  MIN_VISITOR_TTL_MINUTES,
  parseVisitorAccessBody,
} from "@/lib/federation/visitor-access-policy";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    allowedCapabilities: ["react", "comment"],
    sessionTtlMinutes: 30,
    recordVisits: true,
    ...overrides,
  };
}

describe("parseVisitorAccessBody", () => {
  it("rejects a non-object body", () => {
    const result = parseVisitorAccessBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON object/);
  });

  it("rejects a non-boolean enabled", () => {
    const result = parseVisitorAccessBody(validBody({ enabled: "yes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enabled/);
  });

  it("rejects a non-boolean recordVisits", () => {
    const result = parseVisitorAccessBody(validBody({ recordVisits: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/recordVisits/);
  });

  it("rejects a TTL below the minimum", () => {
    const result = parseVisitorAccessBody(
      validBody({ sessionTtlMinutes: MIN_VISITOR_TTL_MINUTES - 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sessionTtlMinutes/);
  });

  it("rejects a TTL above the maximum", () => {
    const result = parseVisitorAccessBody(
      validBody({ sessionTtlMinutes: MAX_VISITOR_TTL_MINUTES + 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sessionTtlMinutes/);
  });

  it("rejects a non-integer TTL", () => {
    const result = parseVisitorAccessBody(
      validBody({ sessionTtlMinutes: 12.5 }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array allowedCapabilities", () => {
    const result = parseVisitorAccessBody(
      validBody({ allowedCapabilities: "react" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/allowedCapabilities/);
  });

  it("drops unknown capabilities and the baseline 'read'", () => {
    const result = parseVisitorAccessBody(
      validBody({
        allowedCapabilities: ["read", "react", "fly", "comment", 42],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedCapabilities.sort()).toEqual(
        ["comment", "react"].sort(),
      );
    }
  });

  it("de-duplicates capabilities", () => {
    const result = parseVisitorAccessBody(
      validBody({ allowedCapabilities: ["react", "react", "rsvp"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedCapabilities.sort()).toEqual(
        ["react", "rsvp"].sort(),
      );
    }
  });

  it("accepts a fully-valid payload at the TTL bounds", () => {
    const lower = parseVisitorAccessBody(
      validBody({ sessionTtlMinutes: MIN_VISITOR_TTL_MINUTES }),
    );
    const upper = parseVisitorAccessBody(
      validBody({ sessionTtlMinutes: MAX_VISITOR_TTL_MINUTES }),
    );
    expect(lower.ok).toBe(true);
    expect(upper.ok).toBe(true);
    if (lower.ok) {
      expect(lower.value).toMatchObject({
        enabled: true,
        sessionTtlMinutes: MIN_VISITOR_TTL_MINUTES,
        recordVisits: true,
      });
    }
  });
});
