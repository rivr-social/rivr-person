import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getInstanceConfig: vi.fn(),
}));

vi.mock("@/lib/auth/get-session", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@/lib/federation/instance-config", () => ({
  getInstanceConfig: mocks.getInstanceConfig,
}));

import {
  isConfiguredSovereignOwner,
  isLocalSignupAllowed,
  resolveSovereignOwner,
} from "@/lib/auth/sovereign-owner";

function session(id: string) {
  return {
    user: {
      id,
      email: null,
      name: null,
      image: null,
      homeBaseUrl: null,
      authMethod: "nextauth",
      isOwner: true,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("sovereign owner authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstanceConfig.mockReturnValue({ primaryAgentId: "owner-1" });
  });

  it("fails closed when there is no authenticated session", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(resolveSovereignOwner()).resolves.toEqual({
      ok: false,
      status: 401,
      error: "Authentication required",
    });
  });

  it("fails closed when PRIMARY_AGENT_ID is missing", async () => {
    mocks.getSession.mockResolvedValue(session("owner-1"));
    mocks.getInstanceConfig.mockReturnValue({ primaryAgentId: null });
    await expect(resolveSovereignOwner()).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Sovereign owner is not configured",
    });
  });

  it("rejects an authenticated non-owner", async () => {
    mocks.getSession.mockResolvedValue(session("other-1"));
    await expect(resolveSovereignOwner()).resolves.toEqual({
      ok: false,
      status: 403,
      error: "Forbidden: owner-only resource",
    });
  });

  it("returns the configured owner", async () => {
    const ownerSession = session("owner-1");
    mocks.getSession.mockResolvedValue(ownerSession);
    await expect(resolveSovereignOwner()).resolves.toEqual({
      ok: true,
      owner: { agentId: "owner-1", session: ownerSession },
    });
  });

  it("never infers ownership from a missing configured id", () => {
    expect(isConfiguredSovereignOwner("owner-1", null)).toBe(false);
    expect(isConfiguredSovereignOwner("owner-1", "owner-1")).toBe(true);
  });

  it("disables Person local signup unless explicitly enabled", () => {
    expect(isLocalSignupAllowed("person", undefined)).toBe(false);
    expect(isLocalSignupAllowed("person", "false")).toBe(false);
    expect(isLocalSignupAllowed("person", "true")).toBe(true);
    expect(isLocalSignupAllowed("global", undefined)).toBe(true);
  });
});
