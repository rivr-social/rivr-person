/**
 * POST /api/autobot/ollama
 * GET  /api/autobot/ollama
 *
 * Ollama proxy route for local LLM deployment.
 * POST: proxies chat completion requests to a local Ollama instance.
 * GET:  returns health/status and available models from the Ollama instance.
 *
 * Env vars:
 *   OLLAMA_URL   – base URL for the Ollama server (default: http://localhost:11434)
 *   OLLAMA_MODEL – default model to use (default: llama3.2)
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

const OLLAMA_TIMEOUT_MS = 90_000;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_HISTORY_LENGTH = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OllamaMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface OllamaProxyRequestBody {
  message: string;
  history?: HistoryMessage[];
  model?: string;
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve which Ollama model to use. If the caller sends a value like
 * "local/llama3.2" we strip the "local/" prefix and use the remainder.
 * Falls back to OLLAMA_MODEL env var, then to "llama3.2".
 */
function resolveOllamaModel(requestedModel?: string): string {
  if (!requestedModel) return OLLAMA_MODEL;

  // Strip the "local/" prefix used by Rivr model selectors
  const stripped = requestedModel.startsWith("local/")
    ? requestedModel.slice(6)
    : requestedModel;

  return stripped || OLLAMA_MODEL;
}

/**
 * Convert Rivr chat history + current message into Ollama messages array.
 */
function buildOllamaMessages(
  message: string,
  history: HistoryMessage[],
  systemPrompt?: string | null,
): OllamaMessage[] {
  const messages: OllamaMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of history) {
    if (
      (msg.role === "user" || msg.role === "assistant" || msg.role === "system") &&
      typeof msg.content === "string"
    ) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: "user", content: message });

  return messages;
}

// ---------------------------------------------------------------------------
// GET handler — health check + available models
// ---------------------------------------------------------------------------

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const [healthRes, tagsRes] = await Promise.allSettled([
      fetch(`${OLLAMA_URL}/api/version`, { signal: controller.signal }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal }),
    ]);

    clearTimeout(timeout);

    const reachable = healthRes.status === "fulfilled" && healthRes.value.ok;

    let version: string | null = null;
    if (healthRes.status === "fulfilled" && healthRes.value.ok) {
      try {
        const vData = await healthRes.value.json();
        version = vData.version || null;
      } catch {
        // version endpoint may not return JSON on all builds
      }
    }

    let models: Array<{ name: string; size: number }> = [];
    if (tagsRes.status === "fulfilled" && tagsRes.value.ok) {
      try {
        const tData: OllamaTagsResponse = await tagsRes.value.json();
        models = (tData.models || []).map((m) => ({
          name: m.name,
          size: m.size,
        }));
      } catch {
        // graceful degradation
      }
    }

    return NextResponse.json({
      ollama: {
        url: OLLAMA_URL,
        reachable,
        version,
        defaultModel: OLLAMA_MODEL,
        availableModels: models,
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach Ollama";
    return NextResponse.json({
      ollama: {
        url: OLLAMA_URL,
        reachable: false,
        version: null,
        defaultModel: OLLAMA_MODEL,
        availableModels: [],
        error: errorMessage,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// POST handler — chat completion proxy
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: OllamaProxyRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, history, model, systemPrompt } = body;

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

  const sanitizedHistory: HistoryMessage[] = [];
  if (Array.isArray(history)) {
    for (const msg of history.slice(-MAX_HISTORY_LENGTH)) {
      if (
        (msg.role === "user" || msg.role === "assistant" || msg.role === "system") &&
        typeof msg.content === "string"
      ) {
        sanitizedHistory.push({ role: msg.role, content: msg.content });
      }
    }
  }

  const ollamaModel = resolveOllamaModel(model);
  const ollamaMessages = buildOllamaMessages(message, sanitizedHistory, systemPrompt);

  const ollamaPayload: OllamaChatRequest = {
    model: ollamaModel,
    messages: ollamaMessages,
    stream: false,
    options: {
      num_ctx: 4096,
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text().catch(() => "");
      console.error(
        `Ollama chat error: ${ollamaResponse.status}`,
        errorText,
      );
      return NextResponse.json(
        {
          error: `Ollama returned ${ollamaResponse.status}: ${errorText.slice(0, 200)}`,
        },
        { status: 502 },
      );
    }

    const data: OllamaChatResponse = await ollamaResponse.json();

    return NextResponse.json({
      reply: data.message?.content || "...",
      model: `local/${data.model || ollamaModel}`,
      provider: "ollama",
      evalTokens: data.eval_count || null,
      totalDurationMs: data.total_duration
        ? Math.round(data.total_duration / 1_000_000)
        : null,
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
