/**
 * POST /api/autobot/tts
 *
 * Proxies text-to-speech requests to the OpenClaw token server's
 * Chatterbox TTS endpoint. Returns audio binary or a fallback signal.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const MAX_TEXT_LENGTH = 2000;

interface TtsRequestBody {
  text: string;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TtsRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { text } = body;
  if (!text || typeof text !== "string") {
    return NextResponse.json(
      { error: "text is required and must be a string" },
      { status: 400 },
    );
  }

  try {
    const settings = await getAutobotUserSettings(session.user.id).catch(() => null);
    const response = await fetch(`${OPENCLAW_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, MAX_TEXT_LENGTH),
        provider: settings?.gpuProvider,
        providerApiKey: settings?.gpuProviderApiKey || undefined,
        providerEndpoint: settings?.gpuProviderEndpoint || undefined,
        voice: settings?.voiceSample?.voiceId || undefined,
        voiceSampleStoredFileName: settings?.voiceSample?.storedFileName || undefined,
        username: session.user.name || session.user.email || session.user.id,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`TTS error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `TTS server returned ${response.status}` },
        { status: 502 },
      );
    }

    const contentType = response.headers.get("content-type") || "";

    // If the response is audio, stream it back
    if (contentType.startsWith("audio/")) {
      const audioBuffer = await response.arrayBuffer();
      return new Response(audioBuffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
        },
      });
    }

    // Otherwise it's a JSON fallback signal
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach TTS server";
    console.error("TTS proxy error:", errorMessage);
    // Return fallback signal so client uses browser TTS
    return NextResponse.json({ fallback: true });
  }
}
