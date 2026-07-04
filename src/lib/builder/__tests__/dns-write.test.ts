import { describe, expect, it, vi } from "vitest";
import {
  DnsBindError,
  applyDnsRecords,
  isDnsWriteProvider,
  planDnsRecords,
  relativeHostForNamecheap,
  type FetchLike,
  type ResolvedDnsCredential,
} from "@/lib/builder/dns-write";

// ---------------------------------------------------------------------------
// Fetch mocking helpers
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

function fakeResponse(init: FakeResponseInit): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.json ?? {},
    text: async () => init.text ?? "",
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// planDnsRecords (pure)
// ---------------------------------------------------------------------------

describe("planDnsRecords", () => {
  it("plans a single CNAME for a subdomain", () => {
    const records = planDnsRecords("www.example.com", { cnameTarget: "app.rivr.social" });
    expect(records).toEqual([
      { type: "CNAME", name: "www.example.com", value: "app.rivr.social", ttl: 1, proxied: true },
    ]);
  });

  it("prefers A/AAAA records for an apex domain", () => {
    const records = planDnsRecords("example.com", { ipv4: "203.0.113.7", ipv6: "2001:db8::1" });
    expect(records.map((r) => r.type)).toEqual(["A", "AAAA"]);
    expect(records[0]).toMatchObject({ name: "example.com", value: "203.0.113.7" });
  });

  it("falls back to a CNAME-at-apex when only a cnameTarget is provided", () => {
    const records = planDnsRecords("example.com", { cnameTarget: "app.rivr.social" });
    expect(records).toEqual([
      { type: "CNAME", name: "example.com", value: "app.rivr.social", ttl: 1, proxied: true },
    ]);
  });

  it("throws INVALID_DOMAIN for a malformed host", () => {
    expect(() => planDnsRecords("not a domain", { cnameTarget: "x.y" })).toThrow(DnsBindError);
  });

  it("throws NO_APEX_TARGET when an apex has no target at all", () => {
    try {
      planDnsRecords("example.com", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DnsBindError);
      expect((err as DnsBindError).code).toBe("NO_APEX_TARGET");
    }
  });
});

describe("relativeHostForNamecheap", () => {
  it("maps apex to @ and strips the domain suffix from subdomains", () => {
    expect(relativeHostForNamecheap("example.com", "example.com")).toBe("@");
    expect(relativeHostForNamecheap("www.example.com", "example.com")).toBe("www");
  });
});

describe("isDnsWriteProvider", () => {
  it("recognizes supported providers only", () => {
    expect(isDnsWriteProvider("cloudflare")).toBe(true);
    expect(isDnsWriteProvider("namecheap")).toBe(true);
    expect(isDnsWriteProvider("route53")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDnsRecords (live, fetch-injected)
// ---------------------------------------------------------------------------

describe("applyDnsRecords — cloudflare", () => {
  const credential: ResolvedDnsCredential = {
    provider: "cloudflare",
    secret: "cf-token",
    config: { zoneId: "zone123" },
  };
  const records = planDnsRecords("www.example.com", { cnameTarget: "app.rivr.social" });

  it("creates a new record when none exists", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if ((init?.method ?? "GET") === "GET") return fakeResponse({ json: { result: [] } });
      return fakeResponse({ json: { success: true } });
    });
    const result = await applyDnsRecords(records, credential, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(1);
    // list + create
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const createCall = fetchImpl.mock.calls[1];
    expect(createCall[1]?.method).toBe("POST");
  });

  it("updates an existing record in place (PUT)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if ((init?.method ?? "GET") === "GET") return fakeResponse({ json: { result: [{ id: "rec1" }] } });
      return fakeResponse({ json: { success: true } });
    });
    const result = await applyDnsRecords(records, credential, fetchImpl);
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[1][1]?.method).toBe("PUT");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/rec1");
  });

  it("throws when the zone is missing", async () => {
    await expect(
      applyDnsRecords(records, { ...credential, config: {} }, vi.fn<FetchLike>()),
    ).rejects.toBeInstanceOf(DnsBindError);
  });

  it("throws CLOUDFLARE_WRITE_FAILED when the API rejects the write", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if ((init?.method ?? "GET") === "GET") return fakeResponse({ json: { result: [] } });
      return fakeResponse({ ok: false, status: 400, json: { errors: [{ message: "bad" }] } });
    });
    await expect(applyDnsRecords(records, credential, fetchImpl)).rejects.toMatchObject({
      code: "CLOUDFLARE_WRITE_FAILED",
    });
  });
});

describe("applyDnsRecords — namecheap", () => {
  const credential: ResolvedDnsCredential = {
    provider: "namecheap",
    secret: "nc-key",
    config: { apiUser: "user", domain: "example.com" },
  };
  const records = planDnsRecords("example.com", { cnameTarget: "app.rivr.social" });

  it("sets hosts and reports success", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      fakeResponse({ text: '<ApiResponse Status="OK"></ApiResponse>' }),
    );
    const result = await applyDnsRecords(records, credential, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("namecheap");
  });

  it("throws NAMECHEAP_WRITE_FAILED on an error response body", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      fakeResponse({ text: '<ApiResponse Status="ERROR"><Errors><Error>nope</Error></Errors></ApiResponse>' }),
    );
    await expect(applyDnsRecords(records, credential, fetchImpl)).rejects.toMatchObject({
      code: "NAMECHEAP_WRITE_FAILED",
    });
  });
});

describe("applyDnsRecords — squarespace", () => {
  it("returns a non-ok manual-instruction result (no public write API)", async () => {
    const records = planDnsRecords("example.com", { cnameTarget: "app.rivr.social" });
    const result = await applyDnsRecords(
      records,
      { provider: "squarespace", secret: "x", config: { domain: "example.com" } },
      vi.fn<FetchLike>(),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("manually");
  });
});
