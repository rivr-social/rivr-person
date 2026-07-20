/**
 * Live-avatar session lifecycle.
 *
 * POST   /api/autobot/live-avatar/session  { personaId? }
 *   Resolves the target's profile avatar (persona image when a validated
 *   persona is passed, else the caller's own agents.image), downloads it
 *   server-side, and opens a worker session. Returns the stream path the
 *   browser can point an <img> at.
 *
 * DELETE /api/autobot/live-avatar/session  { sessionId }
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { isPersonaOf } from "@/lib/persona";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  createAvatarSession,
  deleteAvatarSession,
  isLiveAvatarConfigured,
  LiveAvatarWorkerError,
} from "@/lib/live-avatar-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

type SessionRequestBody = { personaId?: string };
type DeleteRequestBody = { sessionId?: string };

function workerErrorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof LiveAvatarWorkerError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const detail = error instanceof Error ? error.message : fallbackMessage;
  return NextResponse.json({ error: detail }, { status: 502 });
}

/** Decode a data: URL or fetch an http(s)/relative avatar URL server-side. */
async function loadAvatarImage(
  imageRef: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | { error: string }> {
  if (imageRef.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(imageRef);
    if (!match) return { error: "Unsupported avatar data URL format." };
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
      return { error: "Avatar image is empty or too large." };
    }
    return {
      bytes: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
      mimeType: match[1] || "image/jpeg",
    };
  }

  const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
  const absoluteUrl = /^https?:\/\//.test(imageRef)
    ? imageRef
    : `${baseUrl}${imageRef.startsWith("/") ? "" : "/"}${imageRef}`;

  try {
    const response = await fetch(absoluteUrl, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { error: `Could not load avatar image (${response.status}).` };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: "Avatar image is empty or too large." };
    }
    return {
      bytes,
      mimeType: response.headers.get("content-type") || "image/jpeg",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Could not load avatar image: ${error.message}`
          : "Could not load avatar image.",
    };
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isLiveAvatarConfigured()) {
    return NextResponse.json(
      { error: "Live avatar is not configured on this instance." },
      { status: 503 },
    );
  }

  let body: SessionRequestBody;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // Persona images require ownership; default is the caller's own avatar.
  let targetAgentId = session.user.id;
  if (body.personaId && typeof body.personaId === "string") {
    const owned = await isPersonaOf(body.personaId, session.user.id).catch(
      () => false,
    );
    if (!owned) {
      return NextResponse.json(
        { error: "Persona not found or not owned by you." },
        { status: 403 },
      );
    }
    targetAgentId = body.personaId;
  }

  const [agentRow] = await db
    .select({ image: agents.image, name: agents.name })
    .from(agents)
    .where(eq(agents.id, targetAgentId))
    .limit(1);

  if (!agentRow?.image) {
    return NextResponse.json(
      {
        error:
          "No profile picture set. Add a profile photo first — the live avatar animates it.",
      },
      { status: 400 },
    );
  }

  const loaded = await loadAvatarImage(agentRow.image);
  if ("error" in loaded) {
    return NextResponse.json({ error: loaded.error }, { status: 422 });
  }

  try {
    const info = await createAvatarSession(
      loaded.bytes,
      "avatar.jpg",
      loaded.mimeType,
    );
    return NextResponse.json({
      ...info,
      streamPath: `/api/autobot/live-avatar/stream/${info.sessionId}`,
    });
  } catch (error) {
    console.error("Live avatar session create failed:", error);
    return workerErrorResponse(error, "Failed to create live avatar session");
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: DeleteRequestBody;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!body.sessionId || typeof body.sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    await deleteAvatarSession(body.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // A vanished session is fine — the worker reaps idle sessions itself.
    if (error instanceof LiveAvatarWorkerError && /404/.test(error.message)) {
      return NextResponse.json({ ok: true });
    }
    return workerErrorResponse(error, "Failed to end live avatar session");
  }
}
