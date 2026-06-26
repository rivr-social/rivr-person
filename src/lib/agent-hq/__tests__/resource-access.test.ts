import { describe, expect, it } from "vitest";
import {
  GRANTABLE_VERBS,
  isGrantableVerb,
  shapeAccessGrants,
  shapeLedgerHistory,
  summarizeLedgerVerb,
  type AgentIdentity,
  type RawGrantRow,
  type RawLedgerRow,
} from "@/lib/agent-hq/resource-access";

const lookup = new Map<string, AgentIdentity>([
  ["a1", { id: "a1", name: "Alice", image: "/a.png" }],
  ["a2", { id: "a2", name: "Bob", image: null, isPersona: true }],
]);

describe("GRANTABLE_VERBS / isGrantableVerb", () => {
  it("exposes the simple sharing spectrum", () => {
    expect(GRANTABLE_VERBS).toEqual(["view", "use", "manage", "share"]);
  });

  it("accepts grantable verbs and rejects others", () => {
    expect(isGrantableVerb("view")).toBe(true);
    expect(isGrantableVerb("manage")).toBe(true);
    expect(isGrantableVerb("own")).toBe(false);
    expect(isGrantableVerb("grant")).toBe(false);
    expect(isGrantableVerb(42)).toBe(false);
  });
});

describe("shapeAccessGrants", () => {
  it("humanizes subjects, flags personas, and sorts by name then verb", () => {
    const rows: RawGrantRow[] = [
      { subjectId: "a2", action: "view", role: null, scope: "locale", grantedAt: new Date("2026-01-02T00:00:00Z") },
      { subjectId: "a1", action: "manage", role: "editor", scope: "global", grantedAt: "2026-01-01T00:00:00Z" },
    ];
    const grants = shapeAccessGrants(rows, lookup);
    expect(grants.map((g) => g.subjectName)).toEqual(["Alice", "Bob"]);
    expect(grants[0]).toMatchObject({
      subjectId: "a1",
      subjectName: "Alice",
      subjectImage: "/a.png",
      isPersona: false,
      verb: "manage",
      role: "editor",
      scope: "global",
    });
    expect(grants[1]).toMatchObject({ subjectId: "a2", isPersona: true, subjectImage: null });
    expect(grants[1].grantedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("drops rows whose action is not a grantable verb", () => {
    const rows: RawGrantRow[] = [
      { subjectId: "a1", action: "own", role: null, scope: null, grantedAt: new Date() },
      { subjectId: "a1", action: null, role: null, scope: null, grantedAt: new Date() },
      { subjectId: "a1", action: "view", role: null, scope: null, grantedAt: new Date() },
    ];
    const grants = shapeAccessGrants(rows, lookup);
    expect(grants).toHaveLength(1);
    expect(grants[0].verb).toBe("view");
  });

  it("falls back to 'Unknown agent' for missing identities", () => {
    const rows: RawGrantRow[] = [
      { subjectId: "ghost", action: "view", role: null, scope: null, grantedAt: new Date() },
    ];
    const grants = shapeAccessGrants(rows, lookup);
    expect(grants[0].subjectName).toBe("Unknown agent");
    expect(grants[0].subjectImage).toBeNull();
  });
});

describe("summarizeLedgerVerb", () => {
  it("describes grant/revoke with the effective action", () => {
    expect(summarizeLedgerVerb("grant", { action: "view" })).toBe("granted view");
    expect(summarizeLedgerVerb("revoke", { action: "use" })).toBe("revoked use");
    expect(summarizeLedgerVerb("grant", null)).toBe("granted access");
  });

  it("maps CRUD verbs to readable summaries and passes through unknowns", () => {
    expect(summarizeLedgerVerb("create", null)).toBe("created");
    expect(summarizeLedgerVerb("update", null)).toBe("updated");
    expect(summarizeLedgerVerb("delete", null)).toBe("deleted");
    expect(summarizeLedgerVerb("transact", null)).toBe("transact");
  });
});

describe("shapeLedgerHistory", () => {
  it("orders newest-first and humanizes subject + summary", () => {
    const rows: RawLedgerRow[] = [
      {
        id: "l1",
        verb: "create",
        subjectId: "a1",
        objectType: "resource",
        metadata: null,
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "l2",
        verb: "grant",
        subjectId: "a1",
        objectType: "resource",
        metadata: { action: "view" },
        timestamp: "2026-01-03T00:00:00Z",
      },
    ];
    const history = shapeLedgerHistory(rows, lookup);
    expect(history.map((h) => h.id)).toEqual(["l2", "l1"]);
    expect(history[0]).toMatchObject({ subjectName: "Alice", summary: "granted view" });
    expect(history[1].summary).toBe("created");
  });
});
