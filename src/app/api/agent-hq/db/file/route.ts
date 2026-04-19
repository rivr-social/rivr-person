import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { readDbFile, writeDbFile } from "@/lib/agent-hq-db-explorer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await assertAgentHqAccess();
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const result = await readDbFile(path);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read virtual file";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    await assertAgentHqAccess();
    const body = (await request.json().catch(() => null)) as { path?: string; content?: string } | null;
    const filePath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!filePath) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const content = typeof body?.content === "string" ? body.content : "";
    const result = await writeDbFile(filePath, content);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to write virtual file";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
