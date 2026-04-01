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
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";

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

export async function buildAutobotSystemPrompt(userId: string): Promise<string> {
  const config = getInstanceConfig();

  // Fetch all user context in parallel — each fetch is fault-tolerant
  const [
    profileData,
    postsData,
    events,
    groups,
    connections,
    marketplaceListings,
    savedListingIds,
    walletResult,
  ] = await Promise.all([
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

  // Build the prompt
  return `You are the personal AI assistant for ${userName} on their Rivr sovereign instance.

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
`;
}
