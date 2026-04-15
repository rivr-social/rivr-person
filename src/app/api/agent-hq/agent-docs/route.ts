import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDeployCapability } from "@/lib/deploy/capability";
import {
  ensureAgentDocsFolder,
  listAgentFolder,
  readAgentFile,
  writeAgentFile,
} from "@/lib/agent-docs";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertAccess(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Authentication required");
  }
  const capability = getDeployCapability();
  if (!capability.canAccessHost) {
    throw new Error("Agent docs are only available on sovereign instances.");
  }
  return userId;
}

// ---------------------------------------------------------------------------
// GET — read a file or list an agent's docs folder
//
// ?agentId={id}                → list files in agent's root folder
// ?agentId={id}&path={rel}     → read a specific file
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  try {
    await assertAccess();
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    const filePath = url.searchParams.get("path");

    if (!agentId) {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }

    if (filePath) {
      // Read a specific file
      const content = await readAgentFile(agentId, filePath);
      return NextResponse.json({ agentId, path: filePath, content });
    }

    // List files in the agent's folder
    await ensureAgentDocsFolder(agentId);
    const entries = await listAgentFolder(agentId);
    return NextResponse.json({ agentId, entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read agent docs";
    const status = message === "Authentication required" ? 401
      : message.includes("traversal") ? 400
      : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

// ---------------------------------------------------------------------------
// POST — write a file to an agent's docs folder
//
// Body: { agentId: string, path: string, content: string }
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  try {
    await assertAccess();
    const body = (await request.json().catch(() => null)) as {
      agentId?: string;
      path?: string;
      content?: string;
    } | null;

    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const filePath = typeof body?.path === "string" ? body.path.trim() : "";
    const content = typeof body?.content === "string" ? body.content : "";

    if (!agentId) {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }
    if (!filePath) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const size = await writeAgentFile(agentId, filePath, content);
    return NextResponse.json({ agentId, path: filePath, size });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to write agent docs";
    const status = message === "Authentication required" ? 401
      : message.includes("traversal") ? 400
      : message.includes("too large") ? 413
      : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
