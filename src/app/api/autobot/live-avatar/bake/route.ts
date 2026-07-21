/**
 * POST /api/autobot/live-avatar/bake
 *
 * One-time viseme-pack bake: asks the user's Chatterbox GPU worker to run
 * LivePortrait over their avatar picture, classifies the output into
 * mouth-shape frames, stores the frames in this instance's MinIO, and
 * saves the pack in settings. After this, live-avatar sessions animate by
 * photoreal frame swap ("really looks like talking") with zero runtime GPU.
 *
 * Requires the GPU to be RUNNING (409 with needGpu:true otherwise — the
 * overlay offers to start it).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type VisemePack,
} from "@/lib/autobot-user-settings";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { uploadDigitalTwinAsset, StorageError } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BAKE_TIMEOUT_MS = 280_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function resolveAbsoluteImageUrl(imageRef: string): string | null {
  if (/^https?:\/\//.test(imageRef)) return imageRef;
  if (imageRef.startsWith("data:")) return null; // box cannot fetch data URLs
  const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
  return `${baseUrl}${imageRef.startsWith("/") ? "" : "/"}${imageRef}`;
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const gpu = settings.chatterboxGpu;
  if (!gpu?.url) {
    return NextResponse.json(
      {
        error:
          "The voice GPU isn't running. Start it (and make sure your Vast balance is funded), then bake again.",
        needGpu: true,
      },
      { status: 409 },
    );
  }

  // Same picture-resolution order as the live session: uploaded reference
  // portrait first, then the profile photo.
  const referencePortrait = settings.digitalTwin.assets.find(
    (asset) =>
      asset.kind === "reference-portrait" && asset.mimeType.startsWith("image/"),
  );
  let imageRef = referencePortrait?.url ?? null;
  if (!imageRef) {
    const [agentRow] = await db
      .select({ image: agents.image })
      .from(agents)
      .where(eq(agents.id, session.user.id))
      .limit(1);
    imageRef = agentRow?.image ?? null;
  }
  if (!imageRef) {
    return NextResponse.json(
      { error: "No picture to bake. Set a profile photo first." },
      { status: 400 },
    );
  }
  const imageUrl = resolveAbsoluteImageUrl(imageRef);
  if (!imageUrl) {
    return NextResponse.json(
      {
        error:
          "This picture is stored inline (data URL) — upload it as a live avatar picture first.",
      },
      { status: 422 },
    );
  }

  // Ask the GPU worker for the pack (LivePortrait pass + frame classify).
  let bake: { frames?: Record<string, string> };
  try {
    const response = await fetch(`${gpu.url}/viseme-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gpu.authToken}`,
      },
      body: JSON.stringify({ image_url: imageUrl }),
      signal: AbortSignal.timeout(BAKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return NextResponse.json(
        { error: `Bake failed on the GPU worker: ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }
    bake = (await response.json()) as { frames?: Record<string, string> };
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Could not reach the GPU worker: ${error.message}`
            : "Could not reach the GPU worker",
      },
      { status: 502 },
    );
  }

  const frames = bake.frames ?? {};
  const labels = Object.keys(frames);
  if (labels.length < 2) {
    return NextResponse.json(
      { error: "The bake produced too few usable mouth shapes." },
      { status: 422 },
    );
  }

  // Persist each frame into our own storage; the pack must outlive the box.
  const storedFrames: Record<string, string> = {};
  try {
    for (const label of labels) {
      const buffer = Buffer.from(frames[label], "base64");
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FRAME_BYTES) continue;
      const uploaded = await uploadDigitalTwinAsset(
        buffer,
        `viseme-${label}.png`,
        "image/png",
        session.user.id,
      );
      storedFrames[label] = uploaded.url;
    }
  } catch (error) {
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
  if (Object.keys(storedFrames).length < 2) {
    return NextResponse.json(
      { error: "Storing the baked frames failed." },
      { status: 500 },
    );
  }

  const visemePack: VisemePack = {
    frames: storedFrames,
    generatedAt: new Date().toISOString(),
    sourceImage: imageRef,
  };
  await saveAutobotUserSettings(session.user.id, { visemePack });

  // Stamp GPU usage so the idle reaper knows the box just worked.
  saveAutobotUserSettings(session.user.id, {
    chatterboxGpu: { ...gpu, lastUsedAt: new Date().toISOString() },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    bins: Object.keys(storedFrames),
    generatedAt: visemePack.generatedAt,
  });
}
