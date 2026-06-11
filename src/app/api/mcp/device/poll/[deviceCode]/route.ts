/**
 * GET /api/mcp/device/poll/[deviceCode]
 *
 * RFC 8628 Device Authorization Grant — polling endpoint.
 * The headless client polls this with the device_code until the user
 * approves, denies, or the code expires.
 *
 * On first successful poll after approval, a scoped MCP token is issued
 * and the device code is marked as redeemed.
 */

import { NextResponse } from "next/server";
import { db } from "@/db";
import { mcpDeviceCodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { signPackedPayload } from "@/lib/federation-remote-session";

export const dynamic = "force-dynamic";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_SCOPES = [
  "mcp:tools",
  "profile:read",
  "profile:write",
  "post:create",
  "event:create",
  "offering:create",
  "group:write",
  "federation:write",
];

type RouteContext = { params: Promise<{ deviceCode: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { deviceCode } = await context.params;

  const [code] = await db
    .select()
    .from(mcpDeviceCodes)
    .where(eq(mcpDeviceCodes.deviceCode, deviceCode))
    .limit(1);

  if (!code) {
    return NextResponse.json({ error: "invalid_grant" }, { status: 404 });
  }

  const now = new Date();

  // Check expiry
  if (now > code.expiresAt) {
    if (code.status === "pending") {
      await db
        .update(mcpDeviceCodes)
        .set({ status: "expired" })
        .where(eq(mcpDeviceCodes.id, code.id));
    }
    return NextResponse.json(
      { status: "expired", error: "expired_token" },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Pending — tell client to slow down or keep polling
  if (code.status === "pending") {
    return NextResponse.json(
      { status: "pending", error: "authorization_pending" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Denied
  if (code.status === "denied") {
    return NextResponse.json(
      { status: "denied", error: "access_denied" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Already redeemed
  if (code.status === "redeemed") {
    return NextResponse.json(
      { status: "redeemed", error: "invalid_grant" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Approved — issue token and mark as redeemed
  if (code.status === "approved" && code.agentId) {
    const config = getInstanceConfig();
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const tokenJti = randomUUID();
    const tokenNow = Date.now();

    // Merge requested scopes with defaults
    const requestedScopes = Array.isArray(code.scopes) ? code.scopes as string[] : [];
    const scopes = requestedScopes.length > 0
      ? requestedScopes.filter((s) => DEFAULT_SCOPES.includes(s))
      : DEFAULT_SCOPES;
    // Always include mcp:tools
    if (!scopes.includes("mcp:tools")) scopes.unshift("mcp:tools");

    const payload = {
      type: "rivr_mcp_token",
      jti: tokenJti,
      actorId: code.agentId,
      controllerId: code.agentId,
      actorType: "human",
      issuer: baseUrl,
      audience: baseUrl,
      issuedAt: new Date(tokenNow).toISOString(),
      expiresAt: new Date(tokenNow + TOKEN_TTL_MS).toISOString(),
      scopes,
    };

    const token = signPackedPayload(payload as unknown as Record<string, unknown>);

    await db
      .update(mcpDeviceCodes)
      .set({ status: "redeemed", redeemedAt: now, tokenJti })
      .where(eq(mcpDeviceCodes.id, code.id));

    return NextResponse.json(
      {
        status: "approved",
        token,
        expires_in: Math.floor(TOKEN_TTL_MS / 1000),
        scopes,
        actor_id: code.agentId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Unknown state
  return NextResponse.json(
    { status: code.status, error: "server_error" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
