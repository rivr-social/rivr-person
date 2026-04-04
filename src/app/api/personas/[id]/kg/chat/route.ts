/**
 * POST /api/personas/[id]/kg/chat — Chat with a persona's KG context
 *
 * Fetches KG context scoped to the persona, prepends it to the message,
 * and proxies to OpenClaw for response.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const SCOPE_TYPE_PERSONA = "persona";
const DEFAULT_MAX_CONTEXT_CHARS = 3000;

type RouteContext = { params: Promise<{ id: string }> };

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
  const { message, history, max_context_chars } = body;

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  try {
    // Fetch KG context scoped to this persona
    const { context: kgContext } = await kg.buildContext(
      SCOPE_TYPE_PERSONA,
      personaId,
      max_context_chars || DEFAULT_MAX_CONTEXT_CHARS,
    );

    const kgSystemPrompt = kgContext
      ? `You have access to a knowledge graph for this persona. Use these facts to inform your answers:\n\n${kgContext}\n\n`
      : "";

    // Proxy to OpenClaw with persona KG context
    const openclawRes = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: session.user.name || "user",
        message: `${kgSystemPrompt}User question: ${message}`,
        history: history || [],
        channel: `kg-chat:${SCOPE_TYPE_PERSONA}:${personaId}`,
      }),
    });

    if (!openclawRes.ok) {
      const errText = await openclawRes.text();
      return NextResponse.json(
        { error: `OpenClaw error: ${openclawRes.status}`, detail: errText },
        { status: openclawRes.status },
      );
    }

    const data = await openclawRes.json();
    return NextResponse.json({
      ...data,
      kg_context_length: kgContext.length,
      scope: { type: SCOPE_TYPE_PERSONA, id: personaId },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Persona KG chat failed" },
      { status: 500 },
    );
  }
}
