import { NextResponse } from "next/server";
import { assertAgentHqAccess, reloadAgentContext } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { paneKey?: string };
  try {
    body = (await request.json()) as { paneKey?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.paneKey) {
    return NextResponse.json({ error: "paneKey is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    await reloadAgentContext(body.paneKey);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reload context";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
