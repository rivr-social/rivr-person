import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  isTranscriptionConfigured,
  transcribeAudioFile,
} from "@/lib/transcription";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  if (!isTranscriptionConfigured()) {
    return NextResponse.json(
      { error: "Transcription is not configured on this deployment." },
      { status: 503 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("audio");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "An audio file is required in the 'audio' field." },
      { status: 400 },
    );
  }

  try {
    const transcription = await transcribeAudioFile(file);
    return NextResponse.json({
      success: true,
      text: transcription.text,
      segments: transcription.segments ?? [],
      language: transcription.language ?? null,
      provider: transcription.provider,
    });
  } catch (error) {
    console.error("[autobot-transcribe] failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to transcribe audio.",
      },
      { status: 500 },
    );
  }
}
