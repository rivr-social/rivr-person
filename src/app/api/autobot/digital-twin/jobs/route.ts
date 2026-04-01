import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type DigitalTwinJob,
  type DigitalTwinJobMode,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

function generateId() {
  return `dtjob_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const VALID_MODES: DigitalTwinJobMode[] = [
  "host-update",
  "event-recap",
  "marketplace-promo",
];

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await getAutobotUserSettings(session.user.id);
  return NextResponse.json({ jobs: settings.digitalTwin.jobs });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    mode?: DigitalTwinJobMode;
    sourceType?: "script" | "transcript";
    sourceText?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.mode || !VALID_MODES.includes(body.mode)) {
    return NextResponse.json({ error: `mode must be one of: ${VALID_MODES.join(", ")}` }, { status: 400 });
  }
  if (body.sourceType !== "script" && body.sourceType !== "transcript") {
    return NextResponse.json({ error: "sourceType must be script or transcript" }, { status: 400 });
  }
  const sourceText = typeof body.sourceText === "string" ? body.sourceText.trim() : "";
  if (!sourceText) {
    return NextResponse.json({ error: "sourceText is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const job: DigitalTwinJob = {
    id: generateId(),
    mode: body.mode,
    sourceType: body.sourceType,
    sourceText,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };

  const existing = await getAutobotUserSettings(session.user.id);
  const jobs = [job, ...existing.digitalTwin.jobs].slice(0, 50);
  const settings = await saveAutobotUserSettings(session.user.id, {
    digitalTwin: {
      ...existing.digitalTwin,
      jobs,
      updatedAt: now,
    },
  });

  return NextResponse.json({ job, jobs: settings.digitalTwin.jobs });
}
