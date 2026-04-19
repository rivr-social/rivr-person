/**
 * Domain verification utilities for custom domain configuration.
 *
 * Provides DNS-based ownership verification and pointing checks for
 * sovereign Rivr instances. Uses Node's built-in `dns.promises` module
 * to resolve TXT, A, AAAA, and CNAME records.
 *
 * Verification flow:
 * 1. User sets a custom domain and receives a TXT verification token.
 * 2. User adds a TXT record: `rivr-verify=<token>` to their domain's DNS.
 * 3. User adds an A/AAAA/CNAME record pointing to the instance IP.
 * 4. The verify endpoint checks both conditions and updates status.
 *
 * Integration note: This module handles DNS verification only.
 * Actual Traefik router/certificate configuration must be applied
 * separately on the host via deploy agent, SSH, or dynamic config file.
 *
 * @module domain-verification
 */
import dns from "dns";
import crypto from "crypto";

/** Prefix for verification TXT records. */
const VERIFICATION_PREFIX = "rivr-verify=";

/** Expected instance IP for A record checks, sourced from environment. */
const INSTANCE_IP = process.env.INSTANCE_IP || process.env.NEXTAUTH_URL
  ? new URL(process.env.NEXTAUTH_URL || "http://localhost:3000").hostname
  : "127.0.0.1";

/**
 * Result of a domain verification check.
 */
export interface DomainVerificationResult {
  /** Whether the TXT ownership record was found and matches. */
  txtVerified: boolean;
  /** Whether the domain points to the expected instance IP via A/AAAA/CNAME. */
  dnsPointingCorrectly: boolean;
  /** Individual check details for display in the UI. */
  checks: DomainCheck[];
  /** Overall computed status based on check results. */
  computedStatus: "pending" | "verified" | "active";
}

export interface DomainCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

/**
 * Generates a cryptographically random verification token.
 *
 * @returns A token string in the format `rivr-verify=<32-hex-chars>`.
 */
export function generateVerificationToken(): string {
  const randomHex = crypto.randomBytes(16).toString("hex");
  return `${VERIFICATION_PREFIX}${randomHex}`;
}

/**
 * Extracts the raw token value from a full verification token string.
 * @param fullToken - The complete token including the prefix.
 * @returns The token value without the prefix.
 */
export function extractTokenValue(fullToken: string): string {
  if (fullToken.startsWith(VERIFICATION_PREFIX)) {
    return fullToken.slice(VERIFICATION_PREFIX.length);
  }
  return fullToken;
}

/**
 * Validates that a domain string is syntactically reasonable.
 * Does not guarantee the domain exists or is reachable.
 *
 * @param domain - The domain to validate.
 * @returns `true` if the domain appears valid.
 */
export function isValidDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  // Must have at least one dot, no leading/trailing dots or hyphens
  const domainRegex = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.[a-zA-Z0-9-]{1,63})*\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

/**
 * Normalizes a domain string by lowercasing and stripping trailing dots/whitespace.
 *
 * @param domain - The raw domain input.
 * @returns The normalized domain string.
 */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Resolves TXT records for a domain and checks if the verification token is present.
 *
 * @param domain - The domain to check.
 * @param expectedToken - The full verification token string to match against.
 * @returns Whether a matching TXT record was found.
 */
async function checkTxtVerification(
  domain: string,
  expectedToken: string
): Promise<{ found: boolean; records: string[][] }> {
  try {
    const records = await dns.promises.resolveTxt(domain);
    const flatRecords = records.map((chunks) => chunks.join(""));
    const found = flatRecords.some(
      (record) => record.trim() === expectedToken.trim()
    );
    return { found, records };
  } catch (error: unknown) {
    const dnsError = error as { code?: string };
    // ENODATA / ENOTFOUND are expected when no TXT records exist
    if (dnsError.code === "ENODATA" || dnsError.code === "ENOTFOUND") {
      return { found: false, records: [] };
    }
    throw error;
  }
}

/**
 * Checks whether the domain's A, AAAA, or CNAME records point to the expected instance.
 *
 * @param domain - The domain to check.
 * @param expectedIp - The expected IP address (defaults to INSTANCE_IP).
 * @returns Details about DNS pointing status.
 */
async function checkDnsPointing(
  domain: string,
  expectedIp?: string
): Promise<{ pointing: boolean; resolvedAddresses: string[]; cnames: string[] }> {
  const targetIp = expectedIp || INSTANCE_IP;
  const resolvedAddresses: string[] = [];
  const cnames: string[] = [];

  // Check A records
  try {
    const aRecords = await dns.promises.resolve4(domain);
    resolvedAddresses.push(...aRecords);
  } catch {
    // No A records — not necessarily an error
  }

  // Check AAAA records
  try {
    const aaaaRecords = await dns.promises.resolve6(domain);
    resolvedAddresses.push(...aaaaRecords);
  } catch {
    // No AAAA records — not necessarily an error
  }

  // Check CNAME records
  try {
    const cnameRecords = await dns.promises.resolveCname(domain);
    cnames.push(...cnameRecords);
  } catch {
    // No CNAME records — not necessarily an error
  }

  // A record or AAAA record matches the expected IP
  const directMatch = resolvedAddresses.includes(targetIp);

  // CNAME may resolve to the instance domain — resolve the CNAME target to check
  let cnameResolvesCorrectly = false;
  for (const cname of cnames) {
    try {
      const cnameAddresses = await dns.promises.resolve4(cname);
      if (cnameAddresses.includes(targetIp)) {
        cnameResolvesCorrectly = true;
        break;
      }
    } catch {
      // CNAME target doesn't resolve — skip
    }
  }

  return {
    pointing: directMatch || cnameResolvesCorrectly,
    resolvedAddresses,
    cnames,
  };
}

/**
 * Performs a full domain verification check: TXT ownership + DNS pointing.
 *
 * @param domain - The custom domain to verify.
 * @param verificationToken - The expected verification token.
 * @param instanceIp - Optional override for the expected instance IP.
 * @returns A structured verification result with individual check details.
 */
export async function verifyDomain(
  domain: string,
  verificationToken: string,
  instanceIp?: string
): Promise<DomainVerificationResult> {
  const checks: DomainCheck[] = [];
  const targetIp = instanceIp || INSTANCE_IP;

  // Check 1: TXT record verification
  const txtResult = await checkTxtVerification(domain, verificationToken);
  checks.push({
    id: "txt-record",
    label: "TXT Verification Record",
    status: txtResult.found ? "ok" : "error",
    detail: txtResult.found
      ? `Found matching verification record: ${verificationToken}`
      : `No matching TXT record found. Add a TXT record with value: ${verificationToken}`,
  });

  // Check 2: DNS pointing (A/AAAA/CNAME)
  const dnsResult = await checkDnsPointing(domain, targetIp);
  const resolvedSummary = [
    ...dnsResult.resolvedAddresses.map((addr) => `A/AAAA: ${addr}`),
    ...dnsResult.cnames.map((cname) => `CNAME: ${cname}`),
  ].join(", ");

  if (dnsResult.pointing) {
    checks.push({
      id: "dns-pointing",
      label: "DNS Pointing",
      status: "ok",
      detail: `Domain correctly resolves to ${targetIp}. Found: ${resolvedSummary || "match via CNAME chain"}`,
    });
  } else if (dnsResult.resolvedAddresses.length > 0 || dnsResult.cnames.length > 0) {
    checks.push({
      id: "dns-pointing",
      label: "DNS Pointing",
      status: "warning",
      detail: `Domain resolves to ${resolvedSummary} but expected ${targetIp}. Update your A record to point to ${targetIp}.`,
    });
  } else {
    checks.push({
      id: "dns-pointing",
      label: "DNS Pointing",
      status: "error",
      detail: `No A, AAAA, or CNAME records found. Add an A record pointing to ${targetIp}.`,
    });
  }

  const txtVerified = txtResult.found;
  const dnsPointingCorrectly = dnsResult.pointing;

  let computedStatus: "pending" | "verified" | "active";
  if (txtVerified && dnsPointingCorrectly) {
    computedStatus = "active";
  } else if (txtVerified) {
    computedStatus = "verified";
  } else {
    computedStatus = "pending";
  }

  return {
    txtVerified,
    dnsPointingCorrectly,
    checks,
    computedStatus,
  };
}

/**
 * Returns the DNS records that the user needs to add for domain verification.
 *
 * @param domain - The custom domain being configured.
 * @param verificationToken - The TXT record verification token.
 * @param instanceIp - The IP address the domain should point to.
 * @returns An array of required DNS record descriptors.
 */
export function getRequiredDnsRecords(
  domain: string,
  verificationToken: string,
  instanceIp?: string
): { type: string; name: string; value: string; purpose: string }[] {
  const targetIp = instanceIp || INSTANCE_IP;

  return [
    {
      type: "A",
      name: domain,
      value: targetIp,
      purpose: "Points your domain to the Rivr instance server",
    },
    {
      type: "TXT",
      name: domain,
      value: verificationToken,
      purpose: "Proves you own this domain",
    },
  ];
}
