/**
 * GET  /api/personas/[id]/kg/graph — List entities in the persona's KG scope
 * POST /api/personas/[id]/kg/graph — Query the persona's KG subgraph
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";

const SCOPE_TYPE_PERSONA = "persona";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: personaId } = await context.params;

  const owned = await isPersonaOf(personaId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
  }

  try {
    const entities = await kg.listEntities(SCOPE_TYPE_PERSONA, personaId);
    return NextResponse.json({ entities, count: entities.length, scope: { type: SCOPE_TYPE_PERSONA, id: personaId } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list persona entities" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: personaId } = await context.params;

  const owned = await isPersonaOf(personaId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
  }

  const body = await req.json();
  const { entity, predicate, max_results } = body;

  try {
    const result = await kg.queryScope(SCOPE_TYPE_PERSONA, personaId, {
      entity,
      predicate,
      max_results,
    });
    return NextResponse.json({ ...result, scope: { type: SCOPE_TYPE_PERSONA, id: personaId } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Persona graph query failed" },
      { status: 500 },
    );
  }
}
