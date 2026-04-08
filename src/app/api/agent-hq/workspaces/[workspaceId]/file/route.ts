import { NextResponse } from "next/server";
import { assertAgentHqAccess, readWorkspaceFile, writeWorkspaceFile } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    await assertAgentHqAccess();
    const { workspaceId } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const result = await readWorkspaceFile(workspaceId, path);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read file";
    const status =
      message === "Authentication required"
        ? 401
        : message === "Workspace not found."
          ? 404
          : message === "File path is required."
            ? 400
            : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    await assertAgentHqAccess();
    const { workspaceId } = await context.params;
    const body = (await request.json().catch(() => null)) as { path?: string; content?: string } | null;
    const filePath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!filePath) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const content = typeof body?.content === "string" ? body.content : "";
    const result = await writeWorkspaceFile(workspaceId, filePath, content);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to write file";
    const status =
      message === "Authentication required"
        ? 401
        : message === "Workspace not found."
          ? 404
          : message === "File path is required."
            ? 400
            : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
