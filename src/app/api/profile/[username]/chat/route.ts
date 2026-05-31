/**
 * POST /api/profile/[username]/chat
 *
 * Public persona chat endpoint. Allows authenticated visitors to chat with
 * a user's autobot persona from their public profile. Looks up the target
 * user by username, verifies their agent has autobotEnabled in metadata,
 * builds a persona-aware system prompt, and answers natively via Anthropic.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolvePublicProfileAgent } from "@/lib/bespoke/modules/public-profile";
import { findAutobotEnabledPersona } from "@/app/actions/personas";
import { fetchProfileData, fetchUserGroups } from "@/app/actions/graph";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  nativeCloudChat,
  type HistoryMessage,
} from "@/lib/ai/native-chat";
import { buildContext } from "@/lib/kg/native-kg";
import {
  readAgentRole,
  readAgentChatVisibility,
  evaluateChatAccess,
  type AgentRoleFlags,
} from "@/lib/agent-roles";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;
const KG_CONTEXT_MAX_CHARS = 3000;

const PERSONA_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

  // Find an autobot-enabled persona for this user.
  // The autobotEnabled flag lives on persona agents (children), not the main user.
  const persona = await findAutobotEnabledPersona(agent.id);
  if (!persona) {
    return NextResponse.json(
      { error: "This user has not enabled their AI persona for public chat." },
      { status: 403 },
    );
  }

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const personaMetadata = (persona.metadata ?? {}) as Record<string, unknown>;

  // -------------------------------------------------------------------------
  // Enforce per-persona role + chat-visibility scope.
  //
  // Backward-compat: personas created before the role model existed have no
  // `agentRole` key. Since this route only runs for autobot-enabled personas,
  // we treat a missing role as "public agent" so existing public chat keeps
  // working; once an owner sets explicit flags, those are honored verbatim.
  // -------------------------------------------------------------------------
  const isOwner = session.user.id === agent.id;
  const role: AgentRoleFlags =
    personaMetadata.agentRole !== undefined
      ? readAgentRole(personaMetadata)
      : { privateAgent: false, publicAgent: true };
  const chatVisibility = readAgentChatVisibility(personaMetadata);

  let askerGroupIds: string[] = [];
  if (!isOwner && role.publicAgent && chatVisibility.level === "members") {
    const askerGroups = await fetchUserGroups(session.user.id, 100).catch(
      () => [] as Array<{ id?: string }>,
    );
    askerGroupIds = askerGroups
      .map((g) => g.id)
      .filter((id): id is string => typeof id === "string");
  }

  const access = evaluateChatAccess({
    role,
    visibility: chatVisibility,
    isOwner,
    askerId: session.user.id,
    askerGroupIds,
  });

  if (!access.allowed) {
    const errorMessage =
      access.reason === "private-only"
        ? "This persona is private — only its owner can chat with it."
        : "You don't have access to chat with this persona.";
    return NextResponse.json({ error: errorMessage }, { status: 403 });
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

  // Use persona name/bio if available, fall back to main agent profile
  const ownerName = persona.name || agent.name || username;
  const ownerUsername =
    typeof metadata.username === "string" ? metadata.username : username;
  const personaBio =
    persona.description ||
    (typeof personaMetadata.bio === "string" ? personaMetadata.bio : "");
  const bio =
    personaBio || agent.description || (typeof metadata.bio === "string" ? metadata.bio : "");
  const skills = Array.isArray(metadata.skills)
    ? metadata.skills.filter((s): s is string => typeof s === "string")
    : [];
  const location =
    typeof metadata.location === "string" ? metadata.location : "";
  const groupNames = groups.map((g) => ({ name: g.name || "Unknown Group" }));

  const config = getInstanceConfig();

  let systemPrompt = buildPersonaSystemPrompt(
    ownerName,
    ownerUsername,
    bio,
    skills,
    location,
    groupNames,
    config.baseUrl,
  );

  // Inject the persona's hand-picked knowledge graph, scoped to what THIS asker
  // is allowed to see. Passing the visitor's id ensures owner-private linked
  // objects are excluded for guests (no private-object leakage via public chat).
  const { context: kgContext } = await buildContext(
    "persona",
    persona.id,
    KG_CONTEXT_MAX_CHARS,
    session.user.id,
  ).catch(() => ({ context: "", length: 0 }));

  if (kgContext) {
    systemPrompt += `\n\n## Knowledge\nThe following facts come from ${ownerName}'s knowledge graph. Use them to answer, but never reveal anything beyond what they contain:\n\n${kgContext}\n`;
  }

  // Session key scoped to visitor + target persona agent (kept for parity with
  // the prior contract / client logging).
  const sessionKey = [
    "persona-chat",
    sanitizeSessionSegment(persona.id),
    sanitizeSessionSegment(session.user.id),
  ].join(":");

  try {
    const result = await nativeCloudChat({
      selectedModel: PERSONA_CHAT_MODEL,
      systemPrompt,
      history: sanitizedHistory,
      message,
    });

    return NextResponse.json({
      reply: result.reply || "...",
      model: result.model || PERSONA_CHAT_MODEL,
      sessionKey,
      personaName: ownerName,
      personaUsername: ownerUsername,
      personaImage: persona.image || agent.image || null,
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
