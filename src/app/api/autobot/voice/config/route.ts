/**
 * GET /api/autobot/voice/config
 *
 * Proxies LiveKit configuration from the OpenClaw token server.
 * Returns the LiveKit WebSocket URL needed for voice room connections.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [response, userSettings] = await Promise.all([
      fetch(`${OPENCLAW_URL}/api/config`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
      getAutobotUserSettings(session.user.id),
    ]);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`Voice config error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `Config server returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json({
      ...data,
      userSettings,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get voice config";
    console.error("Voice config proxy error:", errorMessage);
    return NextResponse.json(
      { error: `Voice config proxy error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
