/**
 * POST /api/autobot/gpu — action-based dispatch
 *   actions: start | stop | heartbeat | refresh | decommission
 * GET  /api/autobot/gpu — returns status, gpu details, pricing
 *
 * Proxies GPU lifecycle management to the OpenClaw token server.
 * Controls the Vast.ai Chatterbox TTS instance.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

// POST /api/autobot/gpu — action-based dispatch via body { action: "start" | "stop" | "heartbeat" | "refresh" }
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;
  const validActions = ["start", "stop", "heartbeat", "refresh", "decommission"];
  if (!action || !validActions.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const settings = await getAutobotUserSettings(session.user.id).catch(() => null);
    const response = await fetch(`${OPENCLAW_URL}/api/gpu/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: settings?.gpuProvider,
        providerApiKey: settings?.gpuProviderApiKey || undefined,
        providerEndpoint: settings?.gpuProviderEndpoint || undefined,
        username: session.user.name || session.user.email || session.user.id,
        voice: settings?.voiceSample?.voiceId || undefined,
        voiceSampleStoredFileName: settings?.voiceSample?.storedFileName || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`GPU ${action} error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `GPU server returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : `Failed to ${action} GPU`;
    console.error(`GPU ${action} proxy error:`, errorMessage);
    return NextResponse.json(
      { error: `GPU proxy error: ${errorMessage}` },
      { status: 502 },
    );
  }
}

/** Fallback response when GPU/Chatterbox endpoint is unavailable */
const NO_GPU_RESPONSE = { status: "no_gpu" } as const;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await fetch(`${OPENCLAW_URL}/api/gpu/status`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    // 404 means the GPU/Chatterbox endpoint doesn't exist on the target server.
    // This is expected when no Vast.ai GPU is configured — return no_gpu silently.
    if (response.status === 404) {
      return NextResponse.json(NO_GPU_RESPONSE);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`GPU status error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `GPU server returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    // Network errors (ECONNREFUSED, DNS failure, etc.) mean the OpenClaw server
    // is unreachable. Treat as no GPU available rather than spamming error logs.
    return NextResponse.json(NO_GPU_RESPONSE);
  }
}
