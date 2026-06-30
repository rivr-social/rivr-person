import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for verifyWithGlobalIdentityAuthority() — the delegated credential
 * check against global's universal identity authority.
 *
 * Security target (F12): the caller (auth.ts) must be able to distinguish an
 * EXPLICIT rejection (global evaluated the credential and said no) from global
 * being UNREACHABLE. Only the unreachable case may fall through to the local
 * bcrypt hash; a rejection must fail closed so a blackholed/misconfigured global
 * never re-enables a stale or revoked local password.
 *
 * The global `fetch` is stubbed; no network is touched.
 */

import { verifyWithGlobalIdentityAuthority } from "@/lib/auth/global-credential-authority";

const PARAMS = { email: "cameron@rivr.social", password: "correct-horse-battery" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("verifyWithGlobalIdentityAuthority", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = "https://rivr.camalot.me";
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL = "https://app.rivr.social";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXTAUTH_URL;
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
  });

  it("returns verified with the mapped actor on a 200 with an actorId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          actorId: "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667",
          email: "cameron@rivr.social",
          name: "Cameron",
          avatarUrl: "https://img.example/a.png",
          homeBaseUrl: "https://rivr.camalot.me",
          globalIssuerBaseUrl: "https://app.rivr.social",
        }),
      ),
    );

    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.actor.id).toBe("aa29fa2d-4c2a-4eaf-a069-b2203a2ce667");
      expect(result.actor.image).toBe("https://img.example/a.png");
      expect(result.actor.homeBaseUrl).toBe("https://rivr.camalot.me");
    }
  });

  it("returns rejected on 401 (identity not found OR wrong password) — fail closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("rejected");
  });

  it("returns rejected on 403 (revoked/migrating authority status) — fail closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, { authorityStatus: "revoked" })));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("rejected");
  });

  it("returns unreachable on a 5xx (availability problem, not an authority decision)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, { error: "down" })));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
  });

  it("returns unreachable on a 429 rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "slow down" })));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
  });

  it("returns unreachable when the fetch throws (network failure / timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
  });

  it("returns unreachable on a 200 whose body cannot be parsed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
  });

  it("returns unreachable on a 200 missing an actorId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { email: "x@y.z" })));
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
  });

  it("returns unreachable (not rejected) when no target base url is configured", async () => {
    delete process.env.NEXTAUTH_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await verifyWithGlobalIdentityAuthority(PARAMS);
    expect(result.status).toBe("unreachable");
    // Never even attempts the request when it can't bind a target.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
