/**
 * POST /api/autobot/live-avatar/calibration
 *   { mouth: [x,y], leftEye: [x,y], rightEye: [x,y] }  (normalized 0..1)
 *
 * Saves tap-to-calibrate placement for portraits that defeat face
 * detection — the warp engine then animates the human-tapped mouth/eyes
 * instead of a blind fallback layout. DELETE clears it.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  saveAutobotUserSettings,
  type LiveAvatarCalibration,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

function parsePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [x, y];
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mouth = parsePoint(body.mouth);
  const leftEye = parsePoint(body.leftEye);
  const rightEye = parsePoint(body.rightEye);
  if (!mouth || !leftEye || !rightEye) {
    return NextResponse.json(
      { error: "mouth, leftEye, and rightEye must be normalized [x, y] points" },
      { status: 400 },
    );
  }

  const calibration: LiveAvatarCalibration = { mouth, leftEye, rightEye };
  await saveAutobotUserSettings(session.user.id, {
    liveAvatarCalibration: calibration,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await saveAutobotUserSettings(session.user.id, { liveAvatarCalibration: null });
  return NextResponse.json({ ok: true });
}
