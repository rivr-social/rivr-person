import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  queueWorkspaceDeployment,
  readWorkspaceDeploymentResult,
  resolveBuilderWorkspace,
} from "@/lib/builder/workspace-site";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, no-store, max-age=0, must-revalidate";
function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL },
  });
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

  const workspace = await resolveBuilderWorkspace(workspaceId, true);
  if (!workspace) return response({ error: "Deployable app workspace not found" }, 404);

  const deployRequest = await queueWorkspaceDeployment(workspace);

  return response({ success: true, queued: true, request: deployRequest }, 202);
}

export async function GET(request: Request) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Access denied" }, 403);
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const workspace = await resolveBuilderWorkspace(workspaceId, true);
  if (!workspace) return response({ error: "Deployable app workspace not found" }, 404);

  try {
    return response({ success: true, result: await readWorkspaceDeploymentResult(workspace) });
  } catch {
    return response({ error: "Failed to read deployment result" }, 500);
  }
}
