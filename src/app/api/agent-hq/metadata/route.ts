import { NextResponse } from "next/server";
import { assertAgentHqAccess, updateAgentMetadata, type AgentRole } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

type MetadataBody = {
  paneKey?: string;
  role?: AgentRole;
  parent?: string | null;
  label?: string;
  notes?: string;
  objective?: string;
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
  mountedPaths?: string[];
};

export async function POST(request: Request) {
  let body: MetadataBody;
  try {
    body = (await request.json()) as MetadataBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.paneKey) {
    return NextResponse.json({ error: "paneKey is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const metadata = await updateAgentMetadata(body.paneKey, {
      role: body.role,
      parent: body.parent ?? null,
      label: body.label,
      notes: body.notes,
      objective: body.objective,
      personaId: body.personaId ?? null,
      personaName: body.personaName,
      kgScopeSet: body.kgScopeSet,
      mountedPaths: body.mountedPaths,
    });
    return NextResponse.json({ ok: true, metadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update metadata";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
