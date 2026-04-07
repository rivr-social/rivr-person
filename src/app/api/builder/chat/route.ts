import { auth } from "@/auth";
import { buildSystemPrompt, type WorkspaceContext } from "@/lib/bespoke/builder-system-prompt";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const OPENAI_MODEL = "gpt-4o";

const MAX_TOKENS = 8192;

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

type AIProvider = "anthropic" | "openai" | "none";

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function detectProvider(): AIProvider {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

async function streamAnthropic(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;

  const anthropicMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
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

function isAnthropicRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("anthropic api error (429)") || message.includes("rate_limit_error");
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

  const provider = detectProvider();

  if (provider === "none") {
    // Return a non-streaming response with guidance
    const fallbackMessage =
      "I'm running in template mode because no AI provider is configured. " +
      "To enable AI-powered site generation, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` " +
      "in your environment variables.\n\n" +
      "In the meantime, I've generated a starter site using your profile data. " +
      "You can use the template controls to adjust the theme and visible sections.";

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: fallbackMessage })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": CACHE_CONTROL_NO_STORE,
        Connection: "keep-alive",
      },
    });
  }

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

    let stream: ReadableStream<Uint8Array>;

    if (provider === "anthropic") {
      try {
        stream = await streamAnthropic(systemPrompt, body.messages);
      } catch (error) {
        if (process.env.OPENAI_API_KEY && isAnthropicRateLimitError(error)) {
          console.warn("[api/builder/chat] Anthropic rate-limited, retrying with OpenAI");
          stream = await streamOpenAI(systemPrompt, body.messages);
        } else {
          throw error;
        }
      }
    } else {
      stream = await streamOpenAI(systemPrompt, body.messages);
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
