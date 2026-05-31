/**
 * POST /api/personas/[id]/kg/chat — Chat with a persona's KG context
 *
 * Fetches KG context scoped to the persona, injects it as a system prompt, and
 * answers natively via the configured cloud provider (OpenClaw retired).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";
import {
  nativeCloudChat,
  DEFAULT_MODEL,
  type HistoryMessage,
} from "@/lib/ai/native-chat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCOPE_TYPE_PERSONA = "persona";
const DEFAULT_MAX_CONTEXT_CHARS = 3000;

type RouteContext = { params: Promise<{ id: string }> };

function sanitizeHistory(history: unknown): HistoryMessage[] {
  if (!Array.isArray(history)) return [];
  const out: HistoryMessage[] = [];
  for (const msg of history) {
    if (
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string"
    ) {
      out.push({ role: msg.role, content: msg.content });
    }
  }
  return out;
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
      session.user.id,
    );

    const kgSystemPrompt = kgContext
      ? `You have access to a knowledge graph for this persona. Use these facts to inform your answers:\n\n${kgContext}\n\n`
      : "";

    const result = await nativeCloudChat({
      selectedModel: DEFAULT_MODEL,
      systemPrompt: kgSystemPrompt || null,
      history: sanitizeHistory(history),
      message,
    });

    return NextResponse.json({
      reply: result.reply,
      model: result.model,
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
