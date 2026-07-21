/**
 * POST /api/autobot/live-avatar/speak  { sessionId, text }
 *
 * Voices an assistant reply through the live avatar: synthesizes the
 * text with Chatterbox (voice-clone lane), drives the worker session's
 * mouth with the resulting audio, and returns the audio to the browser
 * for playback. When no clone audio is available the worker falls back
 * to text-timed mouth motion and the browser speaks via speechSynthesis.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requestChatterboxTts, TTS_MAX_TEXT_LENGTH } from "@/lib/chatterbox-tts";
import {
  LiveAvatarWorkerError,
  speakAudio,
  speakText,
} from "@/lib/live-avatar-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SpeakRequestBody = { sessionId?: string; text?: string };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SpeakRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!sessionId || !text) {
    return NextResponse.json(
      { error: "sessionId and text are required" },
      { status: 400 },
    );
  }

  const speechText = text.slice(0, TTS_MAX_TEXT_LENGTH);
  const username = session.user.name || session.user.email || session.user.id;
  const tts = await requestChatterboxTts(
    session.user.id,
    username,
    speechText,
  );

  try {
    if (tts.kind === "audio") {
      // Text rides along so frame-swap sessions can build a phoneme-viseme
      // timeline matched to the real audio duration.
      const result = await speakAudio(
        sessionId,
        tts.audio,
        tts.contentType,
        speechText,
      );
      return NextResponse.json({
        mode: "clone",
        durationMs: result.durationMs,
        mimeType: tts.contentType,
        audioBase64: Buffer.from(tts.audio).toString("base64"),
      });
    }

    // No clone audio (GPU down / no voice sample / fallback signal):
    // text-timed mouth motion + browser speechSynthesis on the client.
    const result = await speakText(sessionId, speechText);
    return NextResponse.json({
      mode: "browser",
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error("Live avatar speak failed:", error);
    if (error instanceof LiveAvatarWorkerError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "Failed to voice the reply" },
      { status: 502 },
    );
  }
}
