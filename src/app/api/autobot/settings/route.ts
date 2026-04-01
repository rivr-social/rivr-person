import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type AutobotUserSettings,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  return NextResponse.json({ settings });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<AutobotUserSettings>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await saveAutobotUserSettings(session.user.id, body);
  return NextResponse.json({ settings });
}
