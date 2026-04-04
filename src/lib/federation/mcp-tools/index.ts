import { getAllSubscriptionStatusesAction } from "@/app/actions/billing";
import {
  setEventRsvp,
  appendEventTranscriptAction,
} from "@/app/actions/interactions/events-jobs";
import { sendThanksTokensAction } from "@/app/actions/interactions/thanks-tokens";
import { toggleJoinGroup } from "@/app/actions/interactions/social";
import { updateMyProfile } from "@/app/actions/interactions/profile";
import { createPostResource } from "@/app/actions/resource-creation/posts";
import {
  fetchMarketplaceListings,
  fetchMyReceipts,
  fetchMySavedListingIds,
  fetchProfileData,
  fetchReactionCountsForUser,
  fetchUserConnections,
  fetchUserEvents,
  fetchUserGroups,
  fetchUserPosts,
} from "@/app/actions/graph";
import {
  getMyTicketPurchasesAction,
  getMyWalletAction,
  getMyWalletsAction,
  getTransactionHistoryAction,
} from "@/app/actions/wallet";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import * as kg from "@/lib/kg/autobot-kg-client";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { getMyProfileModuleManifest } from "@/lib/bespoke/modules/myprofile";
import { getProvenanceLog } from "@/lib/federation/mcp-provenance";
import { serializeAgent } from "@/lib/graph-serializers";
import { and, eq, isNull } from "drizzle-orm";

export type McpToolCallContext = {
  actorId: string;
  controllerId?: string;
  actorType: "human" | "persona" | "autobot";
  authMode: "session" | "token";
};

export type McpToolResult = unknown;

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabledFor: Array<"session" | "token">;
  handler: (args: Record<string, unknown>, context: McpToolCallContext) => Promise<McpToolResult>;
};

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getLocation(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lat = typeof (value as { lat?: unknown }).lat === "number" ? (value as { lat: number }).lat : null;
  const lng = typeof (value as { lng?: unknown }).lng === "number" ? (value as { lng: number }).lng : null;
  return lat !== null && lng !== null ? { lat, lng } : null;
}

async function buildMyProfileBundle(actorId: string) {
  const [profile, savedListingIds, wallet, wallets, transactions, ticketPurchases, subscriptions, receipts, posts, events, groups, marketplaceListings, reactionCounts, connections, homeInstance] = await Promise.all([
    fetchProfileData(actorId).catch(() => null),
    fetchMySavedListingIds().catch(() => [] as string[]),
    getMyWalletAction().catch(() => ({ success: false as const })),
    getMyWalletsAction().catch(() => ({ success: false as const })),
    getTransactionHistoryAction({ limit: 30 }).catch(() => ({ success: false as const })),
    getMyTicketPurchasesAction().catch(() => ({ success: false as const })),
    getAllSubscriptionStatusesAction().catch(() => []),
    fetchMyReceipts().catch(() => ({ receipts: [] })),
    fetchUserPosts(actorId, 30).catch(() => ({ posts: [], owner: null })),
    fetchUserEvents(actorId, 30).catch(() => []),
    fetchUserGroups(actorId, 30).catch(() => []),
    fetchMarketplaceListings(50).catch(() => []),
    fetchReactionCountsForUser(actorId).catch(() => ({})),
    fetchUserConnections(actorId).catch(() => []),
    resolveHomeInstance(actorId).catch(() => null),
  ]);

  const config = getInstanceConfig();

  return {
    actorId,
    profile,
    savedListingIds,
    wallet,
    wallets,
    transactions,
    ticketPurchases,
    subscriptions,
    receipts,
    posts,
    events,
    groups,
    marketplaceListings,
    reactionCounts,
    connections,
    module: {
      manifest: getMyProfileModuleManifest(),
      manifestEndpoint: "/api/myprofile/manifest",
      dataEndpoint: "/api/myprofile",
    },
    federation: {
      localInstanceId: config.instanceId,
      localInstanceType: config.instanceType,
      localInstanceSlug: config.instanceSlug,
      homeInstance,
      isHomeInstance: homeInstance ? homeInstance.nodeId === config.instanceId : true,
    },
  };
}

async function listPersonasForController(context: McpToolCallContext) {
  const controllerId = context.controllerId ?? context.actorId;

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, controllerId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(agents.createdAt);

  const activePersona =
    context.actorType === "persona"
      ? rows.find((row) => row.id === context.actorId) ?? null
      : null;

  return {
    success: true,
    personas: rows.map((row) => serializeAgent(row)),
    activePersonaId: activePersona?.id ?? null,
    activePersona: activePersona ? serializeAgent(activePersona) : null,
  };
}

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "rivr.instance.get_context",
    description: "Return the local Rivr instance identity and the authenticated actor context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async (_args, context) => {
      const config = getInstanceConfig();
      const homeInstance = await resolveHomeInstance(context.actorId).catch(() => null);
      return {
        actorId: context.actorId,
        controllerId: context.controllerId ?? null,
        actorType: context.actorType,
        authMode: context.authMode,
        instance: config,
        homeInstance,
      };
    },
  },
  {
    name: "rivr.personas.list",
    description: "List personas owned by the current controller and return the active persona.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async (_args, context) => listPersonasForController(context),
  },
  {
    name: "rivr.profile.get_my_profile",
    description: "Return the authenticated actor's myprofile bundle plus the bespoke module manifest.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async (_args, context) => buildMyProfileBundle(context.actorId),
  },
  {
    name: "rivr.profile.update_basic",
    description: "Update the active actor's basic profile fields.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "bio", "skills"],
      properties: {
        name: { type: "string" },
        bio: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        location: { type: "string" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const name = getString(args.name);
      const bio = getString(args.bio);
      const skills = getStringArray(args.skills);

      if (!name || !bio) {
        throw new Error("name and bio are required.");
      }

      return updateMyProfile({
        name,
        bio,
        skills,
        location: getString(args.location) ?? undefined,
      });
    },
  },
  {
    name: "rivr.posts.create",
    description: "Create a post as the active actor or into a group where the actor has write access.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        postType: { type: "string" },
        groupId: { type: "string" },
        localeId: { type: "string" },
        imageUrl: { type: "string" },
        isGlobal: { type: "boolean" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const content = getString(args.content);
      if (!content) {
        throw new Error("content is required.");
      }

      return createPostResource({
        title: getString(args.title) ?? undefined,
        content,
        postType: getString(args.postType) ?? "social",
        groupId: getString(args.groupId) ?? undefined,
        localeId: getString(args.localeId) ?? undefined,
        imageUrl: getString(args.imageUrl),
        isGlobal: getBoolean(args.isGlobal, true),
      });
    },
  },
  {
    name: "rivr.posts.create_live_invite",
    description: "Create a live invite post. For group-scoped invites, this also creates the linked meeting event and transcript document.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content", "groupId", "liveLocation"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        groupId: { type: "string" },
        localeId: { type: "string" },
        isGlobal: { type: "boolean" },
        scopedLocaleIds: { type: "array", items: { type: "string" } },
        scopedGroupIds: { type: "array", items: { type: "string" } },
        scopedUserIds: { type: "array", items: { type: "string" } },
        liveLocation: {
          type: "object",
          properties: {
            lat: { type: "number" },
            lng: { type: "number" },
          },
          required: ["lat", "lng"],
          additionalProperties: false,
        },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const content = getString(args.content);
      const groupId = getString(args.groupId);
      const liveLocation = getLocation(args.liveLocation);
      if (!content || !groupId || !liveLocation) {
        throw new Error("content, groupId, and liveLocation are required.");
      }

      return createPostResource({
        title: getString(args.title) ?? undefined,
        content,
        postType: "social",
        groupId,
        localeId: getString(args.localeId) ?? undefined,
        isLiveInvitation: true,
        liveLocation,
        isGlobal: getBoolean(args.isGlobal, true),
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedGroupIds: getStringArray(args.scopedGroupIds),
        scopedUserIds: getStringArray(args.scopedUserIds),
      });
    },
  },
  {
    name: "rivr.groups.join",
    description: "Join or leave a group or ring.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["groupId"],
      properties: {
        groupId: { type: "string" },
        type: { type: "string", enum: ["group", "ring"] },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const groupId = getString(args.groupId);
      if (!groupId) {
        throw new Error("groupId is required.");
      }
      const type = getString(args.type) === "ring" ? "ring" : "group";
      return toggleJoinGroup(groupId, type);
    },
  },
  {
    name: "rivr.events.rsvp",
    description: "Set RSVP status for an event.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId", "status"],
      properties: {
        eventId: { type: "string" },
        status: { type: "string", enum: ["going", "interested", "none"] },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const eventId = getString(args.eventId);
      const status = getString(args.status);
      if (!eventId || (status !== "going" && status !== "interested" && status !== "none")) {
        throw new Error("eventId and a valid status are required.");
      }
      return setEventRsvp(eventId, status);
    },
  },
  {
    name: "rivr.events.append_transcript",
    description: "Append a transcript segment into the linked meeting transcript document for an event.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId", "text"],
      properties: {
        eventId: { type: "string" },
        text: { type: "string" },
        speakerLabel: { type: "string" },
        source: { type: "string", enum: ["manual", "whisper", "whisper-gateway"] },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const eventId = getString(args.eventId);
      const text = getString(args.text);
      const source = getString(args.source);
      if (!eventId || !text) {
        throw new Error("eventId and text are required.");
      }

      return appendEventTranscriptAction({
        eventId,
        text,
        speakerLabel: getString(args.speakerLabel),
        source:
          source === "whisper" || source === "whisper-gateway" || source === "manual"
            ? source
            : undefined,
      });
    },
  },
  {
    name: "rivr.thanks.send",
    description: "Send one or more thanks tokens to another agent, optionally attaching a message or resource context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipientId", "count"],
      properties: {
        recipientId: { type: "string" },
        count: { type: "number", minimum: 1 },
        message: { type: "string" },
        contextId: { type: "string", description: "Optional resource or post the thanks relates to." },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const recipientId = getString(args.recipientId);
      const count =
        typeof args.count === "number" && Number.isFinite(args.count)
          ? Math.max(1, Math.floor(args.count))
          : 0;

      if (!recipientId || count <= 0) {
        throw new Error("recipientId and a positive count are required.");
      }

      return sendThanksTokensAction(
        recipientId,
        count,
        getString(args.message) ?? undefined,
        getString(args.contextId) ?? undefined,
      );
    },
  },
  {
    name: "rivr.kg.list_docs",
    description: "List knowledge graph documents for a scope. Defaults to the actor's scope (persona scope when acting as a persona).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_type: { type: "string", description: "Scope type (person, persona, group, event, project). Default: inferred from actor type" },
        scope_id: { type: "string", description: "Scope ID. Default: current actor ID" },
        status: { type: "string", description: "Filter by doc status (pending, ingesting, complete, failed)" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const defaultScopeType = context.actorType === "persona" ? "persona" : "person";
      const scopeType = getString(args.scope_type) ?? defaultScopeType;
      const scopeId = getString(args.scope_id) ?? context.actorId;
      const status = getString(args.status) ?? undefined;
      const docs = await kg.listDocs(scopeType, scopeId, status);
      return { success: true, docs, count: docs.length };
    },
  },
  {
    name: "rivr.kg.push_doc",
    description: "Push a Rivr resource into the knowledge graph for extraction. Creates a doc record and ingests its content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId"],
      properties: {
        resourceId: { type: "string", description: "ID of the Rivr resource to push" },
        scope_type: { type: "string", description: "Scope type. Default: inferred from actor type" },
        scope_id: { type: "string", description: "Scope ID. Default: current actor ID" },
        title: { type: "string", description: "Override title for the doc" },
        doc_type: { type: "string", description: "Doc type classification" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const resourceId = getString(args.resourceId);
      if (!resourceId) throw new Error("resourceId is required.");

      const resource = await db.query.resources.findFirst({
        where: eq(resources.id, resourceId),
      });
      if (!resource) throw new Error("Resource not found.");
      // For persona actors, check ownership against the controller (parent account)
      const ownerId = context.controllerId ?? context.actorId;
      if (resource.ownerId !== ownerId) throw new Error("Not your resource.");

      const defaultScopeType = context.actorType === "persona" ? "persona" : "person";
      const scopeType = getString(args.scope_type) ?? defaultScopeType;
      const scopeId = getString(args.scope_id) ?? context.actorId;

      const doc = await kg.createDoc({
        title: getString(args.title) ?? resource.name ?? "Untitled",
        doc_type: getString(args.doc_type) ?? resource.type ?? "resource",
        scope_type: scopeType,
        scope_id: scopeId,
        source_uri: `rivr://person/resources/${resource.id}`,
      });

      const content = resource.content || "";
      if (!content) {
        return { success: true, doc, ingested: false, reason: "Resource has no content to ingest" };
      }

      const result = await kg.ingestDoc(doc.id, content, undefined, doc.title);
      return { success: true, doc, ingested: true, ingestResult: result };
    },
  },
  {
    name: "rivr.kg.query",
    description: "Query the scoped knowledge graph subgraph. Returns triples (subject-predicate-object facts) from the KG.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_type: { type: "string", description: "Scope type. Default: inferred from actor type" },
        scope_id: { type: "string", description: "Scope ID. Default: current actor ID" },
        entity: { type: "string", description: "Filter triples by entity name" },
        predicate: { type: "string", description: "Filter triples by predicate type" },
        max_results: { type: "number", description: "Maximum number of triples to return" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const defaultScopeType = context.actorType === "persona" ? "persona" : "person";
      const scopeType = getString(args.scope_type) ?? defaultScopeType;
      const scopeId = getString(args.scope_id) ?? context.actorId;
      const result = await kg.queryScope(scopeType, scopeId, {
        entity: getString(args.entity) ?? undefined,
        predicate: getString(args.predicate) ?? undefined,
        max_results: typeof args.max_results === "number" ? args.max_results : undefined,
      });
      return { success: true, ...result };
    },
  },
  {
    name: "rivr.kg.chat",
    description: "Chat with knowledge graph context. Fetches relevant KG facts for the scope and uses them to inform the response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", description: "The user's message/question" },
        scope_type: { type: "string", description: "Scope type. Default: inferred from actor type" },
        scope_id: { type: "string", description: "Scope ID. Default: current actor ID" },
        max_context_chars: { type: "number", description: "Max chars of KG context to inject. Default: 3000" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const message = getString(args.message);
      if (!message) throw new Error("message is required.");

      const defaultScopeType = context.actorType === "persona" ? "persona" : "person";
      const scopeType = getString(args.scope_type) ?? defaultScopeType;
      const scopeId = getString(args.scope_id) ?? context.actorId;
      const maxChars = typeof args.max_context_chars === "number" ? args.max_context_chars : 3000;

      const { context: kgContext } = await kg.buildContext(scopeType, scopeId, maxChars);

      const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
      const kgSystemPrompt = kgContext
        ? `You have access to a knowledge graph for this ${scopeType}. Use these facts to inform your answers:\n\n${kgContext}\n\n`
        : "";

      const openclawRes = await fetch(`${OPENCLAW_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: context.actorId,
          message: `${kgSystemPrompt}User question: ${message}`,
          history: [],
          channel: `kg-chat:${scopeType}:${scopeId}`,
        }),
      });

      if (!openclawRes.ok) {
        const errText = await openclawRes.text();
        throw new Error(`OpenClaw error: ${openclawRes.status} — ${errText}`);
      }

      const data = await openclawRes.json();
      return {
        success: true,
        ...data,
        kg_context_length: kgContext.length,
        scope: { type: scopeType, id: scopeId },
      };
    },
  },
  {
    name: "rivr.audit.recent",
    description: "Return recent MCP provenance log entries. Useful for reviewing autobot activity and debugging.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolName: { type: "string", description: "Filter by tool name" },
        actorType: { type: "string", enum: ["human", "persona", "autobot"] },
        resultStatus: { type: "string", enum: ["success", "error"] },
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const entries = await getProvenanceLog({
        toolName: getString(args.toolName) ?? undefined,
        actorType: getString(args.actorType) as "human" | "persona" | "autobot" | undefined,
        resultStatus: getString(args.resultStatus) as "success" | "error" | undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return { success: true, entries, count: entries.length };
    },
  },
];

export function listMcpToolsForMode(mode: "session" | "token") {
  return MCP_TOOL_DEFINITIONS.filter((tool) => tool.enabledFor.includes(mode)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function getMcpToolDefinition(name: string) {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}
