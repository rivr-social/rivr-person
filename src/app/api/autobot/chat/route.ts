/**
 * POST /api/autobot/chat
 *
 * Native chat endpoint for the Rivr autobot widget. Requires Rivr session auth.
 * Cloud models are called directly:
 *   - anthropic/* → api.anthropic.com using the instance's Claude (Max) OAuth
 *     credential (Bearer + oauth beta header).
 *   - openai/*    → api.openai.com using OPENAI_API_KEY.
 *   - gemini/*    → Google Generative Language API using GOOGLE_AI_API_KEY.
 *   - local/*     → Ollama.
 * OpenClaw has been retired from this environment.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildAutobotSystemPrompt } from "@/lib/bespoke/autobot-system-prompt";
import { isPersonaOf } from "@/lib/persona";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import {
  chatViaGemini,
  chatViaOllama,
  isLocalModel,
  isGeminiModel,
  nativeCloudChat,
  DEFAULT_MODEL,
  isRateLimitError,
  type HistoryMessage,
  type NativeChatToolSpec,
} from "@/lib/ai/native-chat";
import { listMcpToolsForMode, type McpToolCallContext } from "@/lib/federation/mcp-tools";
import { executeMcpToolCall, McpToolCallError } from "@/lib/federation/mcp-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 8000;

const ALLOWED_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4-6",
  "gemini/gemini-2.0-flash",
  "gemini/gemini-2.5-flash",
  "local/ollama",
  "local/llama3.2",
  "local/mistral",
  "local/codellama",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatRequestBody {
  message: string;
  history?: HistoryMessage[];
  model?: string;
  threadId?: string;
  personaId?: string;
  personaName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeSessionSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Build the Anthropic tool specs and executor for the session actor.
 *
 * Anthropic tool names must match `[a-zA-Z0-9_-]{1,64}`, so dotted MCP names
 * (`rivr.posts.create`) are exposed with underscores and mapped back to the
 * real tool name on execution. Execution routes through executeMcpToolCall,
 * which enforces auth-mode gating, the persona approval policy, the MCP
 * execution context, and provenance logging — same path as POST /api/mcp.
 */
function buildChatToolBindings(authContext: McpToolCallContext): {
  tools: NativeChatToolSpec[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
} {
  const nameMap = new Map<string, string>();
  const tools: NativeChatToolSpec[] = [];

  for (const tool of listMcpToolsForMode("session")) {
    const anthropicName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (nameMap.has(anthropicName)) continue;
    nameMap.set(anthropicName, tool.name);
    tools.push({
      name: anthropicName,
      description: tool.description,
      input_schema: tool.inputSchema,
    });
  }

  const executeTool = async (name: string, input: Record<string, unknown>) => {
    const realName = nameMap.get(name);
    if (!realName) {
      throw new McpToolCallError(`Unknown tool: ${name}`, "unknown_tool");
    }
    const { result } = await executeMcpToolCall(realName, input, authContext);
    return result;
  };

  return { tools, executeTool };
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
  // Route to Ollama for local models, native providers for cloud models
  // -------------------------------------------------------------------------

  if (isLocalModel(selectedModel)) {
    try {
      const result = await chatViaOllama({
        selectedModel,
        systemPrompt,
        history: sanitizedHistory,
        message,
      });
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
  // Gemini models — direct API call
  // -------------------------------------------------------------------------

  if (isGeminiModel(selectedModel)) {
    try {
      const result = await chatViaGemini({
        selectedModel,
        systemPrompt,
        history: sanitizedHistory,
        message,
      });
      return NextResponse.json({
        reply: result.reply,
        model: result.model,
        sessionKey,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to reach Gemini";
      console.error("Gemini chat error:", errorMessage);
      return NextResponse.json(
        { error: `Gemini error: ${errorMessage}` },
        { status: 502 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cloud models — native provider calls (Anthropic / OpenAI) with the shared
  // Gemini-direct fallback on rate-limit baked into nativeCloudChat.
  // -------------------------------------------------------------------------

  // Agentic tool support (Anthropic models): expose the session-mode MCP tool
  // registry so the autobot can act, not just talk. Tool execution is scoped
  // to the resolved actor and flows through the same approval-policy +
  // provenance path as the /api/mcp endpoint.
  const toolAuthContext: McpToolCallContext = {
    actorId: promptActorId,
    controllerId: ownerId,
    actorType: resolvedPersonaId ? "persona" : "human",
    authMode: "session",
  };
  const { tools, executeTool } = buildChatToolBindings(toolAuthContext);

  try {
    const result = await nativeCloudChat({
      selectedModel,
      systemPrompt,
      history: sanitizedHistory,
      message,
      tools,
      executeTool,
    });

    return NextResponse.json({
      reply: result.reply,
      model: result.model,
      sessionKey,
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach the model provider";

    // nativeCloudChat already attempts the Gemini fallback when configured; if
    // we still land here on a rate-limit, surface a clear provider error.
    if (isRateLimitError(errorMessage)) {
      console.warn(
        "[api/autobot/chat] cloud provider rate-limited and fallback unavailable",
      );
    }

    console.error("[api/autobot/chat] cloud chat error:", errorMessage);
    return NextResponse.json(
      { error: `Chat provider error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
