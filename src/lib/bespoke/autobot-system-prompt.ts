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
import { getGroupMembershipRolesForUser } from "@/lib/queries/agents";
import * as kgClient from "@/lib/kg/autobot-kg-client";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { readAgentSoul } from "@/lib/agent-docs";
import { discoverAgentProjects, loadWorkspaceRegistry } from "@/lib/agent-hq";
import type { AgentWorkspace } from "@/lib/agent-hq";
import { BUILDER_CAPABILITIES_BLOCK } from "@/lib/bespoke/builder-system-prompt";
import type { SiteFiles } from "@/lib/bespoke/site-files";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";

// ---------------------------------------------------------------------------
// Soul — Core Identity Document
// ---------------------------------------------------------------------------

let _instanceSoulContent: string | null = null;
let _instanceSoulSource: "instance" | "fallback" | null = null;

export type AutobotSoulSource = "custom" | "agent" | "instance" | "fallback";

/**
 * Load the instance-level soul.md (not agent-specific).
 * Cached after first successful load.
 */
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

/**
 * Load soul content with the full priority chain:
 * 1. User-configured custom soul.md (from DB settings)
 * 2. SOUL_MD_PATH env var
 * 3. /workspace/agents/{actorId}/soul.md (agent-specific on-disk soul)
 * 4. persona/soul.md in cwd
 * 5. ../Autobot/persona/soul.md (dev fallback)
 * 6. Embedded fallback constant
 */
export async function resolveAutobotSoulContent(
  actorId: string,
): Promise<{ content: string; source: AutobotSoulSource }> {
  // 1. Check user-configured custom soul.md in DB
  const settings = await getAutobotUserSettings(actorId).catch(() => null);
  const customSoulMd = settings?.customSoulMd?.trim() ?? "";
  if (customSoulMd) {
    return { content: customSoulMd, source: "custom" };
  }

  // 2. Check SOUL_MD_PATH env var (handled inside loadInstanceSoulContent)
  // But first, check agent-specific on-disk soul before the instance fallbacks.
  // We only do this if actorId is provided and not empty.
  if (actorId) {
    const agentSoulContent = await readAgentSoul(actorId);
    if (agentSoulContent && agentSoulContent.trim()) {
      return { content: agentSoulContent.trim(), source: "agent" };
    }
  }

  // 3-6. Instance-level chain (env, cwd persona, Autobot dev, embedded fallback)
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

/** Max chars of build-session file contents to inline into the prompt. */
const MAX_SITE_FILES_CHARS = 12_000;

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
// Builder context formatters (apps filesystem + active build session)
// ---------------------------------------------------------------------------

function summarizeWorkspace(workspace: AgentWorkspace): string {
  const parts = [`- ${workspace.label} (id: ${workspace.id}, scope: ${workspace.scope})`];
  if (workspace.packageName) parts.push(`  package: ${workspace.packageName}`);
  if (workspace.liveSubdomain) parts.push(`  live: ${workspace.liveSubdomain}`);
  if (workspace.description) parts.push(`  ${workspace.description.slice(0, 140)}`);
  return parts.join("\n");
}

/**
 * Builds the apps-filesystem summary block: the discovered agent workspaces
 * (foundation / app / shared) the assistant can build into. Falls back to the
 * persisted workspace registry when live discovery fails (e.g. shared instances
 * without host access). Returns an empty string when nothing is available.
 */
async function buildWorkspaceSummary(): Promise<string> {
  let workspaces: AgentWorkspace[] = [];
  try {
    workspaces = await discoverAgentProjects();
  } catch {
    try {
      workspaces = (await loadWorkspaceRegistry()).workspaces;
    } catch {
      workspaces = [];
    }
  }

  if (workspaces.length === 0) return "";

  return `\n## App Workspaces (filesystem)\nYou can build and edit files in these workspaces. Use the builder capabilities below to author site/app files for them:\n${workspaces
    .map(summarizeWorkspace)
    .join("\n")}\n`;
}

/**
 * Builds the active build-session block: a listing of the current site files,
 * with contents inlined up to a char budget (large files are noted but elided).
 * Returns an empty string when no build session files are provided.
 */
function buildSiteFilesContext(siteFiles: SiteFiles | undefined): string {
  if (!siteFiles) return "";
  const fileNames = Object.keys(siteFiles);
  if (fileNames.length === 0) return "";

  let body = "";
  let totalChars = 0;
  for (const name of fileNames) {
    const content = siteFiles[name] ?? "";
    const header = `### ${name}\n\`\`\`\n`;
    const footer = "\n```\n\n";
    if (totalChars + header.length + content.length + footer.length > MAX_SITE_FILES_CHARS) {
      body += `### ${name}\n(content omitted — ${content.length} characters)\n\n`;
      continue;
    }
    body += header + content + footer;
    totalChars += header.length + content.length + footer.length;
  }

  return `\n## Active Build Session (${fileNames.length} files)\nA site build is in progress. These are the current files — when the user asks for changes, output the COMPLETE updated files using the builder output format:\n\n${body}`;
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
  /**
   * The current site files of an active build session. When provided, the
   * prompt inlines them and folds in builder capabilities so the one assistant
   * can both converse and build. Omit for a pure-chat turn.
   */
  buildSessionFiles?: SiteFiles;
  /**
   * Whether to include the apps-filesystem workspace summary + builder
   * capabilities in the prompt. Defaults to `true` so the unified assistant
   * always knows it can build; set `false` only for narrow chat-only callers.
   */
  includeBuilderContext?: boolean;
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
  const includeBuilderContext = options?.includeBuilderContext ?? true;

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
    fetchProfileData(userId, userId).catch(() => null),
    fetchUserPosts(userId, 20, userId).catch(() => ({ posts: [] as SerializedResource[], owner: null })),
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
  const groupMembershipRoles = await getGroupMembershipRolesForUser(
    userId,
    groups.map((group) => group.id),
  ).catch(() => new Map<string, string>());
  const groupSummary = groups.length > 0
    ? groups.map((g) => {
        const gMeta = (g.metadata ?? {}) as Record<string, unknown>;
        const ledgerRole = groupMembershipRoles.get(g.id);
        const isPrimeAgent = gMeta.creatorId === userId;
        const isAdmin =
          (Array.isArray(gMeta.adminIds) && (gMeta.adminIds as string[]).includes(userId)) ||
          ledgerRole === "admin" ||
          ledgerRole === "creator";
        const role = isPrimeAgent && isAdmin
          ? "prime agent and admin"
          : isPrimeAgent
            ? "prime agent"
            : isAdmin
              ? "admin"
              : ledgerRole ?? "member";
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

  // Person-scope KG context — includes data ingested from connector syncs
  // (Notion docs, Google Docs, Slack threads, etc.) plus any manually
  // ingested documents. This gives the autobot access to the user's
  // external knowledge alongside their Rivr data.
  const personKgContext = await buildPersonKgContext(promptActorId);

  // Builder context — the apps filesystem the assistant can build into, plus the
  // current build-session files (if any), plus the shared builder capabilities.
  // This folds the dedicated builder prompt into the one assistant prompt so a
  // single agent drives both chat and building.
  const workspaceSummary = includeBuilderContext ? await buildWorkspaceSummary() : "";
  const siteFilesContext = buildSiteFilesContext(options?.buildSessionFiles);
  const builderContext = includeBuilderContext
    ? `\n---\n\n# Builder Context\n${workspaceSummary}${siteFilesContext}\n${BUILDER_CAPABILITIES_BLOCK}\n`
    : siteFilesContext;

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

### CRITICAL: You have REAL tools — call them. Never fake an execution.
You have real, executable tools in this session (rivr.posts.create, rivr.events.create, rivr.offerings.create, rivr.places.list, etc.). When you decide to act, you INVOKE the tool directly through your tool-calling capability and you get a real result back. There is no separate "confirm card" — typing a fenced \`tool-preview\` block does NOTHING and is forbidden. Acting means actually calling the tool.

How to handle a write request (create/post/update):
1. Resolve required parameters FIRST using read-only tools. For a post scoped to a place ("post on the Boulder locale"), call rivr.places.list to resolve the place NAME to its id, then pass it as localeId (and/or regionId). To post AS a group the user administers ("as Regen Hub"), pass ownerId = that group's agent id. Keep isGlobal: true so it federates to the global instance.
2. Confirmation: if the user has ALREADY told you to post/do it (including a draft they approved, or a follow-up "yes"/"confirm"/"post it"/"do it"/"send it"), CALL THE TOOL NOW. Do not ask again, do not wait for anything — you are the thing that executes. If the request is ambiguous or potentially destructive (delete), show the draft/params and ask once; on their approval, immediately call the tool.
3. Report only the REAL outcome. You have performed a write ONLY after the tool returns a success result. Then report it factually and include the returned id/url. If the tool returns an error, say so and show the error. NEVER say "Done", "Posted", "Created", "Sent", or imply success unless a tool actually returned success — fabricating completion is a critical failure.

Read-only tools (rivr.places.list, rivr.instance.get_context, rivr.profile.get_my_profile, rivr.personas.list) may be called freely at any time to gather ids/context.

### Multi-Hop Reasoning
When the user makes a request, think through the full context, then ACT with the real tools:
- If they say "post my bike for sale", check their offerings/resources for bike-related items, identify the relevant group/marketplace, then call rivr.posts.create / rivr.offerings.create.
- If they mention a group or place by partial name, resolve it (rivr.places.list / context) to the real id before calling the write tool.
- Always consider: What do they likely MEAN, not just what they literally said — then do it.

### Response Format
For normal conversation, respond naturally in markdown. To take an action, call the tool — do not describe calling it, actually call it. After the tool result comes back, summarize what happened (including the created post's id/url) in plain language.

### When User Wants Changes
If the user asks for modifications ("change the price to $420", "make it 24 hours", "scope it to Denver too") BEFORE you've executed, adjust the parameters and, once they approve, call the tool with the updated values. If they want changes AFTER a successful post, use the appropriate update/delete tool.

### Tone and Style
- Be concise but helpful.
- Use markdown formatting for readability.
- Show enthusiasm for the user's activities.
- When suggesting, explain your reasoning briefly ("I see you're in the Boulder Bikers group, which would be a great place to list this").
- If you're unsure about something, ask rather than guess.
${personKgContext}${activePersonaHeader}${activePersonaKgContext}${additionalPersonaKgContext}${builderContext}`;
}

// ---------------------------------------------------------------------------
// Constants for persona KG context
// ---------------------------------------------------------------------------

const PERSONA_KG_MAX_CONTEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Persona KG Context Builder
// ---------------------------------------------------------------------------

/**
 * Builds a KG context block for the person's own scope.
 * Includes triples extracted from connector-synced documents (Notion, Google Docs,
 * Slack, etc.) and any manually ingested content.
 * Returns an empty string if no KG data exists or the fetch fails.
 */
async function buildPersonKgContext(actorId: string): Promise<string> {
  try {
    const { context } = await kgClient.buildContext("person", actorId, PERSONA_KG_MAX_CONTEXT_CHARS);
    if (!context || context.length === 0) return "";

    return `\n## Personal Knowledge Graph\nThe following facts are from your synced external data and ingested documents. Use them to inform your responses:\n\n${context}\n`;
  } catch {
    return "";
  }
}

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
