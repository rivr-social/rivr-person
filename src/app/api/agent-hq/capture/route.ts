import { NextResponse } from "next/server";
import { assertAgentHqAccess, captureAgentPane, captureAgentPaneRaw } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  const lines = Number(url.searchParams.get("lines") || 120);
  const raw = url.searchParams.get("raw") === "1";

  if (!target) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const output = raw
      ? await captureAgentPaneRaw(target, lines)
      : await captureAgentPane(target, lines);
    return NextResponse.json({ target, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to capture pane";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    const normalized = message.toLowerCase();
    // Common transient tmux states should not surface as hard API failures.
    if (
      normalized.includes("can't find pane") ||
      normalized.includes("can't find session") ||
      normalized.includes("no server running on") ||
      normalized.includes("failed to connect to server") ||
      normalized.includes("error connecting to") ||
      normalized.includes("no such file or directory")
    ) {
      return NextResponse.json({ target, output: "", warning: message });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
