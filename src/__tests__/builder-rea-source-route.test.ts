import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveDirectAgent: vi.fn(),
  check: vi.fn(),
  canViewPredicate: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/assistant/resolve-direct-agent", () => ({
  resolveDirectAgent: mocks.resolveDirectAgent,
}));
vi.mock("@/lib/permissions", () => ({
  check: mocks.check,
  canViewPredicate: mocks.canViewPredicate,
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  desc: vi.fn((value: unknown) => ({ op: "desc", value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  inArray: vi.fn((left: unknown, values: unknown[]) => ({ op: "inArray", left, values })),
  isNull: vi.fn((value: unknown) => ({ op: "isNull", value })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
}));
vi.mock("@/db/schema", () => ({
  agents: {
    id: "agents.id",
    type: { enumValues: ["person", "group"] },
    deletedAt: "agents.deletedAt",
    name: "agents.name",
  },
  ledger: {
    id: "ledger.id",
    isActive: "ledger.isActive",
    verb: { enumValues: ["view", "use"] },
    subjectId: "ledger.subjectId",
    objectId: "ledger.objectId",
    timestamp: "ledger.timestamp",
  },
  resources: {
    id: "resources.id",
    type: { enumValues: ["note", "image"] },
    deletedAt: "resources.deletedAt",
    updatedAt: "resources.updatedAt",
  },
}));
vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

import { GET } from "@/app/api/builder/rea-source/route";

function mockRows(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  mocks.dbSelect.mockReturnValue(chain);
  return chain;
}

describe("builder REA source route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.resolveDirectAgent.mockResolvedValue({ directAgentId: "agent-1" });
    mocks.check.mockResolvedValue({ allowed: true });
    mocks.canViewPredicate.mockResolvedValue({ allowed: true });
  });

  it("rejects REA reads without selected source ids", async () => {
    const response = await GET(
      new Request("https://person.example/api/builder/rea-source?kind=rivr-resources"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "REA source scope must include at least one selected id." });
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("enforces ABAC view checks for every resource row, including public rows", async () => {
    mockRows([
      {
        id: "public-denied",
        type: "note",
        name: "Denied",
        description: null,
        content: "secret",
        visibility: "public",
        tags: [],
        ownerId: "agent-2",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: "allowed",
        type: "note",
        name: "Allowed",
        description: null,
        content: "visible",
        visibility: "public",
        tags: [],
        ownerId: "agent-2",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);
    mocks.check
      .mockResolvedValueOnce({ allowed: false, reason: "abac_deny" })
      .mockResolvedValueOnce({ allowed: true, reason: "public_visibility" });

    const response = await GET(
      new Request("https://person.example/api/builder/rea-source?kind=rivr-resources&ids=public-denied,allowed"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.check).toHaveBeenCalledWith("agent-1", "view", "public-denied", "resource");
    expect(mocks.check).toHaveBeenCalledWith("agent-1", "view", "allowed", "resource");
    expect(body).toMatchObject({
      kind: "rivr-resources",
      count: 1,
      items: [{ id: "allowed", content: "visible" }],
    });
  });

  it("filters ledger rows through predicate visibility", async () => {
    mockRows([
      {
        id: "edge-denied",
        verb: "view",
        subjectId: "agent-2",
        objectId: "resource-1",
        objectType: "resource",
        role: null,
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        resourceId: "resource-1",
      },
      {
        id: "edge-allowed",
        verb: "use",
        subjectId: "agent-1",
        objectId: "resource-2",
        objectType: "resource",
        role: null,
        timestamp: new Date("2026-01-02T00:00:00.000Z"),
        resourceId: "resource-2",
      },
    ]);
    mocks.canViewPredicate
      .mockResolvedValueOnce({ allowed: false, reason: "abac_deny" })
      .mockResolvedValueOnce({ allowed: true, reason: "direct_grant" });

    const response = await GET(
      new Request("https://person.example/api/builder/rea-source?kind=rivr-ledger&ids=resource-1,resource-2"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.canViewPredicate).toHaveBeenCalledWith("agent-1", "edge-denied");
    expect(mocks.canViewPredicate).toHaveBeenCalledWith("agent-1", "edge-allowed");
    expect(body).toMatchObject({
      kind: "rivr-ledger",
      count: 1,
      items: [{ id: "edge-allowed", resourceId: "resource-2" }],
    });
  });
});
