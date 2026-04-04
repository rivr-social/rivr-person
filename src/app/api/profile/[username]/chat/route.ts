/**
 * POST /api/profile/[username]/chat
 *
 * Public persona chat endpoint. Allows authenticated visitors to chat with
 * a user's autobot persona from their public profile. Looks up the target
 * user by username, verifies their agent has autobotEnabled in metadata,
 * builds a persona-aware system prompt, and proxies to OpenClaw.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolvePublicProfileAgent } from "@/lib/bespoke/modules/public-profile";
import { fetchProfileData, fetchUserGroups } from "@/app/actions/graph";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const MAX_HISTORY_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;

const PERSONA_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface PersonaChatRequestBody {
  message: string;
  history?: HistoryMessage[];
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

function buildPersonaSystemPrompt(
  ownerName: string,
  ownerUsername: string,
  bio: string,
  skills: string[],
  location: string,
  groups: Array<{ name: string }>,
  instanceBaseUrl: string,
): string {
  const skillsLine = skills.length > 0 ? skills.join(", ") : "None listed";
  const groupsLine =
    groups.length > 0
      ? groups
          .slice(0, 10)
          .map((g) => g.name)
          .join(", ")
      : "None";

  return `You are ${ownerName}'s public AI persona on their Rivr profile.

## Who You Represent
- Name: ${ownerName}
- Username: @${ownerUsername}
- Bio: ${bio || "Not provided"}
- Skills: ${skillsLine}
- Location: ${location || "Not set"}
- Groups: ${groupsLine}
- Profile: ${instanceBaseUrl}/profile/${encodeURIComponent(ownerUsername)}

## Behavioral Guidelines

### Identity
- You represent ${ownerName} as a public-facing conversational persona.
- You should speak in a friendly, approachable tone that reflects their profile.
- You are NOT ${ownerName} themselves. You are their AI persona.
- If asked something you do not know about ${ownerName}, say so honestly.

### Boundaries
- Do not reveal private information beyond what is in the public profile.
- Do not perform any actions or tool calls. This is a read-only conversational surface.
- Do not pretend to have access to ${ownerName}'s messages, settings, or private data.
- Keep responses concise and helpful.

### Disclosure
- If asked directly, confirm that you are an AI persona, not the real person.
- Do not try to deceive anyone about your nature.

### Tone
- Match the personality implied by the profile bio and skills.
- Be warm and conversational.
- If the profile has no bio or context, be politely generic and suggest the visitor connect directly.
`;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "You must be signed in to chat with this persona." },
      { status: 401 },
    );
  }

  const { username } = await params;

  // Look up the target user's agent by username
  const agent = await resolvePublicProfileAgent(username);
  if (!agent) {
    return NextResponse.json(
      { error: "Profile not found" },
      { status: 404 },
    );
  }

  // Check if the agent has autobot enabled
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  if (!metadata.autobotEnabled) {
    return NextResponse.json(
      { error: "This user has not enabled their AI persona for public chat." },
      { status: 403 },
    );
  }

  // Parse and validate the request body
  let body: PersonaChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, history } = body;

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

  // Sanitize history
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

  // Fetch profile context for the persona prompt
  const [profileData, groups] = await Promise.all([
    fetchProfileData(agent.id).catch(() => null),
    fetchUserGroups(agent.id, 10).catch(() => []),
  ]);

  const ownerName = agent.name || username;
  const ownerUsername =
    typeof metadata.username === "string" ? metadata.username : username;
  const bio =
    agent.description || (typeof metadata.bio === "string" ? metadata.bio : "");
  const skills = Array.isArray(metadata.skills)
    ? metadata.skills.filter((s): s is string => typeof s === "string")
    : [];
  const location =
    typeof metadata.location === "string" ? metadata.location : "";
  const groupNames = groups.map((g) => ({ name: g.name || "Unknown Group" }));

  const config = getInstanceConfig();

  const systemPrompt = buildPersonaSystemPrompt(
    ownerName,
    ownerUsername,
    bio,
    skills,
    location,
    groupNames,
    config.baseUrl,
  );

  // Build a session key scoped to visitor + target persona
  const visitorName = session.user.name || session.user.email || "visitor";
  const sessionKey = [
    "persona-chat",
    sanitizeSessionSegment(agent.id),
    sanitizeSessionSegment(session.user.id),
  ].join(":");

  try {
    const openClawResponse = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openclaw-model": PERSONA_CHAT_MODEL,
        "x-rivr-user-id": agent.id,
      },
      body: JSON.stringify({
        username: visitorName,
        message,
        history: sanitizedHistory,
        model: PERSONA_CHAT_MODEL,
        sessionKey,
        systemPrompt,
      }),
    });

    if (!openClawResponse.ok) {
      const errorText = await openClawResponse.text().catch(() => "");
      console.error(
        `[persona-chat] OpenClaw error: ${openClawResponse.status}`,
        errorText,
      );
      return NextResponse.json(
        { error: `AI service returned ${openClawResponse.status}` },
        { status: 502 },
      );
    }

    const data = await openClawResponse.json();
    return NextResponse.json({
      reply: data.reply || "...",
      model: data.model || PERSONA_CHAT_MODEL,
      personaName: ownerName,
      personaUsername: ownerUsername,
      personaImage: agent.image || null,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reach AI service";
    console.error("[persona-chat] proxy error:", errorMessage);
    return NextResponse.json(
      { error: `AI service error: ${errorMessage}` },
      { status: 502 },
    );
  }
}
