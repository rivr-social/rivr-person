/**
 * @fileoverview Builder custom-domain API — verify, bind, and (optionally) write
 * DNS for a published site so it serves on the owner's own domain.
 *
 *   GET    /api/builder/domain        -> state + app hostname + required DNS
 *                                        records + available DNS-write providers.
 *   POST   /api/builder/domain        -> discriminated by `action`:
 *            { action: "verify",  domain }           node:dns check the domain
 *                                                     resolves to the app host.
 *            { action: "bind",    domain }            persist domain -> publication
 *                                                     (host-dispatch serves it).
 *            { action: "set-dns", domain, provider }  owner-only one-click DNS
 *                                                     write via the connector.
 *   DELETE /api/builder/domain        -> unbind.
 *
 * Owner-only. DNS credentials are resolved+decrypted server-side from the
 * owner's autobot connector lane — NEVER accepted from the client.
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";
import {
  DOMAIN_STATUS_MANUAL,
  DOMAIN_STATUS_PENDING,
  bindCustomDomain,
  getAppHostname,
  getSitePublication,
  listOwnerDnsProviders,
  normalizeHost,
  resolveDnsCredentialForOwner,
  setDomainStatus,
  SiteServiceError,
  unbindCustomDomain,
  verifyDomainPointsToApp,
} from "@/lib/builder/site-publications";
import {
  DnsBindError,
  applyDnsRecords,
  planDnsRecords,
} from "@/lib/builder/dns-write";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface DomainBody {
  action?: "verify" | "bind" | "set-dns";
  domain?: string;
  provider?: string;
}

/** Builds the human DNS-record guidance to point `domain` at the app host. */
function requiredDnsRecords(domain: string | null, appHostname: string | null) {
  if (!appHostname) return [];
  const host = normalizeHost(domain) || "your-domain.com";
  return [
    {
      type: "A",
      name: host,
      value: `<same IP as ${appHostname}>`,
      purpose: `Point an A record at the same IP address that ${appHostname} resolves to.`,
    },
    {
      type: "CNAME",
      name: host,
      value: appHostname,
      purpose: `Alternative to the A record: CNAME to ${appHostname} (subdomains only; apex needs an A record or CNAME flattening).`,
    },
  ];
}

export async function GET(): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  const [publication, providers] = await Promise.all([
    getSitePublication(owner.agentId),
    listOwnerDnsProviders(owner.agentId),
  ]);
  const appHostname = getAppHostname();
  return NextResponse.json(
    {
      publication,
      appHostname,
      dnsProviders: providers,
      dnsRecords: requiredDnsRecords(publication?.customDomain ?? null, appHostname),
    },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  let body: DomainBody;
  try {
    body = (await request.json()) as DomainBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const domain = normalizeHost(body.domain);
  if (!domain) {
    return NextResponse.json(
      { error: "A custom domain is required." },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    // ---- Verify: does the domain resolve to this app host? ----------------
    if (body.action === "verify") {
      const verification = await verifyDomainPointsToApp(domain);
      // Record intent so a later bind knows which domain (status stays pending).
      await setDomainStatus(owner.agentId, DOMAIN_STATUS_PENDING, {
        customDomain: domain,
        domainError: verification.verified ? null : verification.detail,
      });
      return NextResponse.json(
        { verification, appHostname: getAppHostname() },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // ---- Bind: persist the domain so host-dispatch serves it --------------
    if (body.action === "bind") {
      const publication = await bindCustomDomain(owner.agentId, domain);
      return NextResponse.json(
        { publication },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // ---- Set DNS for me: write records via the owner's connector ----------
    if (body.action === "set-dns") {
      if (!body.provider) {
        return NextResponse.json(
          { error: "A DNS provider is required for automatic DNS setup." },
          { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
        );
      }
      const appHostname = getAppHostname();
      if (!appHostname) {
        return NextResponse.json(
          { error: "The app hostname is not configured on this instance." },
          { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
        );
      }
      const credential = await resolveDnsCredentialForOwner(owner.agentId, body.provider);
      const records = planDnsRecords(domain, { cnameTarget: appHostname });
      const apply = await applyDnsRecords(records, credential);
      const publication = await setDomainStatus(
        owner.agentId,
        apply.ok ? DOMAIN_STATUS_PENDING : DOMAIN_STATUS_MANUAL,
        { customDomain: domain, domainProvider: credential.provider, domainError: apply.ok ? null : apply.detail },
      );
      return NextResponse.json(
        { apply, publication, records },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    return NextResponse.json(
      { error: `Unknown action "${body.action}".` },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    if (error instanceof SiteServiceError || error instanceof DnsBindError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
    const message = error instanceof Error ? error.message : "Domain operation failed.";
    console.error("[api/builder/domain] POST failed:", error);
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

export async function DELETE(): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  const publication = await unbindCustomDomain(owner.agentId);
  return NextResponse.json(
    { publication },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}
