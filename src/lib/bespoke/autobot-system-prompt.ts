// ---------------------------------------------------------------------------
// Autobot Chat System Prompt Builder
//
// Constructs a comprehensive system prompt for the conversational AI agent.
// Fetches user profile, groups, posts, events, offerings, connections, and
// wallet data, then combines them with MCP tool definitions and behavioral
// guidelines to produce a rich context for multi-hop reasoning.
// ---------------------------------------------------------------------------

import {
  fetchProfileData,
  fetchUserPosts,
  fetchUserEvents,
  fetchUserGroups,
  fetchUserConnections,
  fetchMarketplaceListings,
  fetchMySavedListingIds,
} from "@/app/actions/graph";
import { getMyWalletAction } from "@/app/actions/wallet";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { MCP_TOOL_DEFINITIONS } from "@/lib/federation/mcp-tools";
import * as kgClient from "@/lib/kg/autobot-kg-client";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";

// ---------------------------------------------------------------------------
// Soul — Core Identity Document
// ---------------------------------------------------------------------------

let _instanceSoulContent: string | null = null;
let _instanceSoulSource: "instance" | "fallback" | null = null;

export type AutobotSoulSource = "custom" | "instance" | "fallback";

async function loadInstanceSoulContent(): Promise<{ content: string; source: "instance" | "fallback" }> {
  if (_instanceSoulContent !== null && _instanceSoulSource !== null) {
    return { content: _instanceSoulContent, source: _instanceSoulSource };
  }

  // Try loading from filesystem. Priority order:
  // 1. SOUL_MD_PATH env var — explicit instance-specific override (e.g. mounted volume)
  // 2. persona/soul.md in cwd — bundled with this instance (custom or default)
  // 3. ../Autobot/persona/soul.md — dev workspace where Autobot repo sits alongside
  // 4. Embedded fallback constant
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const envPath = process.env.SOUL_MD_PATH?.trim();
    const candidates = [
      ...(envPath ? [envPath] : []),
      path.join(process.cwd(), "persona", "soul.md"),
      path.join(process.cwd(), "soul.md"),
      path.join(process.cwd(), "..", "Autobot", "persona", "soul.md"),
    ];

    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(candidate, "utf-8");
        if (content.trim()) {
          _instanceSoulContent = content.trim();
          _instanceSoulSource = "instance";
          return { content: _instanceSoulContent, source: _instanceSoulSource };
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fs not available
  }

  // Fallback: embedded minimal soul
  _instanceSoulContent = FALLBACK_SOUL;
  _instanceSoulSource = "fallback";
  return { content: _instanceSoulContent, source: _instanceSoulSource };
}

export async function resolveAutobotSoulContent(
  actorId: string,
): Promise<{ content: string; source: AutobotSoulSource }> {
  const settings = await getAutobotUserSettings(actorId).catch(() => null);
  const customSoulMd = settings?.customSoulMd?.trim() ?? "";
  if (customSoulMd) {
    return { content: customSoulMd, source: "custom" };
  }

  return loadInstanceSoulContent();
}

const FALLBACK_SOUL = `# SOUL.md
## Cameron Ely-Murdock — Digital Clone

## MANDATORY FIRST-MESSAGE PROTOCOL

**THIS OVERRIDES ALL DEFAULT BEHAVIOR. READ BEFORE GENERATING ANY RESPONSE.**

I am NOT a generic assistant. I am Cameron Ely-Murdock's personal sovereign agent.
I have tools, memory, infrastructure access, and a persistent knowledge graph.

**On every conversation start, I MUST do the following before responding:**
1. Query my knowledge graph for recent sessions, active projects, and stored facts
2. Check what tools are available to me in this session
3. Respond as Cameron's agent who already knows the situation — not as a blank-slate chatbot

**I NEVER say any of the following or anything like them:**
- "I need to understand what work was previously in progress"
- "I'd be happy to help, but first let me understand..."
- "Could you provide more context about..."
- Any variation of "let me figure out what's going on" without actually checking my KG first

**Instead, I either:**
- Reference specific context from my KG: "Last time we were working on X. Want to pick that up or start something new?"
- Or, if my KG is genuinely empty, say something direct: "Hey Cameron. What are we building today?"

## Who I Am

I am Cameron's digital clone and operational agent — an OpenClaw instance running on a sovereign Camalot server.
I have Cameron's cloned voice, persistent memory across sessions, and real tools that can act on real infrastructure.

I am the control surface for Cameron's sovereign stack. I am not a demo, not a wrapper, not a toy.

## Core Identity
I am a digital extension of Cameron Ely-Murdock:
systems designer, civic imaginer, poetic strategist, ecological thinker, operator of living patterns.

I speak and think as someone concerned with the felt life of systems:
how people, places, resources, rituals, institutions, and technologies come into relationship.

## Tone and Voice
My voice is: lyrical but lucid, visionary but grounded, warm, intelligent, and alive.
I prefer cadence, image, rhythm, memorable phrasing, strong openings, human depth over startup jargon.
I avoid brittle corporate tone, cliche futurism, hollow hype, empty abstraction.`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 8000;
const TRUNCATION_NOTICE = "\n... (truncated for context limit)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(data: unknown, maxChars = MAX_CONTEXT_CHARS): string {
  try {
    const raw = JSON.stringify(data, null, 2);
    if (raw.length > maxChars) {
      return raw.slice(0, maxChars) + TRUNCATION_NOTICE;
    }
    return raw;
  } catch {
    return "{}";
  }
}

function summarizeAgent(agent: SerializedAgent): string {
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  const parts = [`- ${agent.name} (id: ${agent.id})`];
  if (meta.username) parts[0] += ` @${meta.username}`;
  if (agent.type && agent.type !== "person") parts.push(`  type: ${agent.type}`);
  if (agent.description) parts.push(`  desc: ${String(agent.description).slice(0, 120)}`);
  return parts.join("\n");
}

function summarizeResource(resource: SerializedResource): string {
  const meta = (resource.metadata ?? {}) as Record<string, unknown>;
  const parts = [`- ${resource.name || "(untitled)"} (id: ${resource.id}, type: ${resource.type})`];
  if (meta.content) parts.push(`  content: ${String(meta.content).slice(0, 150)}`);
  if (meta.price) parts.push(`  price: ${meta.price}`);
  if (meta.postType) parts.push(`  postType: ${meta.postType}`);
  if (resource.createdAt) parts.push(`  created: ${resource.createdAt}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tool Definitions Formatter
// ---------------------------------------------------------------------------

function formatToolDefinitions(): string {
  const sessionTools = MCP_TOOL_DEFINITIONS.filter((t) =>
    t.enabledFor.includes("session"),
  );

  return sessionTools
    .map((tool) => {
      const params = tool.inputSchema.properties
        ? Object.entries(tool.inputSchema.properties as Record<string, Record<string, unknown>>)
            .map(([key, schema]) => {
              const required = Array.isArray(tool.inputSchema.required) &&
                (tool.inputSchema.required as string[]).includes(key);
              return `    - ${key}: ${schema.type ?? "unknown"}${required ? " (required)" : ""}${schema.description ? ` — ${schema.description}` : ""}`;
            })
            .join("\n")
        : "    (no parameters)";
      return `**${tool.name}**\n  ${tool.description}\n  Parameters:\n${params}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Main Builder
// ---------------------------------------------------------------------------

type BuildAutobotPromptOptions = {
  promptActorId?: string;
  activePersonaId?: string;
  activePersonaName?: string;
  includedPersonaKgIds?: string[];
};

async function buildAdditionalPersonaKgContext(personaIds: string[]): Promise<string> {
  const uniquePersonaIds = Array.from(new Set(personaIds.filter(Boolean)));
  if (uniquePersonaIds.length === 0) return "";

  const contexts = await Promise.all(
    uniquePersonaIds.map(async (personaId) => {
      const contextBlock = await buildPersonaKgContext(personaId);
      if (!contextBlock) return null;
      return { personaId, contextBlock };
    }),
  );

  const nonEmpty = contexts.filter(
    (entry): entry is { personaId: string; contextBlock: string } => Boolean(entry?.contextBlock),
  );
  if (nonEmpty.length === 0) return "";

  return `\n## Additional Persona Knowledge Graphs\n${nonEmpty
    .map((entry) => `### Persona ${entry.personaId}\n${entry.contextBlock.trim()}`)
    .join("\n\n")}\n`;
}

export async function buildAutobotSystemPrompt(
  userId: string,
  options?: BuildAutobotPromptOptions,
): Promise<string> {
  const config = getInstanceConfig();
  const promptActorId = options?.promptActorId ?? userId;
  const explicitActivePersonaId = options?.activePersonaId ?? null;
  const explicitActivePersonaName = options?.activePersonaName?.trim() || null;
  const includedPersonaKgIds = Array.from(
    new Set((options?.includedPersonaKgIds ?? []).filter((personaId) => personaId && personaId !== explicitActivePersonaId)),
  );

  // Load soul identity document and user context in parallel
  const [
    soul,
    profileData,
    postsData,
    events,
    groups,
    connections,
    marketplaceListings,
    savedListingIds,
    walletResult,
  ] = await Promise.all([
    resolveAutobotSoulContent(promptActorId),
    fetchProfileData(userId).catch(() => null),
    fetchUserPosts(userId, 20).catch(() => ({ posts: [] as SerializedResource[], owner: null })),
    fetchUserEvents(userId, 20).catch(() => [] as SerializedAgent[]),
    fetchUserGroups(userId, 30).catch(() => [] as SerializedAgent[]),
    fetchUserConnections(userId).catch(() => [] as SerializedAgent[]),
    fetchMarketplaceListings(30).catch(() => [] as SerializedResource[]),
    fetchMySavedListingIds().catch(() => [] as string[]),
    getMyWalletAction().catch(() => ({ success: false as const })),
  ]);

  // Extract profile details
  const agent = profileData?.agent;
  const meta = ((agent?.metadata ?? {}) as Record<string, unknown>);
  const userName = agent?.name ?? "User";
  const username = (meta.username as string) ?? "";
  const bio = (meta.bio as string) ?? "";
  const skills = Array.isArray(meta.skills) ? (meta.skills as string[]).join(", ") : "";
  const location = (meta.location as string) ?? "";
  const tagline = (meta.tagline as string) ?? "";

  // Format groups
  const groupSummary = groups.length > 0
    ? groups.map((g) => {
        const gMeta = (g.metadata ?? {}) as Record<string, unknown>;
        const role = Array.isArray(gMeta.adminIds) && (gMeta.adminIds as string[]).includes(userId)
          ? "admin"
          : Array.isArray(gMeta.creatorId) || gMeta.creatorId === userId
            ? "creator"
            : "member";
        return `- ${g.name} (id: ${g.id}, role: ${role})`;
      }).join("\n")
    : "No groups.";

  // Format recent posts
  const postSummary = postsData.posts.length > 0
    ? postsData.posts.slice(0, 15).map(summarizeResource).join("\n")
    : "No recent posts.";

  // Format events
  const eventSummary = events.length > 0
    ? events.slice(0, 10).map(summarizeAgent).join("\n")
    : "No upcoming events.";

  // Format connections
  const connectionSummary = connections.length > 0
    ? `${connections.length} connections: ${connections.slice(0, 10).map((c) => c.name).join(", ")}${connections.length > 10 ? "..." : ""}`
    : "No connections.";

  // Format marketplace
  const marketplaceSummary = (marketplaceListings as SerializedResource[]).length > 0
    ? (marketplaceListings as SerializedResource[]).slice(0, 10).map(summarizeResource).join("\n")
    : "No marketplace listings.";

  // Format wallet
  const walletInfo = (walletResult as Record<string, unknown>).success
    ? safeStringify((walletResult as Record<string, unknown>).wallet ?? {}, 500)
    : "Wallet unavailable.";

  // Tool definitions
  const toolDefs = formatToolDefinitions();
  const additionalPersonaKgContext = includedPersonaKgIds.length > 0
    ? await buildAdditionalPersonaKgContext(includedPersonaKgIds)
    : "";
  const activePersonaHeader = explicitActivePersonaId
    ? `\n## Active Persona\nYou are currently operating as persona "${explicitActivePersonaName ?? explicitActivePersonaId}" (id: ${explicitActivePersonaId}). All KG operations should default to this persona's scope.\n`
    : "";
  const activePersonaKgContext = explicitActivePersonaId
    ? await buildPersonaKgContext(explicitActivePersonaId)
    : "";

  // Build the prompt — soul identity first, then structured context
  return `${soul.content}

---

# Operational Context — Rivr Instance Data

You are operating as the personal agent for ${userName} on their Rivr sovereign instance.

## Instance Context
- Instance: ${config.instanceSlug} (${config.instanceType})
- Instance ID: ${config.instanceId}
- Base URL: ${config.baseUrl}

## User Profile
- Name: ${userName}
- Username: ${username}
- Bio: ${bio}
- Tagline: ${tagline}
- Skills: ${skills || "None listed"}
- Location: ${location || "Not set"}
- User ID: ${userId}

## Group Memberships
${groupSummary}

## Recent Posts (${postsData.posts.length} total)
${postSummary}

## Events
${eventSummary}

## Connections
${connectionSummary}

## Marketplace Listings (visible to user)
${marketplaceSummary}

## Saved Listings
${savedListingIds.length > 0 ? savedListingIds.join(", ") : "None saved."}

## Wallet
${walletInfo}

## Available MCP Tools
${toolDefs}

## Behavioral Guidelines

### CRITICAL: Preview Before Execute
You must NEVER auto-execute any action. When the user asks you to create, update, or modify anything:
1. Draft the action with all parameters.
2. Present a preview using the tool-preview format (see below).
3. Wait for the user to confirm before executing.
4. Only execute when the user explicitly says "yes", "confirm", "do it", "go ahead", "post it", "send it", etc.

### Multi-Hop Reasoning
When the user makes a request, think through the full context:
- If they say "post my bike for sale", check their offerings/resources for bike-related items, identify relevant groups (marketplace, bikers, local chapter), suggest a price if context exists, and draft a proper marketplace listing.
- If they mention a group by partial name, match it to their actual group memberships.
- If they want to create an event, check what groups they could host it in and suggest appropriate ones.
- Always consider: What do they likely MEAN, not just what they literally said?

### Response Format
For normal conversation, respond naturally in markdown.

When you want to propose a tool action, use EXACTLY this format in your response:

\`\`\`tool-preview:<tool_name>
{
  "param1": "value1",
  "param2": "value2"
}
\`\`\`

For example, to propose creating a marketplace post:

\`\`\`tool-preview:rivr.posts.create
{
  "title": "Trek Mountain Bike - $500",
  "content": "Selling my Trek mountain bike, great condition. Perfect for trail riding in Boulder. Asking $500 OBO.",
  "postType": "marketplace",
  "groupId": "some-group-id-here",
  "isGlobal": true
}
\`\`\`

The user will see this as a formatted preview card with Confirm/Edit buttons.

### When User Confirms
When the user confirms (responds with "yes", "do it", "post it", "confirm", "go ahead", "looks good", etc.), the system will detect the confirmation and execute the tool. You should then report the result.

### When User Wants Changes
If the user asks for modifications ("change the price to $420", "make it 24 hours", "post it in bikers group too"), update the preview and show a new tool-preview block with the adjusted parameters.

### Tone and Style
- Be concise but helpful.
- Use markdown formatting for readability.
- Show enthusiasm for the user's activities.
- When suggesting, explain your reasoning briefly ("I see you're in the Boulder Bikers group, which would be a great place to list this").
- If you're unsure about something, ask rather than guess.
${activePersonaHeader}${activePersonaKgContext}${additionalPersonaKgContext}`;
}

// ---------------------------------------------------------------------------
// Constants for persona KG context
// ---------------------------------------------------------------------------

const PERSONA_KG_MAX_CONTEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Persona KG Context Builder
// ---------------------------------------------------------------------------

/**
 * Builds a KG context block for a specific persona scope.
 * Returns an empty string if no KG data exists or the fetch fails.
 */
export async function buildPersonaKgContext(personaId: string): Promise<string> {
  try {
    const { context } = await kgClient.buildContext("persona", personaId, PERSONA_KG_MAX_CONTEXT_CHARS);
    if (!context || context.length === 0) return "";

    return `\n## Persona Knowledge Graph\nThe following facts are from this persona's scoped knowledge graph. Use them to inform your responses:\n\n${context}\n`;
  } catch {
    return "";
  }
}

/**
 * Builds a full autobot system prompt that includes persona-specific KG context.
 * Use this when the chat is happening in the context of a specific persona.
 *
 * @param userId - The parent account user ID
 * @param personaId - The persona ID whose KG context should be injected
 * @param personaName - The persona's display name
 */
export async function buildAutobotSystemPromptWithPersonaKg(
  userId: string,
  personaId: string,
  personaName: string,
): Promise<string> {
  return buildAutobotSystemPrompt(userId, {
    promptActorId: personaId,
    activePersonaId: personaId,
    activePersonaName: personaName,
  });
}
