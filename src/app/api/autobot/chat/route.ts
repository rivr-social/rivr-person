/**
 * POST /api/autobot/chat
 *
 * Proxies chat requests to the OpenClaw token server at ai.camalot.me/api/chat.
 * Requires Rivr session auth. Forwards { username, message, history } with the
 * authenticated user context. Supports model selection via x-openclaw-model header.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildAutobotSystemPrompt, buildAutobotSystemPromptWithPersonaKg } from "@/lib/bespoke/autobot-system-prompt";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const MAX_HISTORY_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 8000;
const OLLAMA_TIMEOUT_MS = 90_000;

const ALLOWED_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4-6",
  "local/ollama",
  "local/llama3.2",
  "local/mistral",
  "local/codellama",
] as const;

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  message: string;
  history?: HistoryMessage[];
  model?: string;
  threadId?: string;
  personaId?: string;
  personaName?: string;
}

// ---------------------------------------------------------------------------
// Local model helpers
// ---------------------------------------------------------------------------

function isLocalModel(model: string): boolean {
  return model.startsWith("local/");
}

/**
 * Resolve the Ollama model name from the Rivr model selector value.
 * "local/ollama" uses the OLLAMA_MODEL env default; "local/llama3.2" uses "llama3.2".
 */
function resolveOllamaModelName(model: string): string {
  if (model === "local/ollama") return OLLAMA_MODEL;
  return model.slice(6) || OLLAMA_MODEL; // strip "local/" prefix
}

interface OllamaChatPayload {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  options?: Record<string, unknown>;
}

interface OllamaChatResult {
  reply: string;
  model: string;
  evalTokens: number | null;
  totalDurationMs: number | null;
}

async function chatViaOllama(
  ollamaModel: string,
  systemPrompt: string | null,
  history: HistoryMessage[],
  message: string,
): Promise<OllamaChatResult> {
  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: message });

  const payload: OllamaChatPayload = {
    model: ollamaModel,
    messages,
    stream: false,
    options: { num_ctx: 4096 },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Ollama returned ${res.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      reply: data.message?.content || "...",
      model: `local/${data.model || ollamaModel}`,
      evalTokens: data.eval_count || null,
      totalDurationMs: data.total_duration
        ? Math.round(data.total_duration / 1_000_000)
        : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeSessionSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, history, model, threadId, personaId, personaName } = body;

  if (!message || typeof message !== "string") {
    return NextResponse.json(
      { error: "message is required and must be a string" },
      { status: 400 },
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `message exceeds maximum length of ${MAX_MESSAGE_LENGTH}` },
      { status: 400 },
    );
  }

  // Validate and sanitize history
  const sanitizedHistory: HistoryMessage[] = [];
  if (Array.isArray(history)) {
    for (const msg of history.slice(-MAX_HISTORY_LENGTH)) {
      if (
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string"
      ) {
        sanitizedHistory.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // Resolve model — default if not provided or not in allowed list
  const selectedModel =
    model && ALLOWED_MODELS.includes(model as (typeof ALLOWED_MODELS)[number])
      ? model
      : DEFAULT_MODEL;

  const username = session.user.name || session.user.email || "rivr-user";
  const sessionKey = [
    "agent:main:rivr",
    sanitizeSessionSegment(session.user.id),
    sanitizeSessionSegment(threadId || username),
  ].join(":");

  // Build system prompt — inject persona KG context when a personaId is provided
  let systemPrompt: string | null = null;
  if (personaId && typeof personaId === "string") {
    // Verify persona ownership before injecting its KG context
    const owned = await isPersonaOf(personaId, session.user.id).catch(() => false);
    if (owned) {
      systemPrompt = await buildAutobotSystemPromptWithPersonaKg(
        session.user.id,
        personaId,
        personaName || "persona",
      ).catch((error) => {
        console.error("Failed to build persona-scoped system prompt:", error);
        return null;
      });
    }
  }
  if (!systemPrompt) {
    systemPrompt = await buildAutobotSystemPrompt(session.user.id).catch((error) => {
      console.error("Failed to build autobot system prompt:", error);
      return null;
    });
  }

  // -------------------------------------------------------------------------
  // Route to Ollama for local models, OpenClaw for cloud models
  // -------------------------------------------------------------------------

  if (isLocalModel(selectedModel)) {
    const ollamaModel = resolveOllamaModelName(selectedModel);
    try {
      const result = await chatViaOllama(
        ollamaModel,
        systemPrompt,
        sanitizedHistory,
        message,
      );
      return NextResponse.json({
        reply: result.reply,
        model: result.model,
        sessionKey,
        provider: "ollama",
        evalTokens: result.evalTokens,
        totalDurationMs: result.totalDurationMs,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to reach Ollama";

      if (errorMessage.includes("aborted") || errorMessage.includes("abort")) {
        return NextResponse.json(
          { error: "Ollama request timed out — the model may still be loading" },
          { status: 504 },
        );
      }

      console.error("Ollama proxy error:", errorMessage);
      return NextResponse.json(
        { error: `Ollama proxy error: ${errorMessage}` },
        { status: 502 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cloud models — proxy through OpenClaw
  // -------------------------------------------------------------------------

  try {
    const openClawResponse = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openclaw-model": selectedModel,
        "x-rivr-user-id": session.user.id,
      },
      body: JSON.stringify({
        username,
        message,
        history: sanitizedHistory,
        model: selectedModel,
        sessionKey,
        systemPrompt,
      }),
    });

    if (!openClawResponse.ok) {
      const errorText = await openClawResponse.text().catch(() => "");
      console.error(
        `OpenClaw chat error: ${openClawResponse.status}`,
        errorText,
      );
      return NextResponse.json(
        { error: `OpenClaw returned ${openClawResponse.status}` },
        { status: 502 },
      );
    }

    const data = await openClawResponse.json();
    return NextResponse.json({
      reply: data.reply || "...",
      model: data.model || selectedModel,
      sessionKey,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach OpenClaw";
    console.error("OpenClaw proxy error:", errorMessage);
    return NextResponse.json(
      { error: `OpenClaw proxy error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
