import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assertAgentHqAccess: vi.fn(),
  check: vi.fn(),
  createPermissionPolicy: vi.fn(),
  getPoliciesForTarget: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/agent-hq", () => ({ assertAgentHqAccess: mocks.assertAgentHqAccess }));
vi.mock("@/lib/permissions", () => ({
  check: mocks.check,
  createPermissionPolicy: mocks.createPermissionPolicy,
  deletePermissionPolicy: vi.fn(),
  getPoliciesForTarget: mocks.getPoliciesForTarget,
}));
vi.mock("@/lib/agent-hq/resource-access", () => ({
  GRANTABLE_VERBS: ["view", "use", "rent", "manage", "grant"],
  isGrantableVerb: (value: unknown) =>
    typeof value === "string" && ["view", "use", "rent", "manage", "grant"].includes(value),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  isNull: vi.fn((value: unknown) => ({ op: "isNull", value })),
}));
vi.mock("@/db/schema", () => ({
  resources: {
    id: "resources.id",
    deletedAt: "resources.deletedAt",
  },
}));
vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

import {
  GET,
  POST,
} from "@/app/api/agent-hq/resources/[id]/policies/route";

const context = { params: Promise.resolve({ id: "resource-1" }) };

function mockResourceSelect(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  mocks.dbSelect.mockReturnValue(chain);
}

describe("agent-hq resource policies route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.assertAgentHqAccess.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ allowed: true });
    mockResourceSelect([{ id: "resource-1" }]);
  });

  it("creates DENY policies with numeric conditions", async () => {
    mocks.createPermissionPolicy.mockResolvedValue("policy-1");

    const response = await POST(
      new Request("https://person.example/api/agent-hq/resources/resource-1/policies", {
        method: "POST",
        body: JSON.stringify({
          effect: "deny",
          allowedActions: ["view", "not-a-verb"],
          conditions: [{ key: "age", operator: "gte", value: 18 }],
          logicalOperator: "AND",
          label: "Adults only deny test",
        }),
      }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, policyId: "policy-1" });
    expect(mocks.createPermissionPolicy).toHaveBeenCalledWith({
      creatorId: "user-1",
      targetId: "resource-1",
      targetType: "resource",
      effect: "deny",
      allowedActions: ["view"],
      conditions: [{ key: "age", operator: "gte", value: 18 }],
      logicalOperator: "AND",
      localeScope: undefined,
      label: "Adults only deny test",
    });
  });

  it("returns policy effect when listing policies", async () => {
    mocks.getPoliciesForTarget.mockResolvedValue([
      {
        id: "policy-1",
        name: "Policy",
        metadata: {
          effect: "deny",
          allowedActions: ["view"],
          conditions: [{ key: "id", operator: "exists", value: "" }],
          logicalOperator: "AND",
        },
      },
    ]);

    const response = await GET(
      new Request("https://person.example/api/agent-hq/resources/resource-1/policies"),
      context,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policies[0]).toMatchObject({
      id: "policy-1",
      effect: "deny",
      allowedActions: ["view"],
    });
  });
});
