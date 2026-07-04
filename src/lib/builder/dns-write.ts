/**
 * @fileoverview Provider-agnostic DNS-write for pointing a custom domain at a
 * published builder site (publish -> serve on custom domains).
 *
 * Ported from the GLOBAL app. BUILDS ON the person app's autobot DNS/deploy
 * connectors ({@link DEPLOY_CONNECTABLE_PROVIDERS} in `autobot-connectors.ts`):
 * Cloudflare, Namecheap, and Squarespace. We do NOT duplicate connector
 * storage — the caller resolves the owner's connector and decrypts its config
 * via `autobot-connector-secrets`, then hands the plaintext secret + non-secret
 * config (zoneId/apiUser/domain) to this module.
 *
 * Two concerns are split so the planning logic is pure and unit-testable while
 * the network calls are isolated and mockable:
 *
 *   - {@link planDnsRecords}  — pure: which records must exist to point a domain
 *                               at the published-site target.
 *   - {@link applyDnsRecords} — live: writes the planned records via the named
 *                               provider's API (fetch injectable for tests).
 *
 * Owner identity and credentials are NEVER trusted from the client — the API
 * layer derives the owner via `auth()` and loads the stored connector.
 */

/** DNS connector provider ids supported for binding (subset of A7 providers). */
export const DNS_WRITE_PROVIDERS = ["cloudflare", "namecheap", "squarespace"] as const;
export type DnsWriteProvider = (typeof DNS_WRITE_PROVIDERS)[number];

/** Record types the binder knows how to plan/write. */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

/** A single DNS record the binder will ensure exists. */
export interface DnsRecord {
  type: DnsRecordType;
  /** Fully-qualified host name (e.g. "www.example.com" or "example.com"). */
  name: string;
  /** Record value: an IP for A/AAAA, a hostname for CNAME, text for TXT. */
  value: string;
  /** TTL in seconds. 1 means "automatic" for Cloudflare. */
  ttl: number;
  /** Whether to proxy through the provider CDN (Cloudflare-only; ignored else). */
  proxied?: boolean;
}

/** Where the published site is reachable; the records point a domain here. */
export interface PublishTarget {
  /** Hostname the custom domain should resolve to (e.g. the app host). */
  cnameTarget?: string;
  /** IPv4 the apex should resolve to when CNAME-at-apex is unsupported. */
  ipv4?: string;
  /** IPv6 the apex should resolve to. */
  ipv6?: string;
}

/** Default DNS TTL (seconds). 1 = "automatic" on Cloudflare. */
export const DEFAULT_DNS_TTL = 1;

// ---------------------------------------------------------------------------
// Domain parsing
// ---------------------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Parsed custom-domain shape. */
export interface ParsedDomain {
  /** The full requested hostname, lowercased. */
  fqdn: string;
  /** Apex/registrable domain (best-effort: last two labels). */
  apex: string;
  /** True when the request targets the apex (no subdomain). */
  isApex: boolean;
  /** Subdomain label(s) when not apex (e.g. "www"), else "". */
  subdomain: string;
}

/**
 * Validates and parses a custom domain. Apex detection is a best-effort
 * last-two-labels heuristic (sufficient for binding www/apex; multi-part TLDs
 * such as co.uk will treat "example.co.uk" as a subdomain of "co.uk", which is
 * harmless for record planning because we still write the exact fqdn).
 *
 * @throws {DnsBindError} When the hostname is empty or malformed.
 */
export function parseDomain(raw: string): ParsedDomain {
  const fqdn = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!fqdn) throw new DnsBindError("EMPTY_DOMAIN", "A custom domain is required.");
  if (!HOSTNAME_RE.test(fqdn)) {
    throw new DnsBindError("INVALID_DOMAIN", `"${raw}" is not a valid domain name.`);
  }
  const labels = fqdn.split(".");
  const apex = labels.slice(-2).join(".");
  const isApex = labels.length === 2;
  const subdomain = isApex ? "" : labels.slice(0, -2).join(".");
  return { fqdn, apex, isApex, subdomain };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Specific, contextful error for DNS binding failures. */
export class DnsBindError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DnsBindError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * Plans the DNS records required to point `domain` at the published-site
 * `target`. Pure and deterministic — no network, no credentials.
 *
 * - Subdomain (e.g. www): a single CNAME to `target.cnameTarget`.
 * - Apex: prefer A/AAAA records (CNAME-at-apex is widely unsupported); fall back
 *   to a CNAME only when no IP is provided AND a cnameTarget exists.
 *
 * @throws {DnsBindError} When the domain is invalid, or the target lacks the
 *                        values needed for the chosen record kind.
 */
export function planDnsRecords(domainRaw: string, target: PublishTarget): DnsRecord[] {
  const domain = parseDomain(domainRaw);
  const ttl = DEFAULT_DNS_TTL;

  if (!domain.isApex) {
    if (!target.cnameTarget) {
      throw new DnsBindError(
        "NO_CNAME_TARGET",
        "A CNAME target is required to bind a subdomain.",
      );
    }
    return [
      { type: "CNAME", name: domain.fqdn, value: target.cnameTarget, ttl, proxied: true },
    ];
  }

  // Apex: prefer A/AAAA.
  const records: DnsRecord[] = [];
  if (target.ipv4) records.push({ type: "A", name: domain.fqdn, value: target.ipv4, ttl, proxied: true });
  if (target.ipv6) records.push({ type: "AAAA", name: domain.fqdn, value: target.ipv6, ttl, proxied: true });
  if (records.length > 0) return records;

  if (target.cnameTarget) {
    // CNAME-at-apex (works on Cloudflare via CNAME flattening).
    return [{ type: "CNAME", name: domain.fqdn, value: target.cnameTarget, ttl, proxied: true }];
  }

  throw new DnsBindError(
    "NO_APEX_TARGET",
    "Binding an apex domain requires an IPv4/IPv6 address or a CNAME target.",
  );
}

// ---------------------------------------------------------------------------
// Provider write adapters (live, fetch-injectable)
// ---------------------------------------------------------------------------

/** The decrypted credential + non-secret config for a provider. */
export interface ResolvedDnsCredential {
  provider: DnsWriteProvider;
  /** Decrypted secret token/key (from the connector's encrypted `apiKey`). */
  secret: string;
  /** Non-secret config from the connector (zoneId, apiUser, domain…). */
  config: Record<string, string>;
}

/** Outcome of writing the planned records. */
export interface DnsApplyResult {
  ok: boolean;
  provider: DnsWriteProvider;
  /** Records the provider confirmed created/updated. */
  applied: DnsRecord[];
  /** Human-facing detail. */
  detail: string;
}

/** Injectable fetch so tests can mock provider APIs without real network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A provider-specific writer: ensures each planned record exists. */
type DnsWriter = (
  records: DnsRecord[],
  credential: ResolvedDnsCredential,
  fetchImpl: FetchLike,
) => Promise<DnsApplyResult>;

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Cloudflare writer: upserts each record into the configured zone via the v4
 * API. Requires a `zoneId` in the connection config. Uses the bearer token
 * (the connector secret). Existing records of the same type+name are updated
 * in place.
 */
const writeCloudflare: DnsWriter = async (records, credential, fetchImpl) => {
  const zoneId = credential.config.zoneId?.trim();
  if (!zoneId) {
    throw new DnsBindError("MISSING_ZONE_ID", "Cloudflare connection is missing a Zone ID.");
  }
  const headers = {
    Authorization: `Bearer ${credential.secret}`,
    "Content-Type": "application/json",
  };
  const applied: DnsRecord[] = [];

  for (const record of records) {
    // Find an existing record of the same type+name to update in place.
    const listUrl = `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`;
    const listRes = await fetchImpl(listUrl, { method: "GET", headers, cache: "no-store" });
    const listBody = (await safeJson(listRes)) as { result?: Array<{ id?: string }> } | null;
    if (!listRes.ok) {
      throw new DnsBindError(
        "CLOUDFLARE_LIST_FAILED",
        `Cloudflare rejected the record list for ${record.name} (HTTP ${listRes.status}).`,
      );
    }
    const existingId = listBody?.result?.[0]?.id;
    const payload = JSON.stringify({
      type: record.type,
      name: record.name,
      content: record.value,
      ttl: record.ttl,
      proxied: record.proxied ?? false,
    });

    const writeUrl = existingId
      ? `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/${existingId}`
      : `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const writeRes = await fetchImpl(writeUrl, {
      method: existingId ? "PUT" : "POST",
      headers,
      body: payload,
      cache: "no-store",
    });
    if (!writeRes.ok) {
      const errBody = (await safeJson(writeRes)) as { errors?: Array<{ message?: string }> } | null;
      const reason = errBody?.errors?.[0]?.message ?? `HTTP ${writeRes.status}`;
      throw new DnsBindError(
        "CLOUDFLARE_WRITE_FAILED",
        `Cloudflare could not write the ${record.type} record for ${record.name}: ${reason}.`,
      );
    }
    applied.push(record);
  }

  return {
    ok: true,
    provider: "cloudflare",
    applied,
    detail: `Wrote ${applied.length} record(s) to Cloudflare zone ${zoneId}.`,
  };
};

const NAMECHEAP_API_BASE = "https://api.namecheap.com/xml.response";

/**
 * Namecheap writer: Namecheap's `setHosts` API REPLACES the full host record
 * set in one call and is IP-allowlisted. We submit the planned records via the
 * documented query-param shape. Requires `apiUser` and `domain` config plus the
 * API key secret. Because setHosts is destructive, we only send the records we
 * planned (the caller is binding a fresh custom domain).
 */
const writeNamecheap: DnsWriter = async (records, credential, fetchImpl) => {
  const apiUser = credential.config.apiUser?.trim();
  const domain = credential.config.domain?.trim();
  if (!apiUser) throw new DnsBindError("MISSING_API_USER", "Namecheap connection is missing an API User.");
  if (!domain) throw new DnsBindError("MISSING_DOMAIN", "Namecheap connection is missing a Domain.");
  const [sld, ...tldParts] = domain.split(".");
  const tld = tldParts.join(".");
  if (!sld || !tld) throw new DnsBindError("INVALID_DOMAIN", `Namecheap domain "${domain}" is malformed.`);

  const params = new URLSearchParams({
    ApiUser: apiUser,
    ApiKey: credential.secret,
    UserName: apiUser,
    Command: "namecheap.domains.dns.setHosts",
    ClientIp: credential.config.clientIp?.trim() || "0.0.0.0",
    SLD: sld,
    TLD: tld,
  });
  records.forEach((record, index) => {
    const n = index + 1;
    // Namecheap host names are relative to the domain; "@" for apex.
    const relative = relativeHostForNamecheap(record.name, domain);
    params.set(`HostName${n}`, relative);
    params.set(`RecordType${n}`, record.type);
    params.set(`Address${n}`, record.value);
    params.set(`TTL${n}`, String(record.ttl > 1 ? record.ttl : 1800));
  });

  const url = `${NAMECHEAP_API_BASE}?${params.toString()}`;
  const res = await fetchImpl(url, { method: "POST", cache: "no-store" });
  const text = await safeText(res);
  if (!res.ok || /Status="ERROR"/i.test(text) || /<Errors>\s*<Error/i.test(text)) {
    throw new DnsBindError(
      "NAMECHEAP_WRITE_FAILED",
      `Namecheap rejected the host record update for ${domain} (HTTP ${res.status}).`,
    );
  }
  return {
    ok: true,
    provider: "namecheap",
    applied: records,
    detail: `Set ${records.length} host record(s) on Namecheap domain ${domain}.`,
  };
};

/**
 * Squarespace writer: Squarespace's Domains API does not expose a stable,
 * documented public DNS-record write endpoint for arbitrary records, so direct
 * record writes are not performed. Rather than silently succeed (which would
 * mislead the user), this returns a non-ok result instructing the user to point
 * their Squarespace domain's records manually, while still confirming the plan.
 */
const writeSquarespace: DnsWriter = async (records, credential) => {
  const domain = credential.config.domain?.trim() || "your Squarespace domain";
  return {
    ok: false,
    provider: "squarespace",
    applied: [],
    detail:
      `Squarespace does not expose a public DNS-write API. Add these record(s) to ${domain} manually: ` +
      records.map((r) => `${r.type} ${r.name} -> ${r.value}`).join("; ") + ".",
  };
};

/** Registry mapping each supported provider to its writer. */
const DNS_WRITERS: Record<DnsWriteProvider, DnsWriter> = {
  cloudflare: writeCloudflare,
  namecheap: writeNamecheap,
  squarespace: writeSquarespace,
};

/** Returns true when the provider id is a supported DNS-write provider. */
export function isDnsWriteProvider(id: string): id is DnsWriteProvider {
  return (DNS_WRITE_PROVIDERS as readonly string[]).includes(id);
}

/**
 * Writes the planned records via the named provider. Credentials must already be
 * decrypted and resolved (see `resolveDnsCredentialForOwner`). `fetchImpl`
 * defaults to global `fetch` and is injectable for tests.
 *
 * @throws {DnsBindError} When the provider is unsupported, credentials are
 *                        incomplete, or the provider rejects a write.
 */
export async function applyDnsRecords(
  records: DnsRecord[],
  credential: ResolvedDnsCredential,
  fetchImpl: FetchLike = fetch,
): Promise<DnsApplyResult> {
  if (records.length === 0) {
    throw new DnsBindError("NO_RECORDS", "No DNS records to apply.");
  }
  if (!credential.secret) {
    throw new DnsBindError("NO_CREDENTIAL", "No DNS credential is configured for this owner.");
  }
  const writer = DNS_WRITERS[credential.provider];
  if (!writer) {
    throw new DnsBindError("UNSUPPORTED_PROVIDER", `DNS provider "${credential.provider}" is not supported.`);
  }
  return writer(records, credential, fetchImpl);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Converts an FQDN to a Namecheap-relative host ("@" for apex). */
export function relativeHostForNamecheap(fqdn: string, domain: string): string {
  const lowerFqdn = fqdn.toLowerCase().replace(/\.$/, "");
  const lowerDomain = domain.toLowerCase().replace(/\.$/, "");
  if (lowerFqdn === lowerDomain) return "@";
  const suffix = `.${lowerDomain}`;
  if (lowerFqdn.endsWith(suffix)) return lowerFqdn.slice(0, -suffix.length) || "@";
  return lowerFqdn;
}

/** Reads a Response as JSON, returning null on parse failure. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Reads a Response as text, returning "" on failure. */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
