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
        { role: "executive", sessions: sessions.filter((session) => session.metadata.role === "executive") },
        { role: "architect", sessions: sessions.filter((session) => session.metadata.role === "architect") },
        { role: "orchestrator", sessions: sessions.filter((session) => session.metadata.role === "orchestrator") },
        { role: "worker", sessions: sessions.filter((session) => session.metadata.role === "worker") },
        { role: "observer", sessions: sessions.filter((session) => session.metadata.role === "observer") },
      ],
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sessions";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    // Keep Agent HQ usable even when tmux/data paths are temporarily unavailable.
    console.error("[agent-hq/sessions] fallback to empty list:", message);
    return NextResponse.json({
      sessions: [],
      templates: [],
      grouped: [
        { role: "executive", sessions: [] },
        { role: "architect", sessions: [] },
        { role: "orchestrator", sessions: [] },
        { role: "worker", sessions: [] },
        { role: "observer", sessions: [] },
      ],
      warning: message,
      lastUpdatedAt: new Date().toISOString(),
    });
  }
}
