/**
 * Admin endpoint for combined Traefik dynamic configuration.
 *
 * GET /api/settings/domain/traefik-config
 *
 * Returns the combined Traefik dynamic config YAML for all active custom
 * domains on this instance. Intended to be polled by a deploy agent or
 * cron job running on the host.
 *
 * Auth: Requires NODE_ADMIN_KEY via Bearer token or x-admin-key header.
 * This is an infrastructure endpoint, not a user-facing one.
 *
 * Response formats:
 * - Accept: text/yaml (or ?format=yaml) returns raw YAML
 * - Default returns JSON with the YAML in a `config` field
 *
 * @module api/settings/domain/traefik-config
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { domainConfigs } from "@/db/schema";
import { getEnv } from "@/lib/env";
import {
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  generateCombinedTraefikConfig,
  generateTraefikConfig,
} from "@/lib/traefik-config";

export const dynamic = "force-dynamic";

/**
 * Validates the admin key from the request against NODE_ADMIN_KEY.
 * Accepts either:
 * - Authorization: Bearer <key>
 * - x-admin-key: <key>
 */
function validateAdminKey(request: NextRequest): boolean {
  const adminKey = getEnv("NODE_ADMIN_KEY")?.trim();
  if (!adminKey) {
    console.warn(
      "[traefik-config] NODE_ADMIN_KEY is not configured. Admin endpoint will reject all requests."
    );
    return false;
  }

  // Check Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return secureEqual(token, adminKey);
  }

  // Check x-admin-key header
  const xAdminKey = request.headers.get("x-admin-key");
  if (xAdminKey) {
    return secureEqual(xAdminKey.trim(), adminKey);
  }

  return false;
}

/** Constant-time string comparison to prevent timing attacks. */
function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * GET /api/settings/domain/traefik-config
 *
 * Returns combined Traefik dynamic config for all active custom domains.
 *
 * Query parameters:
 * - format=yaml — Force YAML response (also triggered by Accept: text/yaml)
 * - regenerate=true — Regenerate from scratch instead of using stored configs
 */
export async function GET(request: NextRequest) {
  if (!validateAdminKey(request)) {
    return NextResponse.json(
      { error: "Valid admin key required. Provide via Authorization: Bearer <key> or x-admin-key header." },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  try {
    // Fetch all active domain configs
    const activeConfigs = await db
      .select({
        id: domainConfigs.id,
        customDomain: domainConfigs.customDomain,
        traefikConfig: domainConfigs.traefikConfig,
        traefikConfigGeneratedAt: domainConfigs.traefikConfigGeneratedAt,
        agentId: domainConfigs.agentId,
      })
      .from(domainConfigs)
      .where(eq(domainConfigs.verificationStatus, "active"));

    const shouldRegenerate =
      request.nextUrl.searchParams.get("regenerate") === "true";

    let combinedYaml: string;

    if (shouldRegenerate || activeConfigs.some((c) => !c.traefikConfig)) {
      // Regenerate combined config from all active domains
      const activeDomains = activeConfigs.map((c) => c.customDomain);
      combinedYaml = generateCombinedTraefikConfig(activeDomains);

      // Update stored configs for each domain that was regenerated
      const now = new Date();
      for (const cfg of activeConfigs) {
        const singleYaml = generateTraefikConfig(cfg.customDomain);
        await db
          .update(domainConfigs)
          .set({
            traefikConfig: singleYaml,
            traefikConfigGeneratedAt: now,
            updatedAt: now,
          })
          .where(eq(domainConfigs.id, cfg.id));
      }
    } else {
      // Use the combined generator for a clean single-file output
      const activeDomains = activeConfigs.map((c) => c.customDomain);
      combinedYaml = generateCombinedTraefikConfig(activeDomains);
    }

    // Determine response format
    const acceptHeader = request.headers.get("accept") ?? "";
    const formatParam = request.nextUrl.searchParams.get("format");
    const wantsYaml =
      formatParam === "yaml" || acceptHeader.includes("text/yaml");

    if (wantsYaml) {
      return new NextResponse(combinedYaml, {
        status: STATUS_OK,
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(
      {
        activeDomains: activeConfigs.map((c) => ({
          domain: c.customDomain,
          agentId: c.agentId,
          configGeneratedAt: c.traefikConfigGeneratedAt?.toISOString() ?? null,
        })),
        config: combinedYaml,
        domainCount: activeConfigs.length,
        generatedAt: new Date().toISOString(),
      },
      {
        status: STATUS_OK,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    console.error("[traefik-config] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to generate Traefik configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
