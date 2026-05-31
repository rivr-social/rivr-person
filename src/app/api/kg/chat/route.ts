/**
 * POST /api/kg/chat — Chat with scoped KG context
 *
 * Fetches KG context for the given scope, injects it as a system prompt, and
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

const DEFAULT_MAX_CONTEXT_CHARS = 3000;

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

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { message, scope_type, scope_id, history, max_context_chars, personaId } = body;

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

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
    // Fetch KG context for this scope
    const { context } = await kg.buildContext(
      scopeType,
      scopeId,
      max_context_chars || DEFAULT_MAX_CONTEXT_CHARS,
      session.user.id,
    );

    // Build the system prompt with KG facts
    const kgSystemPrompt = context
      ? `You have access to a knowledge graph for this ${scopeType}. Use these facts to inform your answers:\n\n${context}\n\n`
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
      kg_context_length: context.length,
      scope: { type: scopeType, id: scopeId },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "KG chat failed" },
      { status: 500 },
    );
  }
}
