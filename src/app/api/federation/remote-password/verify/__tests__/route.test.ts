import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the F13-hardened federation remote-password verify route.
 *
 * Regression targets:
 * - It used to accept a bare email+password from anyone → an open password /
 *   account-existence oracle that also returned the account's enriched profile.
 * - The route is now peer-authenticated (server-to-server only), per-IP AND
 *   per-email rate limited, gated on emailVerified, and returns a boolean only.
 *
 * All DB / bcrypt / auth / rate-limit / client-ip calls are mocked.
 */

const mocks = vi.hoisted(() => ({
  authorizeFederationRequest: vi.fn(),
  verify: vi.fn(),
  rateLimit: vi.fn(),
  getClientIp: vi.fn(),
  agentRow: vi.fn(),
}));

vi.mock("@/lib/federation-auth", () => ({
  authorizeFederationRequest: mocks.authorizeFederationRequest,
}));
vi.mock("@node-rs/bcrypt", () => ({ verify: mocks.verify }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  RATE_LIMITS: { AUTH: { limit: 5, windowMs: 60_000 } },
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: mocks.getClientIp }));
vi.mock("@/db/schema", () => ({
  agents: { id: "id", email: "email", passwordHash: "password_hash", emailVerified: "email_verified" },
}));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.agentRow(),
        }),
      }),
    }),
  },
}));

import { POST } from "@/app/api/federation/remote-password/verify/route";

const VERIFIED_AGENT = {
  id: "agent-1",
  passwordHash: "$bcrypt$hash",
  emailVerified: new Date("2026-01-01T00:00:00Z"),
};

function peerRequest(body: unknown = { email: "user@example.com", password: "longenough1" }): Request {
  return new Request("https://person.example/api/federation/remote-password/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-peer-slug": "global", "x-peer-secret": "s" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/federation/remote-password/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy state: authenticated peer, both limiters pass, IP resolved.
    mocks.authorizeFederationRequest.mockResolvedValue({ authorized: true, peerNodeId: "peer-1" });
    mocks.rateLimit.mockResolvedValue({ success: true });
    mocks.getClientIp.mockReturnValue("203.0.113.7");
    mocks.agentRow.mockResolvedValue([VERIFIED_AGENT]);
    mocks.verify.mockResolvedValue(true);
  });

  it("rejects an unauthenticated request (no peer/admin auth) — closes the oracle", async () => {
    mocks.authorizeFederationRequest.mockResolvedValue({ authorized: false, reason: "Authentication required" });
    const res = await POST(peerRequest());
    expect(res.status).toBe(401);
    expect(mocks.agentRow).not.toHaveBeenCalled();
  });

  it("rejects a user-session/MCP principal (actorId present) — server-to-server only", async () => {
    mocks.authorizeFederationRequest.mockResolvedValue({ authorized: true, actorId: "some-user" });
    const res = await POST(peerRequest());
    expect(res.status).toBe(401);
    expect(mocks.agentRow).not.toHaveBeenCalled();
  });

  it("verifies a correct credential for a verified, peer-authenticated account and returns a boolean only", async () => {
    const res = await POST(peerRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ success: true });
    // No enriched actor leaked.
    expect(json.actor).toBeUndefined();
  });

  it("enforces the per-IP rate limit before the per-email one", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ success: false }); // first call = IP limiter
    const res = await POST(peerRequest());
    expect(res.status).toBe(429);
    // First limiter key is the IP-scoped one.
    expect(mocks.rateLimit.mock.calls[0][0]).toContain("203.0.113.7");
    expect(mocks.agentRow).not.toHaveBeenCalled();
  });

  it("fails an unverified-email account even with a correct password", async () => {
    mocks.agentRow.mockResolvedValue([{ ...VERIFIED_AGENT, emailVerified: null }]);
    const res = await POST(peerRequest());
    expect(res.status).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("fails a wrong password", async () => {
    mocks.verify.mockResolvedValue(false);
    const res = await POST(peerRequest());
    expect(res.status).toBe(401);
  });

  it("fails an unknown account (no password hash)", async () => {
    mocks.agentRow.mockResolvedValue([]);
    const res = await POST(peerRequest());
    expect(res.status).toBe(401);
  });
});
