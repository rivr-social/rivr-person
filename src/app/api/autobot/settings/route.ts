import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type AutobotUserSettings,
} from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subject = await resolveAutobotConnectionScope(session.user.id);
  const settings = await getAutobotUserSettings(subject.actorId);
  return NextResponse.json({ settings, subject });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subject = await resolveAutobotConnectionScope(session.user.id);

  let body: Partial<AutobotUserSettings>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await saveAutobotUserSettings(subject.actorId, body);
  return NextResponse.json({ settings, subject });
}
