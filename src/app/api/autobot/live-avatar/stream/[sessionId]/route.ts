/**
 * GET /api/autobot/live-avatar/stream/[sessionId]
 *
 * Authenticated MJPEG passthrough: pipes the worker's
 * multipart/x-mixed-replace stream to the browser so an <img> tag can
 * render it with same-origin cookies — the worker itself is never
 * exposed to the client.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  LiveAvatarWorkerError,
  openAvatarStream,
} from "@/lib/live-avatar-worker";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await context.params;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const upstream = await openAvatarStream(sessionId);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ||
          "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Live avatar stream proxy failed:", error);
    if (error instanceof LiveAvatarWorkerError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "Failed to open live avatar stream" },
      { status: 502 },
    );
  }
}
