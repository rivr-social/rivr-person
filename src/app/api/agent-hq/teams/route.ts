import { NextResponse } from "next/server";
import { assertAgentHqAccess, loadTeamGraph, saveTeamGraph } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await assertAgentHqAccess();
    const graph = await loadTeamGraph();
    return NextResponse.json(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load team graph";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    await assertAgentHqAccess();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const graph = await saveTeamGraph(body as Parameters<typeof saveTeamGraph>[0]);
    return NextResponse.json(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save team graph";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
