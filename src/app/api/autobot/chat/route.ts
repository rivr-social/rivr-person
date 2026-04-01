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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const MAX_HISTORY_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 8000;

const ALLOWED_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4-6",
  "local/ollama",
] as const;

const DEFAULT_MODEL = "openai/gpt-4o-mini";

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

  const { message, history, model, threadId } = body;

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

  const systemPrompt = await buildAutobotSystemPrompt(session.user.id).catch((error) => {
    console.error("Failed to build autobot system prompt:", error);
    return null;
  });

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
