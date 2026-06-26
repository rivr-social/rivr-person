import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVerifySsoAssertion = vi.fn();
const mockCreateRemoteViewerToken = vi.fn();

vi.mock("@/lib/federation/sso-assertion", () => ({
  verifySsoAssertion: (...args: unknown[]) => mockVerifySsoAssertion(...args),
}));

vi.mock("@/lib/federation-remote-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/federation-remote-session")>();
  return {
    ...actual,
    createRemoteViewerToken: (...args: unknown[]) => mockCreateRemoteViewerToken(...args),
  };
});

vi.mock("@/lib/federation/instance-config", () => ({
  getInstanceConfig: () => ({
    instanceId: "person-instance-id",
    instanceType: "person",
    instanceSlug: "camalot",
    primaryAgentId: "owner-agent-id",
    registryUrl: "https://app.rivr.social/api/federation/registry",
    minioBucketPrefix: "camalot",
    baseUrl: "https://rivr.camalot.me",
    isGlobal: false,
  }),
  getGlobalIdentityAuthorityUrl: () => "https://app.rivr.social",
}));

vi.mock("@/lib/request-origin", () => ({
  resolveRequestOrigin: () => "https://rivr.camalot.me",
}));

import { GET, POST } from "@/app/api/federation/remote-auth/route";

const ROUTE_BASE = "https://rivr.camalot.me/api/federation/remote-auth";

function signedAssertion() {
  return {
    actorId: "owner-agent-id",
    homeBaseUrl: "https://app.rivr.social",
    globalIssuerBaseUrl: "https://app.rivr.social",
    targetBaseUrl: "https://rivr.camalot.me",
    credentialVersion: 1,
    homeAuthorityVersion: 1,
    instanceClass: "hosted-federated",
    parentAgentId: null,
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    nonce: "nonce",
    kid: "global",
    signature: "signature",
  };
}

describe("person /api/federation/remote-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRemoteViewerToken.mockReturnValue("remote-viewer-token");
    mockVerifySsoAssertion.mockResolvedValue({
      ok: true,
      claims: {
        actorId: "owner-agent-id",
        homeBaseUrl: "https://app.rivr.social",
        globalIssuerBaseUrl: "https://app.rivr.social",
        targetBaseUrl: "https://rivr.camalot.me",
        credentialVersion: 1,
        homeAuthorityVersion: 1,
        instanceClass: "hosted-federated",
        parentAgentId: null,
        iat: 1_700_000_000,
        exp: 1_700_000_300,
        nonce: "nonce",
        name: "Owner",
      },
    });
  });

  it("verifies POSTed assertions locally against the expected issuer and audience", async () => {
    const response = await POST(
      new Request(ROUTE_BASE, {
        method: "POST",
        body: JSON.stringify(signedAssertion()),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.viewerState).toBe("remotely_authenticated");
    expect(body.actorId).toBe("owner-agent-id");
    expect(mockVerifySsoAssertion).toHaveBeenCalledWith({
      assertion: signedAssertion(),
      expectedTargetBaseUrl: "https://rivr.camalot.me",
      expectedGlobalIssuerBaseUrl: "https://app.rivr.social",
    });
    expect(mockCreateRemoteViewerToken).toHaveBeenCalledWith({
      actorId: "owner-agent-id",
      homeBaseUrl: "https://app.rivr.social",
      localInstanceId: "person-instance-id",
    });
    expect(response.headers.get("set-cookie")).toContain("rivr_remote_viewer=remote-viewer-token");
  });

  it("rejects assertions that fail local verification", async () => {
    mockVerifySsoAssertion.mockResolvedValueOnce({
      ok: false,
      reason: "signature-invalid",
    });

    const response = await POST(
      new Request(ROUTE_BASE, {
        method: "POST",
        body: JSON.stringify(signedAssertion()),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.errorCode).toBe("ASSERTION_VERIFICATION_FAILED");
    expect(mockCreateRemoteViewerToken).not.toHaveBeenCalled();
  });

  it("enforces the person-instance owner after signature verification", async () => {
    mockVerifySsoAssertion.mockResolvedValueOnce({
      ok: true,
      claims: {
        ...signedAssertion(),
        actorId: "not-owner-agent-id",
      },
    });

    const response = await POST(
      new Request(ROUTE_BASE, {
        method: "POST",
        body: JSON.stringify(signedAssertion()),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe("PERSON_INSTANCE_OWNER_REQUIRED");
    expect(mockCreateRemoteViewerToken).not.toHaveBeenCalled();
  });

  it("does not mint a remote-viewer cookie from GET query parameters", async () => {
    const url = new URL(ROUTE_BASE);
    url.searchParams.set("actorId", "owner-agent-id");
    url.searchParams.set("homeBaseUrl", "https://attacker.example");
    url.searchParams.set("assertionType", "signed");
    url.searchParams.set("assertion", "attacker-controlled");
    url.searchParams.set("issuedAt", new Date().toISOString());
    url.searchParams.set("expiresAt", new Date(Date.now() + 60_000).toISOString());
    url.searchParams.set("redirect", "/settings");

    const response = await GET(new Request(url));

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe("https://rivr.camalot.me/settings");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockVerifySsoAssertion).not.toHaveBeenCalled();
    expect(mockCreateRemoteViewerToken).not.toHaveBeenCalled();
  });
});
