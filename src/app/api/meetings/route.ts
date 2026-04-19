/**
 * POST /api/meetings
 *
 * Creates a new LiveKit meeting room and returns a host token.
 *
 * Request body:
 *   { roomName?: string, metadata?: Record<string, unknown> }
 *
 * Response:
 *   { roomName: string, token: string, url: string }
 *
 * Auth: requires authenticated session.
 * Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLiveKitConfig, createRoom, generateToken } from "@/lib/meetings/livekit";
import {
  ROOM_PREFIX_MEETING,
  STATUS_CREATED,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_SERVICE_UNAVAILABLE,
  ERROR_UNAUTHORIZED,
  ERROR_LIVEKIT_NOT_CONFIGURED,
} from "@/lib/meetings/constants";

export const dynamic = "force-dynamic";

/**
 * GET /api/meetings
 *
 * Lists active meeting rooms visible to the authenticated user.
 */
export async function GET() {
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

  try {
    const { listRooms } = await import("@/lib/meetings/livekit");
    const rooms = await listRooms(config);
    const meetingRooms = rooms.filter((r) =>
      r.name.startsWith(`${ROOM_PREFIX_MEETING}-`),
    );

    return NextResponse.json({
      rooms: meetingRooms.map((r) => ({
        name: r.name,
        numParticipants: r.numParticipants,
        maxParticipants: r.maxParticipants,
        creationTime: r.creationTime ? Number(r.creationTime) : null,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list rooms";
    console.error("List meetings error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

  let body: { roomName?: string; metadata?: Record<string, unknown> } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is acceptable; we'll generate a room name.
  }

  const roomName =
    body.roomName?.trim() ||
    `${ROOM_PREFIX_MEETING}-${crypto.randomUUID().slice(0, 8)}`;

  // Validate room name: alphanumeric, hyphens, underscores only.
  if (!/^[a-zA-Z0-9_-]+$/.test(roomName)) {
    return NextResponse.json(
      { error: "Room name may only contain alphanumeric characters, hyphens, and underscores" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const identity = session.user.id;
  const displayName = session.user.name || session.user.email || "Host";

  const roomMetadata = JSON.stringify({
    createdBy: identity,
    createdByName: displayName,
    createdAt: new Date().toISOString(),
    ...body.metadata,
  });

  try {
    const room = await createRoom(config, {
      roomName,
      metadata: roomMetadata,
    });

    const token = await generateToken(config, {
      roomName,
      identity,
      name: displayName,
    });

    return NextResponse.json(
      {
        roomName: room.name,
        token,
        url: config.url,
      },
      { status: STATUS_CREATED },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create meeting room";
    console.error("Create meeting error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
