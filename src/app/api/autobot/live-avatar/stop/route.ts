/**
 * POST /api/autobot/live-avatar/stop  { sessionId }
 *
 * Barge-in: immediately cuts the avatar's current utterance (the client
 * pauses audio playback; this stops the mouth motion to match).
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  LiveAvatarWorkerError,
  stopSpeaking,
} from "@/lib/live-avatar-worker";

export const dynamic = "force-dynamic";

type StopRequestBody = { sessionId?: string };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: StopRequestBody;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!body.sessionId || typeof body.sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    await stopSpeaking(body.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LiveAvatarWorkerError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: "Failed to stop speaking" }, { status: 502 });
  }
}
