/**
 * POST /api/events/[id]/meeting
 *   Create or retrieve a meeting room linked to an event resource.
 *   Stores the room name in the event resource's metadata.
 *
 * GET /api/events/[id]/meeting
 *   Get meeting status for an event, including participant count.
 *
 * Auth: requires authenticated session.
 * Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getLiveKitConfig,
  createRoom,
  generateToken,
  listParticipants,
} from "@/lib/meetings/livekit";
import {
  ROOM_PREFIX_EVENT,
  STATUS_OK,
  STATUS_CREATED,
  STATUS_UNAUTHORIZED,
  STATUS_NOT_FOUND,
  STATUS_SERVICE_UNAVAILABLE,
  MEETING_STATUS,
  ERROR_UNAUTHORIZED,
  ERROR_LIVEKIT_NOT_CONFIGURED,
  ERROR_EVENT_NOT_FOUND,
  META_MEETING_ROOM,
  META_MEETING_CREATED_AT,
  META_MEETING_CREATED_BY,
} from "@/lib/meetings/constants";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const { id } = await params;

  // Look up the event resource.
  const [event] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, id))
    .limit(1);

  if (!event || event.type !== "event") {
    return NextResponse.json(
      { error: ERROR_EVENT_NOT_FOUND },
      { status: STATUS_NOT_FOUND },
    );
  }

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const roomName = metadata[META_MEETING_ROOM] as string | undefined;

  if (!roomName) {
    return NextResponse.json({
      status: MEETING_STATUS.ENDED,
      roomName: null,
      numParticipants: 0,
    });
  }

  try {
    const participants = await listParticipants(config, roomName);
    return NextResponse.json({
      status:
        participants.length > 0 ? MEETING_STATUS.ACTIVE : MEETING_STATUS.ENDED,
      roomName,
      numParticipants: participants.length,
    });
  } catch {
    // Room may have been cleaned up by LiveKit. Report as ended.
    return NextResponse.json({
      status: MEETING_STATUS.ENDED,
      roomName,
      numParticipants: 0,
    });
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const { id } = await params;

  // Look up the event resource.
  const [event] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, id))
    .limit(1);

  if (!event || event.type !== "event") {
    return NextResponse.json(
      { error: ERROR_EVENT_NOT_FOUND },
      { status: STATUS_NOT_FOUND },
    );
  }

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const existingRoom = metadata[META_MEETING_ROOM] as string | undefined;

  // If a room already exists for this event, return a join token for it.
  if (existingRoom) {
    try {
      const token = await generateToken(config, {
        roomName: existingRoom,
        identity: session.user.id,
        name: session.user.name || session.user.email || "Participant",
      });

      return NextResponse.json(
        { roomName: existingRoom, token, url: config.url, created: false },
        { status: STATUS_OK },
      );
    } catch {
      // Room may have expired; fall through to create a new one.
    }
  }

  // Create a new room for this event.
  const roomName = `${ROOM_PREFIX_EVENT}-${id.slice(0, 8)}-${Date.now().toString(36)}`;
  const identity = session.user.id;
  const displayName = session.user.name || session.user.email || "Host";

  try {
    const roomMetadata = JSON.stringify({
      eventId: id,
      eventName: event.name,
      createdBy: identity,
    });

    await createRoom(config, { roomName, metadata: roomMetadata });

    const token = await generateToken(config, {
      roomName,
      identity,
      name: displayName,
    });

    // Store the room name in the event resource metadata.
    const updatedMetadata = {
      ...metadata,
      [META_MEETING_ROOM]: roomName,
      [META_MEETING_CREATED_AT]: new Date().toISOString(),
      [META_MEETING_CREATED_BY]: identity,
    };

    await db
      .update(resources)
      .set({ metadata: updatedMetadata, updatedAt: new Date() })
      .where(eq(resources.id, id));

    return NextResponse.json(
      { roomName, token, url: config.url, created: true },
      { status: STATUS_CREATED },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create event meeting";
    console.error("Event meeting creation error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
