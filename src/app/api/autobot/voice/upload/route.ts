/**
 * POST /api/autobot/voice/upload
 *
 * Stores a voice-clone reference sample in THIS instance's MinIO (the old
 * OpenClaw voice store is retired — samples uploaded there were lost with
 * it). The stored public URL conditions Chatterbox synthesis on the GPU
 * worker; settings.voiceSample is updated in the same call.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { saveAutobotUserSettings } from "@/lib/autobot-user-settings";
import {
  uploadVoiceSample,
  FileSizeError,
  InvalidMimeTypeError,
  StorageError,
} from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "voice";
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const audioFile = formData.get("audio");

    if (!audioFile || !(audioFile instanceof File)) {
      return NextResponse.json(
        { error: "audio file is required" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const uploaded = await uploadVoiceSample(
      buffer,
      audioFile.name || "voice.wav",
      audioFile.type || "audio/wav",
      session.user.id,
    );

    const voiceId = slugify(
      session.user.name || session.user.email || session.user.id,
    );
    const voiceSample = {
      fileName: audioFile.name || "voice.wav",
      size: uploaded.size,
      mimeType: uploaded.mimeType,
      uploadedAt: new Date(uploaded.timestamp).toISOString(),
      // storedFileName carries the storage KEY; URL resolution happens
      // server-side at synthesis time (see chatterbox-tts).
      storedFileName: uploaded.key,
      voiceId,
    };

    await saveAutobotUserSettings(session.user.id, { voiceSample });

    return NextResponse.json({
      ok: true,
      // The recorder component reads `sample` and re-persists it client-side;
      // it must carry the full record or the save clobbers storedFileName.
      sample: voiceSample,
      voiceId,
      storedFileName: uploaded.key,
      url: uploaded.url,
      size: uploaded.size,
    });
  } catch (error) {
    if (error instanceof FileSizeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidMimeTypeError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    if (error instanceof StorageError) {
      console.error("Voice sample upload failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.error("Voice sample upload failed:", error);
    return NextResponse.json({ error: "Voice upload failed" }, { status: 500 });
  }
}
