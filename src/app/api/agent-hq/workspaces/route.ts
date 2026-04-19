import { NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  discoverAgentProjects,
  getAgentAppWorkspaceRoot,
  loadTeamGraph,
  saveWorkspaceRegistry,
  upsertWorkspace,
  type AgentWorkspace,
} from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_BAD_REQUEST = 400;
const STATUS_INTERNAL = 500;

// ---------------------------------------------------------------------------
// GET /api/agent-hq/workspaces
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    await assertAgentHqAccess();
    const [workspaces, team] = await Promise.all([discoverAgentProjects(), loadTeamGraph()]);
    const registry = await saveWorkspaceRegistry(workspaces);
    return NextResponse.json({
      registry,
      workspaces,
      team,
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list workspaces";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

// ---------------------------------------------------------------------------
// POST /api/agent-hq/workspaces
//
// Creates a new app workspace directory and registers it.
// Body: { name: string, subdomain?: string }
// ---------------------------------------------------------------------------

interface CreateWorkspaceBody {
  name: string;
  subdomain?: string;
}

export async function POST(request: Request) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Access denied";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }

  let body: CreateWorkspaceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Sanitize name for directory usage
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!safeName) {
    return NextResponse.json(
      { error: "name produces an invalid directory name after sanitization" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    const { mkdir, existsSync } = await import("fs");
    const { resolve } = await import("path");

    const appRoot = getAgentAppWorkspaceRoot();

    const newDir = resolve(appRoot, safeName);

    if (existsSync(newDir)) {
      return NextResponse.json(
        { error: `Directory already exists: ${safeName}` },
        { status: STATUS_BAD_REQUEST },
      );
    }

    // Create the directory
    await new Promise<void>((resolveP, reject) => {
      mkdir(newDir, { recursive: true }, (err) => {
        if (err) reject(err);
        else resolveP();
      });
    });

    const workspace: AgentWorkspace = {
      id: `app-${safeName}`,
      name: safeName,
      label: name,
      cwd: newDir,
      scope: "app",
      description: `App workspace created from Builder: ${name}`,
      liveSubdomain: body.subdomain?.trim() || null,
      foundationId: "foundation-pm-core",
    };

    const registry = await upsertWorkspace(workspace);

    return NextResponse.json({
      success: true,
      workspace,
      registry,
    });
  } catch (error) {
    console.error("[api/agent-hq/workspaces] Create failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create workspace" },
      { status: STATUS_INTERNAL },
    );
  }
}
