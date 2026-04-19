/**
 * GET /api/personas/[id]/kg/stats — Get KG stats for a persona scope
 *
 * Returns doc count, entity count, and triple count for the persona's
 * knowledge graph scope. Used by the autobot control pane.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getScopeStats } from "@/lib/kg/autobot-kg-client";
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
    const stats = await getScopeStats(SCOPE_TYPE_PERSONA, personaId);
    return NextResponse.json({
      ...stats,
      scope: { type: SCOPE_TYPE_PERSONA, id: personaId },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch persona KG stats" },
      { status: 500 },
    );
  }
}
