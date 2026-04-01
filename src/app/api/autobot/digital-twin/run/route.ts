import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    jobId?: string;
    mode?: string;
    sourceText?: string;
    audioUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const digitalTwin = settings.digitalTwin;
  const hostVideo = digitalTwin.assets.find((asset) => asset.kind === "host-video");
  const referencePortrait = digitalTwin.assets.find((asset) => asset.kind === "reference-portrait");

  if (!hostVideo && !referencePortrait) {
    return NextResponse.json(
      { error: "Upload a host video or reference portrait before running a digital twin job." },
      { status: 400 },
    );
  }

  const response = await fetch(`${OPENCLAW_URL}/api/digital-twin/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pipeline: digitalTwin.pipeline,
      model: digitalTwin.model,
      script: body.sourceText || "",
      audio_url: body.audioUrl || undefined,
      host_video_url: hostVideo?.url || undefined,
      reference_image_url: referencePortrait?.url || undefined,
      host_framing: digitalTwin.hostFraming,
      background_mode: digitalTwin.backgroundMode,
      mode: body.mode || undefined,
      jobId: body.jobId || undefined,
    }),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { detail: text };
  }

  return NextResponse.json(parsed, { status: response.status });
}
