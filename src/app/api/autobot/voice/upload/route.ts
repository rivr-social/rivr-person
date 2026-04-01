/**
 * POST /api/autobot/voice/upload
 *
 * Proxies voice sample uploads to the OpenClaw token server for voice cloning.
 * Accepts multipart/form-data with an audio file.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

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

    if (audioFile.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: "File exceeds 25MB limit" },
        { status: 400 },
      );
    }

    // Forward the file to the OpenClaw token server
    const upstreamForm = new FormData();
    upstreamForm.append("audio", audioFile);
    upstreamForm.append("username", session.user.name || session.user.email || "rivr-user");

    const response = await fetch(`${OPENCLAW_URL}/api/voice/upload`, {
      method: "POST",
      body: upstreamForm,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`Voice upload error: ${response.status}`, errorText);
      return NextResponse.json(
        { error: `Upload server returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to upload voice sample";
    console.error("Voice upload proxy error:", errorMessage);
    return NextResponse.json(
      { error: `Voice upload proxy error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
