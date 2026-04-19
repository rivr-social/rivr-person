/**
 * POST /api/meetings/[roomName]/livestream
 *   Start RTMP egress (livestream) for a meeting room.
 *   Body: { rtmpUrl: string }
 *   Response: { egressId: string, status: string }
 *
 * DELETE /api/meetings/[roomName]/livestream
 *   Stop the active livestream for a meeting room.
 *   Response: { stopped: true }
 *
 * GET /api/meetings/[roomName]/livestream
 *   Get current livestream status.
 *   Response: { status: "idle" | "streaming", egresses: [...] }
 *
 * Auth: requires authenticated session.
 * Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getLiveKitConfig,
  startRtmpEgress,
  stopEgress,
  listEgresses,
} from "@/lib/meetings/livekit";
import {
  STATUS_OK,
  STATUS_CREATED,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_NOT_FOUND,
  STATUS_SERVICE_UNAVAILABLE,
  LIVESTREAM_STATUS,
  ERROR_UNAUTHORIZED,
  ERROR_MISSING_RTMP_URL,
  ERROR_LIVEKIT_NOT_CONFIGURED,
  ERROR_EGRESS_NOT_FOUND,
} from "@/lib/meetings/constants";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
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

  try {
    const egresses = await listEgresses(config, roomName);
    const activeEgresses = egresses.filter(
      (e) => e.status !== undefined && e.status <= 2, // EGRESS_ACTIVE or EGRESS_STARTING
    );

    return NextResponse.json({
      status:
        activeEgresses.length > 0
          ? LIVESTREAM_STATUS.STREAMING
          : LIVESTREAM_STATUS.IDLE,
      egresses: activeEgresses.map((e) => ({
        egressId: e.egressId,
        status: e.status,
        startedAt: e.startedAt ? Number(e.startedAt) : null,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to get livestream status";
    console.error("Livestream status error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

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

  let body: { rtmpUrl?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: ERROR_MISSING_RTMP_URL },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const rtmpUrl = body.rtmpUrl?.trim();
  if (!rtmpUrl) {
    return NextResponse.json(
      { error: ERROR_MISSING_RTMP_URL },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    const egress = await startRtmpEgress(config, roomName, rtmpUrl);

    return NextResponse.json(
      {
        egressId: egress.egressId,
        status: LIVESTREAM_STATUS.STREAMING,
      },
      { status: STATUS_CREATED },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start livestream";
    console.error("Start livestream error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
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

  try {
    const egresses = await listEgresses(config, roomName);
    const activeEgresses = egresses.filter(
      (e) => e.status !== undefined && e.status <= 2,
    );

    if (activeEgresses.length === 0) {
      return NextResponse.json(
        { error: ERROR_EGRESS_NOT_FOUND },
        { status: STATUS_NOT_FOUND },
      );
    }

    // Stop all active egresses for this room.
    await Promise.all(
      activeEgresses.map((e) => stopEgress(config, e.egressId)),
    );

    return NextResponse.json(
      { stopped: true, count: activeEgresses.length },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to stop livestream";
    console.error("Stop livestream error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
