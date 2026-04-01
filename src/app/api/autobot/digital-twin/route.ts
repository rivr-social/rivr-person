import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type DigitalTwinProfile,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  return NextResponse.json({ digitalTwin: settings.digitalTwin });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<DigitalTwinProfile>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const existing = await getAutobotUserSettings(session.user.id);
  const next = {
    ...existing.digitalTwin,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  const settings = await saveAutobotUserSettings(session.user.id, { digitalTwin: next });
  return NextResponse.json({ digitalTwin: settings.digitalTwin });
}
