import { NextResponse } from "next/server";
import { assertAgentHqAccess, listAgentSessions, saveSessionRegistry } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await assertAgentHqAccess();
    const sessions = await listAgentSessions();
    const registry = await saveSessionRegistry(sessions);
    return NextResponse.json({
      sessions,
      templates: registry.templates ?? [],
      grouped: [
        { role: "architect", sessions: sessions.filter((session) => session.metadata.role === "architect") },
        { role: "orchestrator", sessions: sessions.filter((session) => session.metadata.role === "orchestrator") },
        { role: "worker", sessions: sessions.filter((session) => session.metadata.role === "worker") },
        { role: "observer", sessions: sessions.filter((session) => session.metadata.role === "observer") },
      ],
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sessions";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
