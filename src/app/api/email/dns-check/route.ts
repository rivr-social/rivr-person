/**
 * DNS verification API route for personal email setup.
 *
 * Purpose:
 * - Accepts a domain query parameter and returns DNS verification results.
 * - Allows the UI to poll/refresh DNS status without server actions.
 * - Delegates to the same DNS verification logic used by the server action.
 *
 * Auth: Requires authenticated session.
 * Method: GET
 * Query params: domain (required)
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveMx, resolveTxt, resolve } from "dns/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_INTERNAL_ERROR = 500;

type DnsRecordResult = {
  type: string;
  name: string;
  expectedValue: string;
  verified: boolean;
  actualValue?: string;
  note?: string;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: HTTP_STATUS_UNAUTHORIZED }
    );
  }

  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain")?.trim().toLowerCase();

  if (!domain || !DOMAIN_RE.test(domain)) {
    return NextResponse.json(
      { error: "A valid domain parameter is required." },
      { status: HTTP_STATUS_BAD_REQUEST }
    );
  }

  const serverIp = searchParams.get("serverIp")?.trim() || "";

  try {
    const records: DnsRecordResult[] = [];

    // MX record check
    try {
      const mxRecords = await resolveMx(domain);
      const hasMx = mxRecords.some(
        (mx) =>
          mx.exchange.toLowerCase() === `mail.${domain}` ||
          mx.exchange.toLowerCase() === `mail.${domain}.`
      );
      records.push({
        type: "MX",
        name: domain,
        expectedValue: `10 mail.${domain}`,
        verified: hasMx,
        actualValue: mxRecords.map((mx) => `${mx.priority} ${mx.exchange}`).join(", ") || "none",
      });
    } catch {
      records.push({
        type: "MX",
        name: domain,
        expectedValue: `10 mail.${domain}`,
        verified: false,
        actualValue: "not found",
      });
    }

    // A record for mail subdomain
    try {
      const aRecords = await resolve(`mail.${domain}`, "A");
      const hasA = serverIp ? aRecords.includes(serverIp) : aRecords.length > 0;
      records.push({
        type: "A",
        name: `mail.${domain}`,
        expectedValue: serverIp || "<your server IP>",
        verified: hasA,
        actualValue: aRecords.join(", ") || "none",
      });
    } catch {
      records.push({
        type: "A",
        name: `mail.${domain}`,
        expectedValue: serverIp || "<your server IP>",
        verified: false,
        actualValue: "not found",
      });
    }

    // SPF record
    try {
      const txtRecords = await resolveTxt(domain);
      const flatTxt = txtRecords.map((arr) => arr.join(""));
      const spfRecord = flatTxt.find((txt) => txt.startsWith("v=spf1"));
      const hasSpf = spfRecord
        ? serverIp
          ? spfRecord.includes(`ip4:${serverIp}`)
          : spfRecord.startsWith("v=spf1")
        : false;
      records.push({
        type: "TXT (SPF)",
        name: domain,
        expectedValue: serverIp ? `v=spf1 ip4:${serverIp} ~all` : "v=spf1 ... ~all",
        verified: hasSpf,
        actualValue: spfRecord || "not found",
      });
    } catch {
      records.push({
        type: "TXT (SPF)",
        name: domain,
        expectedValue: serverIp ? `v=spf1 ip4:${serverIp} ~all` : "v=spf1 ... ~all",
        verified: false,
        actualValue: "not found",
      });
    }

    // DKIM record
    try {
      const dkimRecords = await resolveTxt(`mail._domainkey.${domain}`);
      const flatDkim = dkimRecords.map((arr) => arr.join(""));
      const hasDkim = flatDkim.some((txt) => txt.includes("v=DKIM1"));
      records.push({
        type: "TXT (DKIM)",
        name: `mail._domainkey.${domain}`,
        expectedValue: "v=DKIM1; k=rsa; p=<generated>",
        verified: hasDkim,
        actualValue: hasDkim
          ? flatDkim.find((t) => t.includes("v=DKIM1"))?.substring(0, 80) + "..."
          : "not found",
        note: hasDkim ? undefined : "Generated after mail server setup.",
      });
    } catch {
      records.push({
        type: "TXT (DKIM)",
        name: `mail._domainkey.${domain}`,
        expectedValue: "v=DKIM1; k=rsa; p=<generated>",
        verified: false,
        actualValue: "not found",
        note: "Generated after mail server setup.",
      });
    }

    // DMARC record
    try {
      const dmarcRecords = await resolveTxt(`_dmarc.${domain}`);
      const flatDmarc = dmarcRecords.map((arr) => arr.join(""));
      const hasDmarc = flatDmarc.some((txt) => txt.startsWith("v=DMARC1"));
      records.push({
        type: "TXT (DMARC)",
        name: `_dmarc.${domain}`,
        expectedValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
        verified: hasDmarc,
        actualValue: flatDmarc.find((t) => t.startsWith("v=DMARC1")) || "not found",
      });
    } catch {
      records.push({
        type: "TXT (DMARC)",
        name: `_dmarc.${domain}`,
        expectedValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
        verified: false,
        actualValue: "not found",
      });
    }

    // PTR record note
    records.push({
      type: "PTR",
      name: serverIp || "<your server IP>",
      expectedValue: `mail.${domain}`,
      verified: false,
      note: "Set in hosting provider console (reverse DNS). Cannot be verified from here.",
    });

    const allVerified = records
      .filter((r) => r.type !== "PTR" && !r.note?.includes("Generated"))
      .every((r) => r.verified);

    return NextResponse.json({
      domain,
      records,
      allVerified,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dns-check] Error verifying DNS for ${domain}: ${message}`);
    return NextResponse.json(
      { error: "Unable to verify DNS records." },
      { status: HTTP_STATUS_INTERNAL_ERROR }
    );
  }
}
