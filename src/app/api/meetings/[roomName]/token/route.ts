/**
 * POST /api/meetings/[roomName]/token
 *
 * Generates a LiveKit participant token for joining a meeting room.
 *
 * Request body:
 *   { identity: string, name?: string }
 *
 * Response:
 *   { token: string, url: string }
 *
 * Auth: requires authenticated session.
 * Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLiveKitConfig, generateToken } from "@/lib/meetings/livekit";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_SERVICE_UNAVAILABLE,
  ERROR_UNAUTHORIZED,
  ERROR_MISSING_IDENTITY,
  ERROR_LIVEKIT_NOT_CONFIGURED,
} from "@/lib/meetings/constants";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomName: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: ERROR_UNAUTHORIZED }, { status: STATUS_UNAUTHORIZED });
  }

  const config = getLiveKitConfig();
  if (!config) {
    return NextResponse.json(
      { error: ERROR_LIVEKIT_NOT_CONFIGURED },
      { status: STATUS_SERVICE_UNAVAILABLE },
    );
  }

  const { roomName } = await params;

  let body: { identity?: string; name?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Fall through to use session identity.
  }

  // Use explicit identity from body, or fall back to session user id.
  const identity = body.identity?.trim() || session.user.id;
  if (!identity) {
    return NextResponse.json(
      { error: ERROR_MISSING_IDENTITY },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const displayName =
    body.name?.trim() ||
    session.user.name ||
    session.user.email ||
    "Participant";

  try {
    const token = await generateToken(config, {
      roomName,
      identity,
      name: displayName,
    });

    return NextResponse.json(
      { token, url: config.url },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate token";
    console.error("Meeting token error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
