import { NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  launchAgentSession,
  type AgentCapability,
  type AgentLauncherProvider,
  type AgentRole,
} from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

type LaunchBody = {
  provider?: AgentLauncherProvider;
  cwd?: string;
  displayLabel?: string;
  workspaceId?: string;
  commandTemplate?: string;
  role?: AgentRole;
  parent?: string | null;
  notes?: string;
  objective?: string;
  sessionName?: string;
  capabilityIds?: AgentCapability[];
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
};

export async function POST(request: Request) {
  let body: LaunchBody;
  try {
    body = (await request.json()) as LaunchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  if (!body.cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  if (!body.displayLabel) {
    return NextResponse.json({ error: "displayLabel is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const result = await launchAgentSession({
      provider: body.provider,
      cwd: body.cwd,
      displayLabel: body.displayLabel,
      workspaceId: body.workspaceId,
      commandTemplate: body.commandTemplate,
      role: body.role,
      parent: body.parent ?? null,
      notes: body.notes,
      objective: body.objective,
      sessionName: body.sessionName,
      capabilityIds: body.capabilityIds,
      personaId: body.personaId ?? null,
      personaName: body.personaName,
      kgScopeSet: body.kgScopeSet,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to launch session";
    const status = message === "Authentication required" ? 401 : 500;
    console.error("[agent-hq/launch] failed:", message);
    return NextResponse.json({ error: message }, { status });
  }
}
