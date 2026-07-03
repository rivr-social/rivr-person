import { auth } from "@/auth";
import { buildSystemPrompt, type WorkspaceContext } from "@/lib/bespoke/builder-system-prompt";
import type { SiteFiles } from "@/lib/bespoke/site-files";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";
import { resolveClaudeCodeConnectorToken } from "@/lib/autobot-connector-secrets";
import {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_VERSION,
  CLAUDE_CODE_IDENTITY,
  resolveClaudeOAuthToken,
} from "@/lib/ai/native-chat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const OPENAI_MODEL = "gpt-4o";
const GEMINI_MODEL = "gemini-2.0-flash";

// Raised from 8192: whole multi-page sites (index + styles + several pages)
// routinely exceed 8k output tokens, and the whole-file contract means a cut-off
// stream silently drops the truncated file. 16000 stays well inside maxDuration.
const MAX_TOKENS = 16_000;

// Warning surfaced to the client when the model stops because it hit the output
// cap (stop_reason: "max_tokens") — the last file is likely truncated/dropped.
const TRUNCATION_WARNING =
  "The response was cut off at the length limit, so the last file may be " +
  "incomplete or missing. Ask me to \"continue\" or to regenerate just that file.";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_TIMEOUT_MS = 90_000;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  profileBundle: Record<string, unknown>;
  currentFiles: SiteFiles;
  workspaceContext?: WorkspaceContext;
  extraDataSources?: Record<string, unknown>;
}

type AIProvider = "anthropic" | "openai" | "gemini" | "ollama" | "none";

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

async function streamAnthropic(
  systemPrompt: string,
  messages: ChatMessage[],
  connectorToken?: string,
): Promise<ReadableStream<Uint8Array>> {
  // A4: the builder shares the assistant's Claude credential path. Resolve via
  // the OAuth chain (agent's claude_code connector token → claude-auth file →
  // ANTHROPIC_API_KEY) and call the Messages API with Bearer + oauth-beta, so a
  // single pasted Claude Code token powers BOTH builder and chat.
  const token = await resolveClaudeOAuthToken(connectorToken);

  const anthropicMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // OAuth (Claude Max / Claude Code) credentials require the first system block
  // to be the Claude Code identity string; the operator prompt follows it.
  const systemBlocks: Array<{ type: "text"; text: string }> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    { type: "text", text: systemPrompt },
  ];

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      messages: anthropicMessages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            const eventType = event.type;

            if (eventType === "content_block_delta") {
              const delta = event.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                // Send as SSE
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text: delta.text })}\n\n`),
                );
              }
            } else if (eventType === "message_delta") {
              // The message_delta event carries the final stop_reason. A value of
              // "max_tokens" means output was truncated mid-file — surface it so
              // the client doesn't present a silently-dropped file as success.
              const delta = event.delta as Record<string, unknown> | undefined;
              if (delta?.stop_reason === "max_tokens") {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ warning: TRUNCATION_WARNING })}\n\n`),
                );
              }
            } else if (eventType === "message_stop") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } else if (eventType === "error") {
              const errorData = event.error as Record<string, unknown> | undefined;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: errorData?.message || "Stream error" })}\n\n`,
                ),
              );
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI streaming
// ---------------------------------------------------------------------------

async function streamOpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.OPENAI_API_KEY!;

  const openaiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: openaiMessages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
            if (choices && choices.length > 0) {
              const delta = choices[0].delta as Record<string, unknown> | undefined;
              if (delta?.content && typeof delta.content === "string") {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text: delta.content })}\n\n`),
                );
              }
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// Gemini streaming (usage-limit fallback)
// ---------------------------------------------------------------------------

async function streamGemini(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.GOOGLE_AI_API_KEY!;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `${GEMINI_API_URL}/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
            if (candidates && candidates.length > 0) {
              const content = candidates[0].content as Record<string, unknown> | undefined;
              const parts = content?.parts as Array<Record<string, unknown>> | undefined;
              if (parts && parts.length > 0 && typeof parts[0].text === "string") {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text: parts[0].text })}\n\n`),
                );
              }
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// Ollama streaming (local fallback)
// ---------------------------------------------------------------------------

async function streamOllamaBuilder(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const ollamaMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let response: globalThis.Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: ollamaMessages,
        stream: true,
        options: { num_ctx: 4096 },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama API error (${response.status}): ${errorText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(ctrl) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timeout);
          ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
          ctrl.close();
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const msg = parsed.message as Record<string, unknown> | undefined;
            if (msg && typeof msg.content === "string" && msg.content) {
              ctrl.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: msg.content })}\n\n`),
              );
            }
            if (parsed.done === true) {
              clearTimeout(timeout);
              ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
              ctrl.close();
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    },
    cancel() {
      clearTimeout(timeout);
      reader.cancel();
    },
  });
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("api error (429)") ||
    message.includes("rate_limit") ||
    message.includes("rate limit") ||
    message.includes("resource_exhausted")
  );
}

/**
 * Map a direct-agent `selectedModel` slug (e.g. `"anthropic/claude-sonnet-4-6"`,
 * `"openai/gpt-4o"`, `"google/gemini-2.0-flash"`, `"ollama/llama3.2"`) to the
 * provider that should be tried FIRST. Returns `null` when the slug does not
 * name a known provider, in which case the API-key default ordering is used.
 */
function preferredProviderFromModel(selectedModel: string | undefined): AIProvider | null {
  if (!selectedModel) return null;
  const prefix = selectedModel.split("/")[0]?.toLowerCase().trim();
  switch (prefix) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
    case "gemini":
      return "gemini";
    case "ollama":
      return "ollama";
    default:
      return null;
  }
}

/**
 * Resolve the ordered fallback chain based on available API keys.
 * When `preferred` names an available provider it is tried first so the builder
 * honors the direct agent's configured model; the remaining providers follow as
 * fallbacks. Ollama is always last — it needs no API key, just a running host.
 */
function buildFallbackChain(
  preferred?: AIProvider | null,
  hasClaudeCredential = false,
): AIProvider[] {
  const available: AIProvider[] = [];
  // Anthropic is reachable when ANY Claude credential resolves: the agent's
  // claude_code connector token, the instance claude-auth store, or the env key.
  if (
    hasClaudeCredential ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.AGENT_HQ_CLAUDE_HOME
  ) {
    available.push("anthropic");
  }
  if (process.env.OPENAI_API_KEY) available.push("openai");
  if (process.env.GOOGLE_AI_API_KEY) available.push("gemini");
  available.push("ollama");

  if (!preferred || !available.includes(preferred)) {
    return available;
  }
  return [preferred, ...available.filter((provider) => provider !== preferred)];
}

async function streamForProvider(
  provider: AIProvider,
  systemPrompt: string,
  messages: ChatMessage[],
  connectorToken?: string,
): Promise<ReadableStream<Uint8Array>> {
  switch (provider) {
    case "anthropic":
      return streamAnthropic(systemPrompt, messages, connectorToken);
    case "openai":
      return streamOpenAI(systemPrompt, messages);
    case "gemini":
      return streamGemini(systemPrompt, messages);
    case "ollama":
      return streamOllamaBuilder(systemPrompt, messages);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/chat
//
// Streaming chat endpoint for the AI-powered site builder. Accepts
// conversation history, profile bundle, and current site files. Returns
// a Server-Sent Events stream with incremental text chunks.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_CONTROL_NO_STORE,
        },
      },
    );
  }

  // Resolve the canonical direct agent so the builder shares one identity +
  // one autobotSettings blob (model, connectors, MCP token) with the assistant.
  // Honor the direct agent's configured model when picking the provider order.
  const { autobotSettings } = await resolveDirectAgent(session.user.id);
  const claudeConnectorToken = resolveClaudeCodeConnectorToken(
    autobotSettings.connections,
  );
  const fallbackChain = buildFallbackChain(
    preferredProviderFromModel(autobotSettings.selectedModel),
    Boolean(claudeConnectorToken),
  );

  try {
    const body = (await request.json()) as ChatRequestBody;

    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(
        JSON.stringify({ error: "Missing required field: messages" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": CACHE_CONTROL_NO_STORE,
          },
        },
      );
    }

    const systemPrompt = buildSystemPrompt(
      body.profileBundle ?? {},
      body.currentFiles ?? {},
      body.workspaceContext,
      body.extraDataSources,
    );

    // Walk the fallback chain — try each provider, fall through on rate-limit
    let stream: ReadableStream<Uint8Array> | null = null;
    let lastError: unknown = null;

    for (const provider of fallbackChain) {
      try {
        stream = await streamForProvider(
          provider,
          systemPrompt,
          body.messages,
          claudeConnectorToken,
        );
        break;
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error)) {
          console.warn(`[api/builder/chat] ${provider} rate-limited, trying next fallback`);
          continue;
        }
        // Non-rate-limit errors on cloud providers — try next fallback
        if (provider !== "ollama") {
          console.warn(`[api/builder/chat] ${provider} failed: ${error instanceof Error ? error.message : error}, trying next`);
          continue;
        }
        console.warn(`[api/builder/chat] ollama failed: ${error instanceof Error ? error.message : error}, falling back to template mode`);
        break;
      }
    }

    if (!stream) {
      // All providers exhausted — return template mode message
      const fallbackMessage =
        "All AI providers are currently rate-limited or unavailable. " +
        "The builder is running in template mode.\n\n" +
        "You can use the template controls to adjust the theme and visible sections, " +
        "or try again in a few minutes.";
      const errorNote =
        lastError instanceof Error && lastError.message
          ? `\n\nLast provider error: ${lastError.message}`
          : "";

      const encoder = new TextEncoder();
      stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: `${fallbackMessage}${errorNote}` })}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": CACHE_CONTROL_NO_STORE,
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[api/builder/chat] Chat failed:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Chat request failed",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_CONTROL_NO_STORE,
        },
      },
    );
  }
}
