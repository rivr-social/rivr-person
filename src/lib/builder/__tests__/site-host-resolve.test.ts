import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOMAIN_STATUS_BOUND,
  DOMAIN_STATUS_PENDING,
  computeDomainVerification,
  matchPublicationForHost,
  normalizeHost,
  verifyDomainPointsToApp,
  type DnsResolver,
  type ServablePublication,
} from "@/lib/builder/site-host-resolve";
import {
  contentTypeForPath,
  normalizeRequestPath,
  sanitizeSitePath,
} from "@/lib/builder/site-publish-storage";

// ---------------------------------------------------------------------------
// normalizeHost
// ---------------------------------------------------------------------------

describe("normalizeHost", () => {
  it("lowercases, strips port and trailing dot", () => {
    expect(normalizeHost("Example.COM:443")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("  WWW.Example.com  ")).toBe("www.example.com");
    expect(normalizeHost(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Host-dispatch resolution
// ---------------------------------------------------------------------------

describe("matchPublicationForHost", () => {
  const bound: ServablePublication = {
    customDomain: "camalot.me",
    domainStatus: DOMAIN_STATUS_BOUND,
    storageBucket: "rivr-uploads",
    storagePrefix: "site-publications/pub-1",
  };

  it("returns the bound publication for a matching host", () => {
    expect(matchPublicationForHost("camalot.me", [bound])).toBe(bound);
    // Port + case + trailing dot are normalized before matching.
    expect(matchPublicationForHost("Camalot.me:443", [bound])).toBe(bound);
  });

  it("returns null for an unknown host", () => {
    expect(matchPublicationForHost("unknown.example", [bound])).toBeNull();
    expect(matchPublicationForHost("", [bound])).toBeNull();
  });

  it("does not serve a publication that is not bound", () => {
    const pending = { ...bound, domainStatus: DOMAIN_STATUS_PENDING };
    expect(matchPublicationForHost("camalot.me", [pending])).toBeNull();
  });

  it("does not serve a bound publication missing storage coordinates", () => {
    const noStorage = { ...bound, storagePrefix: null };
    expect(matchPublicationForHost("camalot.me", [noStorage])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DNS verification
// ---------------------------------------------------------------------------

describe("computeDomainVerification", () => {
  it("verifies when the domain shares an address with the app host", () => {
    const v = computeDomainVerification("app.camalot.me", ["203.0.113.7"], ["203.0.113.7"], []);
    expect(v.verified).toBe(true);
    expect(v.matched).toEqual(["203.0.113.7"]);
  });

  it("verifies when the domain CNAMEs the app host", () => {
    const v = computeDomainVerification("app.camalot.me", ["203.0.113.7"], [], ["app.camalot.me"]);
    expect(v.verified).toBe(true);
    expect(v.detail).toContain("CNAME");
  });

  it("fails when addresses differ and there is no CNAME match", () => {
    const v = computeDomainVerification("app.camalot.me", ["203.0.113.7"], ["198.51.100.9"], []);
    expect(v.verified).toBe(false);
  });

  it("fails with a helpful message when nothing resolves", () => {
    const v = computeDomainVerification("app.camalot.me", ["203.0.113.7"], [], []);
    expect(v.verified).toBe(false);
    expect(v.detail).toContain("No A/AAAA/CNAME records");
  });
});

describe("verifyDomainPointsToApp (injected resolver)", () => {
  function resolverFrom(map: Record<string, { a?: string[]; aaaa?: string[]; cname?: string[] }>): DnsResolver {
    return {
      resolve4: async (h) => map[h]?.a ?? [],
      resolve6: async (h) => map[h]?.aaaa ?? [],
      resolveCname: async (h) => map[h]?.cname ?? [],
    };
  }

  it("passes when the custom domain resolves to the app host's IP", async () => {
    const resolver = resolverFrom({
      "app.camalot.me": { a: ["203.0.113.7"] },
      "camalot.me": { a: ["203.0.113.7"] },
    });
    const v = await verifyDomainPointsToApp("camalot.me", resolver, "app.camalot.me");
    expect(v.verified).toBe(true);
  });

  it("fails when the custom domain resolves elsewhere", async () => {
    const resolver = resolverFrom({
      "app.camalot.me": { a: ["203.0.113.7"] },
      "camalot.me": { a: ["198.51.100.9"] },
    });
    const v = await verifyDomainPointsToApp("camalot.me", resolver, "app.camalot.me");
    expect(v.verified).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when the app hostname cannot be determined", async () => {
    // Force the base-url env vars empty so getAppHostname() returns null.
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
    vi.stubEnv("BASE_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    const resolver = resolverFrom({});
    await expect(verifyDomainPointsToApp("camalot.me", resolver)).rejects.toMatchObject({
      code: "NO_APP_HOST",
    });
  });
});

// ---------------------------------------------------------------------------
// Storage path helpers (pure)
// ---------------------------------------------------------------------------

describe("site-publish-storage path helpers", () => {
  it("maps extensions to content types", () => {
    expect(contentTypeForPath("index.html")).toContain("text/html");
    expect(contentTypeForPath("style.css")).toContain("text/css");
    expect(contentTypeForPath("app.js")).toContain("javascript");
    expect(contentTypeForPath("noext")).toBe("application/octet-stream");
  });

  it("strips traversal segments when sanitizing", () => {
    expect(sanitizeSitePath("/../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizeSitePath("a/./b/../c")).toBe("a/b/c");
  });

  it("defaults a directory request to index.html", () => {
    expect(normalizeRequestPath("")).toBe("index.html");
    expect(normalizeRequestPath("blog/")).toBe("blog/index.html");
    expect(normalizeRequestPath("/style.css")).toBe("style.css");
  });
});
