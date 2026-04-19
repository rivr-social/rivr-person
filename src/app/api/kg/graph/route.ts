/**
 * POST /api/kg/graph — Query scoped KG subgraph
 * GET  /api/kg/graph — List entities in scope
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { scope_type, scope_id, entity, predicate, max_results, personaId } = body;

  let scopeType = scope_type || "person";
  let scopeId = scope_id || session.user.id;

  // When personaId is provided, verify ownership and scope to the persona
  if (personaId) {
    const owned = await isPersonaOf(personaId, session.user.id);
    if (!owned) {
      return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
    }
    scopeType = "persona";
    scopeId = personaId;
  }

  try {
    const result = await kg.queryScope(scopeType, scopeId, {
      entity,
      predicate,
      max_results,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const personaId = url.searchParams.get("personaId");

  let scopeType = url.searchParams.get("scope_type") || "person";
  let scopeId = url.searchParams.get("scope_id") || session.user.id;

  // When personaId is provided, verify ownership and scope to the persona
  if (personaId) {
    const owned = await isPersonaOf(personaId, session.user.id);
    if (!owned) {
      return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
    }
    scopeType = "persona";
    scopeId = personaId;
  }

  try {
    const entities = await kg.listEntities(scopeType, scopeId);
    return NextResponse.json(entities);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list entities" },
      { status: 500 },
    );
  }
}
