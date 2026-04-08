import { NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  loadSessionTemplates,
  upsertSessionTemplate,
  type AgentSessionTemplate,
} from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

type TemplateBody = {
  id?: string;
  name?: string;
  mode?: AgentSessionTemplate["mode"];
  preset?: AgentSessionTemplate["preset"];
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
};

export async function GET() {
  try {
    await assertAgentHqAccess();
    const templates = await loadSessionTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list templates";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  let body: TemplateBody;
  try {
    body = (await request.json()) as TemplateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!body.mode || (body.mode !== "architect" && body.mode !== "team")) {
    return NextResponse.json({ error: "mode is required" }, { status: 400 });
  }
  if (!body.preset || (body.preset !== "default" && body.preset !== "guide_builder")) {
    return NextResponse.json({ error: "preset is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const id =
      body.id?.trim() ||
      `tmpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const templates = await upsertSessionTemplate({
      id,
      name,
      mode: body.mode,
      preset: body.preset,
      personaId: body.personaId ?? null,
      personaName: body.personaName?.trim() || undefined,
      kgScopeSet: Array.isArray(body.kgScopeSet)
        ? Array.from(
            new Set(
              body.kgScopeSet.filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              ),
            ),
          )
        : [],
    });
    return NextResponse.json({ ok: true, templates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save template";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
