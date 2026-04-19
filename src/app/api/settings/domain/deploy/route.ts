/**
 * Deploy hook for Traefik configuration generation.
 *
 * POST /api/settings/domain/deploy
 *
 * When a custom domain reaches "active" status, this endpoint can be called
 * to (re-)generate and store the Traefik dynamic config YAML. The config is
 * persisted in the database so a host-side deploy agent or cron can poll the
 * admin traefik-config endpoint to pick it up.
 *
 * Auth: Requires an authenticated session (the domain owner).
 *
 * @module api/settings/domain/deploy
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
import { generateTraefikConfig } from "@/lib/traefik-config";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/domain/deploy
 *
 * Generates (or regenerates) the Traefik dynamic config for the
 * authenticated user's active custom domain and stores it in the database.
 *
 * Returns the generated YAML for review.
 */
export async function POST() {
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
      return NextResponse.json(
        { error: "No domain configured. Set a domain first." },
        { status: STATUS_NOT_FOUND }
      );
    }

    if (config.verificationStatus !== "active") {
      return NextResponse.json(
        {
          error: "Domain must be in 'active' status before Traefik config can be deployed.",
          currentStatus: config.verificationStatus,
        },
        { status: STATUS_BAD_REQUEST }
      );
    }

    const traefikYaml = generateTraefikConfig(config.customDomain);
    const generatedAt = new Date();

    await db
      .update(domainConfigs)
      .set({
        traefikConfig: traefikYaml,
        traefikConfigGeneratedAt: generatedAt,
        updatedAt: generatedAt,
      })
      .where(eq(domainConfigs.id, config.id));

    return NextResponse.json(
      {
        domain: config.customDomain,
        verificationStatus: config.verificationStatus,
        traefikConfig: traefikYaml,
        generatedAt: generatedAt.toISOString(),
        instructions: [
          "The Traefik config has been generated and stored.",
          "A deploy agent on the host can poll GET /api/settings/domain/traefik-config",
          "with the NODE_ADMIN_KEY to retrieve the combined config for all active domains.",
          "Write the YAML to Traefik's dynamic config directory (e.g., /etc/traefik/dynamic/custom-domains.yml)",
          "and Traefik's file provider will automatically pick it up.",
        ],
      },
      { status: STATUS_OK }
    );
  } catch (error) {
    console.error("[domain-deploy] POST failed:", error);
    return NextResponse.json(
      { error: "Failed to generate Traefik configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}

/**
 * GET /api/settings/domain/deploy
 *
 * Returns the current stored Traefik config for the authenticated user's domain.
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
      return NextResponse.json(
        { error: "No domain configured." },
        { status: STATUS_NOT_FOUND }
      );
    }

    return NextResponse.json(
      {
        domain: config.customDomain,
        verificationStatus: config.verificationStatus,
        traefikConfig: config.traefikConfig ?? null,
        generatedAt: config.traefikConfigGeneratedAt?.toISOString() ?? null,
      },
      { status: STATUS_OK }
    );
  } catch (error) {
    console.error("[domain-deploy] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to retrieve Traefik configuration" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
