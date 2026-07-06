import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  discoverAgentProjects,
  type AgentWorkspace,
} from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, no-store, max-age=0, must-revalidate";
const DEPLOY_STATE_DIR = ".rivr-deploy";
const REQUEST_FILE = "request.json";
const RESULT_FILE = "result.json";

type DeployRequest = {
  version: 1;
  requestId: string;
  workspaceId: string;
  requestedAt: string;
  sourceDigest: string;
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

async function resolveDeployableWorkspace(workspaceId: string): Promise<AgentWorkspace | null> {
  const workspaces = await discoverAgentProjects();
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  if (!workspace || workspace.scope !== "app" || !workspace.deployRoot) return null;
  return workspace;
}

function statePath(workspace: AgentWorkspace, file: string) {
  return path.join(workspace.cwd, DEPLOY_STATE_DIR, file);
}

async function sourceDigest(workspace: AgentWorkspace): Promise<string> {
  const hash = createHash("sha256");
  hash.update(workspace.id);
  hash.update("\0");
  hash.update(workspace.cwd);
  hash.update("\0");
  hash.update(new Date().toISOString());
  return hash.digest("hex");
}

export async function POST(request: Request) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Access denied" }, 403);
  }

  let workspaceId = "";
  try {
    const body = (await request.json()) as { workspaceId?: unknown };
    workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  } catch {
    return response({ error: "Invalid JSON body" }, 400);
  }

  const workspace = await resolveDeployableWorkspace(workspaceId);
  if (!workspace) return response({ error: "Deployable app workspace not found" }, 404);

  const stateDir = path.join(workspace.cwd, DEPLOY_STATE_DIR);
  await mkdir(stateDir, { recursive: true });

  const deployRequest: DeployRequest = {
    version: 1,
    requestId: randomUUID(),
    workspaceId: workspace.id,
    requestedAt: new Date().toISOString(),
    sourceDigest: await sourceDigest(workspace),
  };

  const tempPath = path.join(stateDir, `request.${deployRequest.requestId}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(deployRequest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, statePath(workspace, REQUEST_FILE));

  return response({ success: true, queued: true, request: deployRequest }, 202);
}

export async function GET(request: Request) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Access denied" }, 403);
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const workspace = await resolveDeployableWorkspace(workspaceId);
  if (!workspace) return response({ error: "Deployable app workspace not found" }, 404);

  try {
    const raw = await readFile(statePath(workspace, RESULT_FILE), "utf8");
    return response({ success: true, result: JSON.parse(raw) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return response({ success: true, result: null });
    }
    return response({ error: "Failed to read deployment result" }, 500);
  }
}
