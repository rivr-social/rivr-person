/**
 * POST /api/mcp/device/approve
 *
 * RFC 8628 Device Authorization Grant — user approval step.
 * The authenticated user approves or denies a pending device code.
 * Called from the autobot dashboard's pending approvals widget.
 *
 * Body: { userCode: string, action: "approve" | "deny" }
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { mcpDeviceCodes } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { userCode?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userCode, action } = body;
  if (!userCode || typeof userCode !== "string") {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }
  if (action !== "approve" && action !== "deny") {
    return NextResponse.json({ error: "action must be 'approve' or 'deny'" }, { status: 400 });
  }

  // Look up the pending device code
  const [code] = await db
    .select()
    .from(mcpDeviceCodes)
    .where(
      and(
        eq(mcpDeviceCodes.userCode, userCode.toUpperCase()),
        eq(mcpDeviceCodes.status, "pending"),
      ),
    )
    .limit(1);

  if (!code) {
    return NextResponse.json({ error: "Device code not found or already resolved" }, { status: 404 });
  }

  // Check expiry
  if (new Date() > code.expiresAt) {
    await db
      .update(mcpDeviceCodes)
      .set({ status: "expired" })
      .where(eq(mcpDeviceCodes.id, code.id));
    return NextResponse.json({ error: "Device code has expired" }, { status: 410 });
  }

  const now = new Date();

  if (action === "deny") {
    await db
      .update(mcpDeviceCodes)
      .set({ status: "denied", approvedAt: now, agentId: session.user.id })
      .where(eq(mcpDeviceCodes.id, code.id));

    return NextResponse.json({ success: true, status: "denied" });
  }

  // Approve — mark as approved. Token issuance happens at poll time.
  await db
    .update(mcpDeviceCodes)
    .set({
      status: "approved",
      approvedAt: now,
      agentId: session.user.id,
    })
    .where(eq(mcpDeviceCodes.id, code.id));

  return NextResponse.json({ success: true, status: "approved" });
}

/**
 * GET /api/mcp/device/approve
 *
 * Returns pending device codes for the authenticated user's instance.
 * Used by the autobot dashboard to display approval prompts.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = await db
    .select({
      id: mcpDeviceCodes.id,
      userCode: mcpDeviceCodes.userCode,
      clientName: mcpDeviceCodes.clientName,
      scopes: mcpDeviceCodes.scopes,
      issuedAt: mcpDeviceCodes.issuedAt,
      expiresAt: mcpDeviceCodes.expiresAt,
    })
    .from(mcpDeviceCodes)
    .where(eq(mcpDeviceCodes.status, "pending"))
    .orderBy(mcpDeviceCodes.issuedAt);

  // Filter out expired ones
  const now = new Date();
  const active = pending.filter((c) => c.expiresAt > now);

  return NextResponse.json({ pending: active });
}
