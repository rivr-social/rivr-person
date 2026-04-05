/**
 * Custom domain configuration API route.
 *
 * Endpoints:
 * - GET  — Returns current custom domain config (domain, verification status, DNS records needed).
 * - POST — Sets a new custom domain and generates a verification token.
 * - DELETE — Removes the custom domain configuration.
 *
 * Auth: All endpoints require an authenticated session.
 *
 * Integration note: This route manages the application-level domain lifecycle.
 * Actual Traefik router/certificate configuration must be applied separately
 * on the host. When a domain reaches "active" status, a deploy agent or
 * webhook should write the corresponding Traefik dynamic config entry
 * (e.g., a new router with TLS/Let's Encrypt ACME challenge).
 *
 * @module api/settings/domain
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { domainConfigs } from "@/db/schema";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_NOT_FOUND,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  generateVerificationToken,
  isValidDomain,
  normalizeDomain,
  verifyDomain,
  getRequiredDnsRecords,
} from "@/lib/domain-verification";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/domain
 *
 * Returns the authenticated user's current custom domain configuration,
 * including required DNS records and verification status.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  try {
    const [config] = await db
      .select()
      .from(domainConfigs)
      .where(eq(domainConfigs.agentId, session.user.id))
      .limit(1);

    if (!config) {
      return NextResponse.json({
        configured: false,
        domain: null,
        verificationStatus: null,
        verificationToken: null,
        verifiedAt: null,
        dnsRecords: [],
      }, { status: STATUS_OK });
    }

    const dnsRecords = getRequiredDnsRecords(
      config.customDomain,
      config.verificationToken
    );

    return NextResponse.json({
      configured: true,
      domain: config.customDomain,
      verificationStatus: config.verificationStatus,
      verificationToken: config.verificationToken,
      verifiedAt: config.verifiedAt,
      dnsRecords,
    }, { status: STATUS_OK });
  } catch (error) {
    console.error("[domain-config] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to retrieve domain configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}

/**
 * POST /api/settings/domain
 *
 * Body options:
 * - `{ domain: string }` — Set or update the custom domain.
 * - `{ action: "verify" }` — Re-run DNS verification on the current domain.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  let body: { domain?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  try {
    // Action: verify existing domain
    if (body.action === "verify") {
      const [existing] = await db
        .select()
        .from(domainConfigs)
        .where(eq(domainConfigs.agentId, session.user.id))
        .limit(1);

      if (!existing) {
        return NextResponse.json(
          { error: "No domain configured. Set a domain first." },
          { status: STATUS_NOT_FOUND }
        );
      }

      const verificationResult = await verifyDomain(
        existing.customDomain,
        existing.verificationToken
      );

      // Update status if it advanced
      const newStatus = verificationResult.computedStatus;
      const statusAdvanced =
        (existing.verificationStatus === "pending" && newStatus !== "pending") ||
        (existing.verificationStatus === "verified" && newStatus === "active");

      if (statusAdvanced) {
        const updateFields: Record<string, unknown> = {
          verificationStatus: newStatus,
          updatedAt: new Date(),
        };
        if (newStatus === "verified" || newStatus === "active") {
          updateFields.verifiedAt = new Date();
        }

        await db
          .update(domainConfigs)
          .set(updateFields)
          .where(eq(domainConfigs.id, existing.id));
      }

      const dnsRecords = getRequiredDnsRecords(
        existing.customDomain,
        existing.verificationToken
      );

      return NextResponse.json({
        configured: true,
        domain: existing.customDomain,
        verificationStatus: statusAdvanced ? newStatus : existing.verificationStatus,
        verificationToken: existing.verificationToken,
        verifiedAt: statusAdvanced ? new Date().toISOString() : existing.verifiedAt,
        dnsRecords,
        verification: verificationResult,
      }, { status: STATUS_OK });
    }

    // Action: set or update domain
    if (!body.domain || typeof body.domain !== "string") {
      return NextResponse.json(
        { error: "A domain string is required" },
        { status: STATUS_BAD_REQUEST }
      );
    }

    const domain = normalizeDomain(body.domain);

    if (!isValidDomain(domain)) {
      return NextResponse.json(
        { error: "Invalid domain format. Provide a valid domain like example.com or sub.example.com." },
        { status: STATUS_BAD_REQUEST }
      );
    }

    // Check if another agent already owns this domain
    const [conflicting] = await db
      .select({ agentId: domainConfigs.agentId })
      .from(domainConfigs)
      .where(eq(domainConfigs.customDomain, domain))
      .limit(1);

    if (conflicting && conflicting.agentId !== session.user.id) {
      return NextResponse.json(
        { error: "This domain is already configured for another instance." },
        { status: STATUS_BAD_REQUEST }
      );
    }

    const token = generateVerificationToken();

    // Upsert: update existing or insert new
    const [existing] = await db
      .select()
      .from(domainConfigs)
      .where(eq(domainConfigs.agentId, session.user.id))
      .limit(1);

    if (existing) {
      // Domain changed — reset verification
      const domainChanged = existing.customDomain !== domain;
      await db
        .update(domainConfigs)
        .set({
          customDomain: domain,
          verificationToken: domainChanged ? token : existing.verificationToken,
          verificationStatus: domainChanged ? "pending" : existing.verificationStatus,
          verifiedAt: domainChanged ? null : existing.verifiedAt,
          updatedAt: new Date(),
        })
        .where(eq(domainConfigs.id, existing.id));

      const effectiveToken = domainChanged ? token : existing.verificationToken;
      const effectiveStatus = domainChanged ? "pending" : existing.verificationStatus;
      const dnsRecords = getRequiredDnsRecords(domain, effectiveToken);

      return NextResponse.json({
        configured: true,
        domain,
        verificationStatus: effectiveStatus,
        verificationToken: effectiveToken,
        verifiedAt: domainChanged ? null : existing.verifiedAt,
        dnsRecords,
      }, { status: STATUS_OK });
    }

    // Insert new config
    await db.insert(domainConfigs).values({
      agentId: session.user.id,
      customDomain: domain,
      verificationToken: token,
      verificationStatus: "pending",
    });

    const dnsRecords = getRequiredDnsRecords(domain, token);

    return NextResponse.json({
      configured: true,
      domain,
      verificationStatus: "pending",
      verificationToken: token,
      verifiedAt: null,
      dnsRecords,
    }, { status: STATUS_OK });
  } catch (error) {
    console.error("[domain-config] POST failed:", error);
    return NextResponse.json(
      { error: "Failed to save domain configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}

/**
 * DELETE /api/settings/domain
 *
 * Removes the authenticated user's custom domain configuration entirely.
 *
 * Integration note: After deletion, a deploy agent should also remove the
 * corresponding Traefik dynamic config entry on the host.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  try {
    const deleted = await db
      .delete(domainConfigs)
      .where(eq(domainConfigs.agentId, session.user.id))
      .returning({ id: domainConfigs.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "No domain configuration found to remove" },
        { status: STATUS_NOT_FOUND }
      );
    }

    return NextResponse.json({
      configured: false,
      domain: null,
      verificationStatus: null,
      verificationToken: null,
      verifiedAt: null,
      dnsRecords: [],
    }, { status: STATUS_OK });
  } catch (error) {
    console.error("[domain-config] DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to remove domain configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
