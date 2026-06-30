/**
 * POST /api/mcp/device/code
 *
 * RFC 8628 Device Authorization Grant — step 1.
 * A headless CLI or agent requests a device code pair. The user_code is shown
 * to the user, who visits the authorization page (or sees it in-app) to
 * approve. The client polls /api/mcp/device/poll/[deviceCode] until approved.
 */

import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/db";
import { mcpDeviceCodes } from "@/db/schema";
import { clampMcpScopes } from "@/lib/federation/mcp-scopes";

export const dynamic = "force-dynamic";

/** Device code validity: 15 minutes. */
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

/** Recommended poll interval in seconds. */
const POLL_INTERVAL_S = 5;

/**
 * Generate a user-friendly code in XXXX-XXXX format (alphanumeric, no ambiguous chars).
 */
function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I/O/0/1
  let code = "";
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 3) code += "-";
  }
  return code;
}

export async function POST(request: Request) {
  let body: { clientName?: string; scopes?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — defaults apply
  }

  const clientName = typeof body.clientName === "string" ? body.clientName.slice(0, 100) : null;
  // Clamp caller-requested scopes to the server allow-list up front (AUTH-SEC-005)
  // so (a) the row never stores scopes the server won't grant and (b) the
  // approval screen (which renders the stored scopes) shows the human the
  // EFFECTIVE scopes they are consenting to — not whatever the caller asked for.
  // The poll-time token mint clamps again as defense-in-depth. Purely
  // subtractive: an all-out-of-list request falls back to the minimal
  // `mcp:tools`, never the full default set.
  const requestedScopes = Array.isArray(body.scopes)
    ? clampMcpScopes(body.scopes).slice(0, 20)
    : [];
  const scopes = requestedScopes.length > 0 ? requestedScopes : ["mcp:tools"];

  const deviceCode = randomUUID();
  const userCode = generateUserCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);

  await db.insert(mcpDeviceCodes).values({
    deviceCode,
    userCode,
    clientName,
    scopes,
    status: "pending",
    expiresAt,
  });

  return NextResponse.json(
    {
      device_code: deviceCode,
      user_code: userCode,
      expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: POLL_INTERVAL_S,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
