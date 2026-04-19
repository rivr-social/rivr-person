import { NextResponse } from "next/server";
import { assertAgentHqAccess, listWorkspaceEntries } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    await assertAgentHqAccess();
    const { workspaceId } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    const result = await listWorkspaceEntries(workspaceId, path);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list workspace entries";
    const status = message === "Authentication required" ? 401 : message === "Workspace not found." ? 404 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
