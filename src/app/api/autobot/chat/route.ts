/**
 * POST /api/autobot/chat
 *
 * Proxies chat requests to the OpenClaw token server at ai.camalot.me/api/chat.
 * Requires Rivr session auth. Forwards { username, message, history } with the
 * authenticated user context. Supports model selection via x-openclaw-model header.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildAutobotSystemPrompt } from "@/lib/bespoke/autobot-system-prompt";
import { isPersonaOf } from "@/lib/persona";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";

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
const OPENCLAW_FALLBACK_MODEL = "openai/gpt-4o-mini";

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

interface OpenClawChatResult {
  ok: boolean;
  status: number;
  errorText: string;
  data: Record<string, unknown> | null;
  model: string;
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

function shouldRetryCloudChatWithFallback(
  selectedModel: string,
  status: number,
  errorText: string,
): boolean {
  if (!selectedModel.startsWith("anthropic/")) return false;
  const normalized = errorText.toLowerCase();
  return (
    status === 429 ||
    normalized.includes("rate_limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("429")
  );
}

async function chatViaOpenClaw(params: {
  sessionUserId: string;
  username: string;
  message: string;
  history: HistoryMessage[];
  selectedModel: string;
  sessionKey: string;
  systemPrompt: string | null;
}): Promise<OpenClawChatResult> {
  const response = await fetch(`${OPENCLAW_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openclaw-model": params.selectedModel,
      "x-rivr-user-id": params.sessionUserId,
    },
    body: JSON.stringify({
      username: params.username,
      message: params.message,
      history: params.history,
      model: params.selectedModel,
      sessionKey: params.sessionKey,
      systemPrompt: params.systemPrompt,
    }),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorText: await response.text().catch(() => ""),
      data: null,
      model: params.selectedModel,
    };
  }

  return {
    ok: true,
    status: response.status,
    errorText: "",
    data: (await response.json()) as Record<string, unknown>,
    model: params.selectedModel,
  };
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

  const ownerId = session.user.id;
  const subject = await resolveAutobotConnectionScope(ownerId);
  let promptActorId = subject.actorId;
  let resolvedPersonaId: string | null = subject.scopeType === "persona" ? subject.actorId : null;
  let resolvedPersonaName: string | null =
    subject.scopeType === "persona" ? subject.scopeLabel : null;

  if (personaId && typeof personaId === "string") {
    const owned = await isPersonaOf(personaId, ownerId).catch(() => false);
    if (owned) {
      promptActorId = personaId;
      resolvedPersonaId = personaId;
      resolvedPersonaName = personaName || resolvedPersonaName || "persona";
    }
  }

  const actorSettings = await getAutobotUserSettings(promptActorId).catch(() => null);
  const includedPersonaKgIds = actorSettings?.includedPersonaKgIds ?? [];
  const username = resolvedPersonaName || session.user.name || session.user.email || "rivr-user";
  const sessionKey = [
    resolvedPersonaId ? "agent:persona:rivr" : "agent:main:rivr",
    sanitizeSessionSegment(promptActorId),
    sanitizeSessionSegment(threadId || username),
  ].join(":");

  // Build system prompt — inject persona KG context when a personaId is provided
  let systemPrompt: string | null = null;
  systemPrompt = await buildAutobotSystemPrompt(ownerId, {
    promptActorId,
    activePersonaId: resolvedPersonaId ?? undefined,
    activePersonaName: resolvedPersonaName ?? undefined,
    includedPersonaKgIds,
  }).catch((error) => {
    console.error("Failed to build autobot system prompt:", error);
    return null;
  });
  // Ensure we never send a null system prompt — minimal fallback preserves identity
  if (!systemPrompt) {
    const userName = session.user.name || session.user.email || "User";
    systemPrompt = `You are the personal AI agent for ${userName} on their Rivr sovereign instance. You have tools, persistent memory, and infrastructure access. Never respond as a blank-slate assistant. If you have a knowledge graph, query it first. Be direct and helpful.`;
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
    let result = await chatViaOpenClaw({
      sessionUserId: promptActorId,
      username,
      message,
      history: sanitizedHistory,
      selectedModel,
      sessionKey,
      systemPrompt,
    });

    if (
      !result.ok &&
      shouldRetryCloudChatWithFallback(selectedModel, result.status, result.errorText)
    ) {
      console.warn(
        `[api/autobot/chat] ${selectedModel} rate-limited, retrying with ${OPENCLAW_FALLBACK_MODEL}`,
      );
      result = await chatViaOpenClaw({
        sessionUserId: promptActorId,
        username,
        message,
        history: sanitizedHistory,
        selectedModel: OPENCLAW_FALLBACK_MODEL,
        sessionKey,
        systemPrompt,
      });
    }

    if (!result.ok) {
      console.error(`OpenClaw chat error: ${result.status}`, result.errorText);
      return NextResponse.json(
        { error: `OpenClaw returned ${result.status}` },
        { status: 502 },
      );
    }

    const data = result.data ?? {};
    return NextResponse.json({
      reply: typeof data.reply === "string" ? data.reply : "...",
      model:
        typeof data.model === "string"
          ? data.model
          : result.model,
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
