/**
 * POST /api/autobot/voice/token
 *
 * Proxies LiveKit token requests to the OpenClaw token server.
 * Returns a JWT for joining the LiveKit voice room.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const username = session.user.name || session.user.email || "rivr-user";

  try {
    const response = await fetch(`${OPENCLAW_URL}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`LiveKit token error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `Token server returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get voice token";
    console.error("Voice token proxy error:", errorMessage);
    return NextResponse.json(
      { error: `Voice token proxy error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
