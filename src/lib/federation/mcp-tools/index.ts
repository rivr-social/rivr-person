import { getAllSubscriptionStatusesAction } from "@/app/actions/billing";
import {
  getActivePersonaInfo,
  listMyPersonas,
} from "@/app/actions/personas";
import {
  setEventRsvp,
  appendEventTranscriptAction,
} from "@/app/actions/interactions/events-jobs";
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
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { getMyProfileModuleManifest } from "@/lib/bespoke/modules/myprofile";

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
    handler: async () => {
      const [personas, activePersona] = await Promise.all([
        listMyPersonas(),
        getActivePersonaInfo(),
      ]);

      return { personas, activePersona };
    },
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
