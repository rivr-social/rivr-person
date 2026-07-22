/**
 * POST /api/autobot/tts
 *
 * Proxies text-to-speech requests to the OpenClaw token server's
 * Chatterbox TTS endpoint. Returns audio binary or a fallback signal.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requestChatterboxTts } from "@/lib/chatterbox-tts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

  const result = await requestChatterboxTts(session.user.id, text);

  switch (result.kind) {
    case "audio":
      return new Response(result.audio, {
        status: 200,
        headers: {
          "Content-Type": result.contentType,
          "Cache-Control": "no-cache",
        },
      });
    case "json":
      return NextResponse.json(result.data);
    case "error":
      console.error(`TTS error: ${result.status}`, result.detail);
      return NextResponse.json(
        { error: `TTS server returned ${result.status}` },
        { status: 502 },
      );
  }
}
