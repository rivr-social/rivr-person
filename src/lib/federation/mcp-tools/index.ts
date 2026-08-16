import { getAllSubscriptionStatusesAction } from "@/app/actions/billing";
import {
  setEventRsvp,
  appendEventTranscriptAction,
} from "@/app/actions/interactions/events-jobs";
import { sendThanksTokensAction } from "@/app/actions/interactions/thanks-tokens";
import { toggleJoinGroup } from "@/app/actions/interactions/social";
import { updateMyProfile } from "@/app/actions/interactions/profile";
import { createPostResource } from "@/app/actions/resource-creation/posts";
import { deleteResource, updateResource } from "@/app/actions/resource-creation/lifecycle";
import type { UpdateResourceInput } from "@/app/actions/resource-creation/types";
import { dollarsToCents } from "@/app/actions/resource-creation/types";
import { createEventResource } from "@/app/actions/resource-creation/events";
import { createOfferingResource } from "@/app/actions/resource-creation/offerings";
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
import { getPlacesByPlaceType } from "@/lib/queries/agents";
import { GLOBAL_BASE_URL } from "@/lib/global-base-url";
import * as kg from "@/lib/kg/autobot-kg-client";
import { nativeCloudChat, DEFAULT_MODEL } from "@/lib/ai/native-chat";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { getMyProfileModuleManifest } from "@/lib/bespoke/modules/myprofile";
import { getProvenanceLog } from "@/lib/federation/mcp-provenance";
import { serializeAgent } from "@/lib/graph-serializers";
import { and, eq, isNull } from "drizzle-orm";
import { getDeployCapability, type InstanceDeployCapability } from "@/lib/deploy/capability";
import { getAutobotSandbox, getSandboxSummary, isOperationAllowed } from "@/lib/autobot/isolation";
import {
  runConnectorSync,
  ConnectorSyncError,
  SYNCABLE_CONNECTOR_PROVIDERS,
} from "@/lib/autobot-connector-sync";
import type { PersonaContext } from "@/lib/federation/execution-context";

export type McpToolCallContext = {
  actorId: string;
  controllerId?: string;
  actorType: "human" | "persona" | "autobot";
  authMode: "session" | "token";
  personaContext?: PersonaContext;
};

export type McpToolResult = unknown;

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Auth modes this tool is reachable from.
   *
   * `"operator"` is a deliberately unreachable mode: no caller ever sets
   * `authMode: "operator"` on an {@link McpToolCallContext}, so a tool listed
   * only for `"operator"` is defined and typed but cannot be invoked from the
   * LLM tool loop or an MCP bearer. It is the parking place for host-mutating
   * deploy-class tools (PSN-CORE-001 layer 3).
   */
  enabledFor: Array<"session" | "token" | "operator">;
  handler: (args: Record<string, unknown>, context: McpToolCallContext) => Promise<McpToolResult>;
};

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Git ref grammar guard for arguments that reach a process spawn.
 *
 * Accepts only the characters git itself permits in a branch name that this
 * codebase ever uses, and rejects the shapes that turn a ref into an option or
 * a traversal: a leading `-` (would be parsed as a flag by `git checkout`), a
 * leading/trailing `/`, `..`, `@{`, and a trailing `.lock`.
 *
 * Paired with `execFileSync` (no shell), this is defense in depth rather than
 * the only barrier — see PSN-CORE-001.
 */
const GIT_REF_ALLOWED_CHARS = /^[A-Za-z0-9._\/-]+$/;
const GIT_REF_MAX_LENGTH = 255;

export function isValidGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > GIT_REF_MAX_LENGTH) return false;
  if (!GIT_REF_ALLOWED_CHARS.test(ref)) return false;
  if (ref.startsWith("-")) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("@{")) return false;
  if (ref.endsWith(".lock")) return false;
  if (ref.endsWith(".")) return false;
  return true;
}

/**
 * Docker compose service-name guard. Same contract as {@link isValidGitRef}:
 * the value is passed as an `execFileSync` argv element, never interpolated.
 */
/** Wall-clock ceiling for a git/compose control command spawned by a tool. */
const DEPLOY_COMMAND_TIMEOUT_MS = 30_000;
/** Docker image builds are allowed materially longer than a git fetch. */
const DOCKER_BUILD_TIMEOUT_MS = 300_000;
/** Truncation ceiling on command output returned to the caller. */
const DEPLOY_OUTPUT_MAX_CHARS = 2000;
/** Compose/systemd unit name of the autobot sidecar. */
const AUTOBOT_SIDECAR_SERVICE = "openclaw";

const DOCKER_SERVICE_ALLOWED = /^[A-Za-z0-9_-]+$/;
const DOCKER_SERVICE_MAX_LENGTH = 64;

export function isValidDockerServiceName(service: string): boolean {
  return (
    service.length > 0 &&
    service.length <= DOCKER_SERVICE_MAX_LENGTH &&
    DOCKER_SERVICE_ALLOWED.test(service) &&
    !service.startsWith("-")
  );
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Coerce a DOLLAR-denominated tool argument to the integer CENTS the resource
 * actions persist. Returns `undefined` when the caller omitted the field so the
 * action leaves the price unset rather than writing a `0` price.
 */
function getDollarsAsCents(value: unknown): number | undefined {
  const dollars = getNumber(value);
  return dollars === undefined ? undefined : dollarsToCents(dollars);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(getRecord(entry)))
    : [];
}

function getLocation(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lat = typeof (value as { lat?: unknown }).lat === "number" ? (value as { lat: number }).lat : null;
  const lng = typeof (value as { lng?: unknown }).lng === "number" ? (value as { lng: number }).lng : null;
  return lat !== null && lng !== null ? { lat, lng } : null;
}

async function buildMyProfileBundle(actorId: string) {
  const [profile, savedListingIds, wallet, wallets, transactions, ticketPurchases, subscriptions, receipts, posts, events, groups, marketplaceListings, reactionCounts, connections, homeInstance] = await Promise.all([
    fetchProfileData(actorId, actorId).catch(() => null),
    fetchMySavedListingIds().catch(() => [] as string[]),
    getMyWalletAction().catch(() => ({ success: false as const })),
    getMyWalletsAction().catch(() => ({ success: false as const })),
    getTransactionHistoryAction({ limit: 30 }).catch(() => ({ success: false as const })),
    getMyTicketPurchasesAction().catch(() => ({ success: false as const })),
    getAllSubscriptionStatusesAction().catch(() => []),
    fetchMyReceipts().catch(() => ({ receipts: [] })),
    fetchUserPosts(actorId, 30, actorId).catch(() => ({ posts: [], owner: null })),
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
    name: "rivr.places.list",
    description: "List the places (locales/chapters and regions/bioregions) that posts, events, and offerings can be scoped to. Call this to resolve a place NAME (e.g. \"Boulder\") to the canonical id you pass as localeId/regionId (or scopedLocaleIds/scopedRegionIds) on the create tools. The catalog is the federation-wide canonical directory served by the global instance (the same list the locale switcher shows), NOT just places that happen to live on this sovereign instance. Optionally filter by name substring (query) and/or restrict to a kind (placeType: \"locale\" or \"region\").",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring to match against place name." },
        placeType: { type: "string", enum: ["locale", "region", "all"], description: "Restrict to locales/chapters, regions/bioregions, or both (default)." },
        limit: { type: "number", description: "Max places per kind. Defaults to 50." },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const query = getString(args.query)?.trim().toLowerCase() ?? null;
      const placeType = getString(args.placeType) ?? "all";
      const limit = getNumber(args.limit) ?? 50;
      const wantLocales = placeType === "all" || placeType === "locale";
      const wantRegions = placeType === "all" || placeType === "region";
      const matches = (name: string) => !query || name.toLowerCase().includes(query);

      // The canonical place catalog (Boulder, Denver, the basins/regions, etc.)
      // lives on the GLOBAL instance, not in this sovereign instance's local DB
      // (ticket #109: the locale switcher reads the same global directory rather
      // than whatever happens to be projected locally). Fetch global's
      // /api/locales — it returns every chapter agent plus its parent basin,
      // from which we derive the region list. Fall back to the local place
      // agents if global is unreachable.
      type PlaceEntry = { id: string; name: string; kind: "locale" | "region"; slug: string | null; basinId?: string | null; basinName?: string | null };
      let locales: PlaceEntry[] = [];
      let regions: PlaceEntry[] = [];
      let source = "global";

      try {
        const res = await fetch(`${GLOBAL_BASE_URL}/api/locales`, { cache: "no-store" });
        if (!res.ok) throw new Error(`global /api/locales responded ${res.status}`);
        const data = (await res.json()) as {
          locales?: Array<Record<string, unknown>>;
        };
        const rows = Array.isArray(data.locales) ? data.locales : [];
        locales = rows.map((row) => ({
          id: String(row.id ?? row.slug ?? ""),
          name: String(row.name ?? row.slug ?? ""),
          kind: "locale" as const,
          slug: typeof row.slug === "string" ? row.slug : null,
          basinId: typeof row.basinId === "string" ? row.basinId : null,
          basinName: typeof row.basinName === "string" ? row.basinName : null,
        })).filter((p) => p.id);

        // Regions/basins are denormalized onto each locale row — dedupe them.
        const regionById = new Map<string, PlaceEntry>();
        for (const loc of locales) {
          if (loc.basinId && loc.basinName && !regionById.has(loc.basinId)) {
            regionById.set(loc.basinId, {
              id: loc.basinId,
              name: loc.basinName,
              kind: "region",
              slug: null,
            });
          }
        }
        regions = Array.from(regionById.values());
      } catch {
        // Global unreachable — degrade to whatever place agents this instance
        // has locally so the tool still returns something usable offline.
        source = "local";
        const toLocal = (kind: "locale" | "region") => (agent: { id: string; name: string; metadata?: Record<string, unknown> | null }) => {
          const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
          return {
            id: agent.id,
            name: agent.name,
            kind,
            slug:
              (metadata.slug as string | undefined) ??
              (metadata.username as string | undefined) ??
              null,
          } satisfies PlaceEntry;
        };
        const [localLocales, localRegions] = await Promise.all([
          getPlacesByPlaceType("locale", limit),
          getPlacesByPlaceType("region", limit),
        ]);
        locales = localLocales.map(toLocal("locale"));
        regions = localRegions.map(toLocal("region"));
      }

      return {
        source,
        locales: wantLocales ? locales.filter((p) => matches(p.name)).slice(0, limit) : [],
        regions: wantRegions ? regions.filter((p) => matches(p.name)).slice(0, limit) : [],
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
    description: "Create a post as the active actor, into a group where the actor has write access (groupId), or AS a group the actor administers (ownerId — the post is then owned by and homes on that group). Scope the post to a place by passing localeId (a locale/chapter) and/or regionId (a region/bioregion); use rivr.places.list to resolve a place name to its id. When isGlobal is true (default), the post is also federated to the configured registry so it surfaces on the global instance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        postType: { type: "string" },
        groupId: { type: "string" },
        ownerId: {
          type: "string",
          description: "Post AS this group (the actor must have write access). The post is owned by and homes on the group, rather than the actor surfacing their own post into it.",
        },
        localeId: {
          type: "string",
          description: "Scope the post to this locale/chapter (a place-typed agent id, e.g. \"Boulder\"). Resolve names to ids with rivr.places.list. Place-scoping makes the post discoverable in that locale's feed.",
        },
        regionId: {
          type: "string",
          description: "Scope the post to this region/bioregion (a place-typed agent id, e.g. a basin or front-range region). Resolve names to ids with rivr.places.list. May be combined with localeId.",
        },
        scopedLocaleIds: {
          type: "array",
          items: { type: "string" },
          description: "Scope the post to multiple locales/chapters at once (place-typed agent ids).",
        },
        scopedRegionIds: {
          type: "array",
          items: { type: "string" },
          description: "Scope the post to multiple regions/bioregions at once (place-typed agent ids).",
        },
        imageUrl: { type: "string" },
        isGlobal: { type: "boolean" },
        federate: { type: "boolean" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const content = getString(args.content);
      if (!content) {
        throw new Error("content is required.");
      }

      const isGlobal = getBoolean(args.isGlobal, true);

      // Extract URLs from the body so posts created via MCP get the same
      // rich embed rendering (X, YouTube, Vimeo, Spotify, SoundCloud) as
      // posts composed through the UI. Platform detection runs from the
      // URL alone at render time — no server-side scrape needed.
      const { extractUrls } = await import("@/lib/link-preview-client");
      const urls = extractUrls(content);
      const embeds = urls.map((url) => ({ url, kind: "link" as const }));

      return createPostResource({
        title: getString(args.title) ?? undefined,
        content,
        postType: getString(args.postType) ?? "social",
        groupId: getString(args.groupId) ?? undefined,
        ownerId: getString(args.ownerId) ?? undefined,
        localeId: getString(args.localeId) ?? undefined,
        regionId: getString(args.regionId) ?? undefined,
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedRegionIds: getStringArray(args.scopedRegionIds),
        imageUrl: getString(args.imageUrl),
        isGlobal,
        federate: getBoolean(args.federate, isGlobal),
        embeds,
      });
    },
  },
  {
    name: "rivr.posts.delete",
    description:
      "Soft-delete a resource (post/event/offering/etc.) the active actor owns, OR one owned by a group the actor administers — including groups homed on a PEER instance. Emits a resource.deleted federation event so peer instances clear the projection. When the resource is homed on a peer (e.g. a post owned by a group on its own sovereign instance), pass ownerId (the owning group/agent id) so the delete is routed to and authorized on that home instance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId"],
      properties: {
        resourceId: { type: "string" },
        ownerId: {
          type: "string",
          description:
            "The agent id that OWNS this resource (and whose instance HOMES it). Required when the resource is homed on a peer instance this instance keeps no local copy of — e.g. deleting a post owned by a group on the group's own sovereign instance. The home instance re-authorizes the actor's admin rights there.",
        },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const resourceId = getString(args.resourceId);
      if (!resourceId) {
        throw new Error("resourceId is required.");
      }
      const ownerId = getString(args.ownerId) ?? undefined;
      return deleteResource(resourceId, ownerId ? { targetAgentId: ownerId } : undefined);
    },
  },
  {
    name: "rivr.resources.update",
    description:
      "Update a resource (post/event/offering/project/etc.) the active actor owns, OR one owned by a group the actor administers — including groups homed on a PEER instance. Patch any of: name/title, description, content (post body), tags, visibility (public|locale|members|private), and metadata fields (metadataPatch is shallow-merged). When the resource is homed on a peer (e.g. owned by a group on its own sovereign instance), pass ownerId so the update is routed to and authorized on that home instance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId"],
      properties: {
        resourceId: { type: "string" },
        ownerId: {
          type: "string",
          description:
            "The agent id that OWNS this resource (and whose instance HOMES it). Required when the resource is homed on a peer instance this instance keeps no local copy of. The home instance re-authorizes the actor's admin rights there.",
        },
        name: { type: "string", description: "New name/title for the resource." },
        description: { type: "string", description: "New description." },
        content: { type: "string", description: "New body content (e.g. a post body)." },
        tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
        visibility: {
          type: "string",
          enum: ["public", "locale", "members", "private"],
          description: "New visibility level.",
        },
        metadataPatch: {
          type: "object",
          additionalProperties: true,
          description: "Metadata fields to shallow-merge into the resource's existing metadata.",
        },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const resourceId = getString(args.resourceId);
      if (!resourceId) {
        throw new Error("resourceId is required.");
      }
      const input: UpdateResourceInput = { resourceId };
      const ownerId = getString(args.ownerId);
      if (ownerId) input.targetAgentId = ownerId;
      // Only patch fields the caller actually provided (presence-checked on the
      // raw args), so an omitted field is never coerced to null/empty and the
      // existing value is preserved.
      if (args.name !== undefined) {
        const name = getString(args.name);
        if (name) input.name = name;
      }
      if (args.description !== undefined) {
        input.description = getString(args.description);
      }
      if (args.content !== undefined) {
        input.content = getString(args.content);
      }
      if (args.tags !== undefined) {
        input.tags = getStringArray(args.tags);
      }
      if (args.visibility !== undefined) {
        const visibility = getString(args.visibility);
        if (visibility) input.visibility = visibility as UpdateResourceInput["visibility"];
      }
      if (args.metadataPatch && typeof args.metadataPatch === "object" && !Array.isArray(args.metadataPatch)) {
        input.metadataPatch = args.metadataPatch as Record<string, unknown>;
      }
      return updateResource(input);
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
        localeId: {
          type: "string",
          description: "Scope the invite to this locale/chapter (a place-typed agent id). Resolve names to ids with rivr.places.list.",
        },
        regionId: {
          type: "string",
          description: "Scope the invite to this region/bioregion (a place-typed agent id). Resolve names to ids with rivr.places.list.",
        },
        isGlobal: { type: "boolean" },
        scopedLocaleIds: { type: "array", items: { type: "string" }, description: "Scope to multiple locales/chapters (place-typed agent ids)." },
        scopedRegionIds: { type: "array", items: { type: "string" }, description: "Scope to multiple regions/bioregions (place-typed agent ids)." },
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
        regionId: getString(args.regionId) ?? undefined,
        isLiveInvitation: true,
        liveLocation,
        isGlobal: getBoolean(args.isGlobal, true),
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedRegionIds: getStringArray(args.scopedRegionIds),
        scopedGroupIds: getStringArray(args.scopedGroupIds),
        scopedUserIds: getStringArray(args.scopedUserIds),
      });
    },
  },
  {
    name: "rivr.events.create",
    description: "Create an event as the active actor, or in a target group/locale/region. Scope the event to a place by passing localeId (a locale/chapter) and/or regionId (a region/bioregion); use rivr.places.list to resolve a place name to its id. If the group is homed on another Rivr instance, route the write to that instance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "date", "time", "location"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        date: { type: "string", description: "Event date, preferably YYYY-MM-DD." },
        time: { type: "string", description: "Event start time as display text or HH:mm." },
        location: { type: "string" },
        eventType: { type: "string", enum: ["in-person", "online"] },
        price: { type: "number" },
        imageUrl: { type: "string" },
        ownerId: { type: "string", description: "Optional owning agent/group. Defaults to actor or groupId." },
        groupId: { type: "string", description: "Optional group/ring id; remote groups route to their home instance." },
        projectId: { type: "string" },
        venueId: { type: "string" },
        localeId: {
          type: "string",
          description: "Scope the event to this locale/chapter (a place-typed agent id, e.g. \"Boulder\"). Resolve names to ids with rivr.places.list.",
        },
        regionId: {
          type: "string",
          description: "Scope the event to this region/bioregion (a place-typed agent id). Resolve names to ids with rivr.places.list. May be combined with localeId.",
        },
        scopedLocaleIds: { type: "array", items: { type: "string" }, description: "Scope to multiple locales/chapters (place-typed agent ids)." },
        scopedRegionIds: { type: "array", items: { type: "string" }, description: "Scope to multiple regions/bioregions (place-typed agent ids)." },
        scopedGroupIds: { type: "array", items: { type: "string" } },
        scopedUserIds: { type: "array", items: { type: "string" } },
        isGlobal: { type: "boolean", description: "Defaults true; false creates a scoped/private event." },
        ticketTypes: { type: "array", items: { type: "object" } },
        hosts: { type: "array", items: { type: "object" } },
        sessions: { type: "array", items: { type: "object" } },
        workItems: { type: "array", items: { type: "object" } },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const title = getString(args.title);
      const description = getString(args.description);
      const date = getString(args.date);
      const time = getString(args.time);
      const location = getString(args.location);
      if (!title || !description || !date || !time || !location) {
        throw new Error("title, description, date, time, and location are required.");
      }

      const eventType = getString(args.eventType);
      return createEventResource({
        title,
        description,
        date,
        time,
        location,
        eventType: eventType === "online" ? "online" : "in-person",
        price: getNumber(args.price) ?? null,
        imageUrl: getString(args.imageUrl) ?? undefined,
        ownerId: getString(args.ownerId),
        groupId: getString(args.groupId),
        projectId: getString(args.projectId),
        venueId: getString(args.venueId),
        localeId: getString(args.localeId),
        regionId: getString(args.regionId),
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedRegionIds: getStringArray(args.scopedRegionIds),
        scopedGroupIds: getStringArray(args.scopedGroupIds),
        scopedUserIds: getStringArray(args.scopedUserIds),
        isGlobal: getBoolean(args.isGlobal, true),
        ticketTypes: getRecordArray(args.ticketTypes) as any,
        hosts: getRecordArray(args.hosts) as any,
        sessions: getRecordArray(args.sessions) as any,
        workItems: getRecordArray(args.workItems) as any,
      });
    },
  },
  {
    name: "rivr.offerings.create",
    description: "Create an offering/listing as the active actor. Global visibility plus scoped locale/region/group ids makes it discoverable across Rivr; remote scoped groups receive a projection. Resolve place names to scopedLocaleIds/scopedRegionIds with rivr.places.list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "offeringType"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        offeringType: { type: "string", description: "service, product, skill, resource, data, ticket, voucher, bounty, trip, gift, etc." },
        imageUrl: { type: "string" },
        basePrice: { type: "number", description: "Price in dollars. Omit for a free offering." },
        currency: { type: "string" },
        acceptedCurrencies: { type: "array", items: { type: "string" } },
        quantityAvailable: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        targetAgentTypes: { type: "array", items: { type: "string" } },
        ownerId: { type: "string" },
        scopedLocaleIds: { type: "array", items: { type: "string" }, description: "Scope to one or more locales/chapters (place-typed agent ids). Resolve names with rivr.places.list." },
        scopedRegionIds: { type: "array", items: { type: "string" }, description: "Scope to one or more regions/bioregions (place-typed agent ids). Resolve names with rivr.places.list." },
        scopedGroupIds: { type: "array", items: { type: "string" } },
        scopedUserIds: { type: "array", items: { type: "string" } },
        postToFeed: { type: "boolean" },
        hourlyRate: { type: "number" },
        availability: { type: "string" },
        category: { type: "string" },
        condition: { type: "string" },
        bountyReward: { type: "number" },
        bountyCriteria: { type: "string" },
        bountyDeadline: { type: "string" },
        ticketEventName: { type: "string" },
        ticketDate: { type: "string" },
        ticketVenue: { type: "string" },
        ticketQuantity: { type: "number" },
        ticketPrice: { type: "number" },
        skillArea: { type: "string" },
        skillProficiency: { type: "string" },
        resourceCategory: { type: "string" },
        resourceAvailability: { type: "string" },
        resourceCondition: { type: "string" },
        dataFormat: { type: "string" },
        dataSize: { type: "string" },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const title = getString(args.title);
      const description = getString(args.description);
      const offeringType = getString(args.offeringType);
      if (!title || !description || !offeringType) {
        throw new Error("title, description, and offeringType are required.");
      }

      return createOfferingResource({
        title,
        description,
        offeringType,
        imageUrl: getString(args.imageUrl) ?? undefined,
        // This tool's schema is denominated in DOLLARS; the action takes CENTS.
        basePrice: getDollarsAsCents(args.basePrice),
        currency: getString(args.currency) ?? undefined,
        acceptedCurrencies: getStringArray(args.acceptedCurrencies),
        quantityAvailable: getNumber(args.quantityAvailable),
        tags: getStringArray(args.tags),
        targetAgentTypes: getStringArray(args.targetAgentTypes),
        ownerId: getString(args.ownerId) ?? undefined,
        scopedLocaleIds: getStringArray(args.scopedLocaleIds),
        scopedRegionIds: getStringArray(args.scopedRegionIds),
        scopedGroupIds: getStringArray(args.scopedGroupIds),
        scopedUserIds: getStringArray(args.scopedUserIds),
        postToFeed: getBoolean(args.postToFeed, true),
        hourlyRate: getNumber(args.hourlyRate),
        availability: getString(args.availability) ?? undefined,
        category: getString(args.category) ?? undefined,
        condition: getString(args.condition) ?? undefined,
        bountyReward: getNumber(args.bountyReward),
        bountyCriteria: getString(args.bountyCriteria) ?? undefined,
        bountyDeadline: getString(args.bountyDeadline) ?? undefined,
        ticketEventName: getString(args.ticketEventName) ?? undefined,
        ticketDate: getString(args.ticketDate) ?? undefined,
        ticketVenue: getString(args.ticketVenue) ?? undefined,
        ticketQuantity: getNumber(args.ticketQuantity),
        ticketPrice: getNumber(args.ticketPrice),
        skillArea: getString(args.skillArea) ?? undefined,
        skillProficiency: getString(args.skillProficiency) ?? undefined,
        resourceCategory: getString(args.resourceCategory) ?? undefined,
        resourceAvailability: getString(args.resourceAvailability) ?? undefined,
        resourceCondition: getString(args.resourceCondition) ?? undefined,
        dataFormat: getString(args.dataFormat) ?? undefined,
        dataSize: getString(args.dataSize) ?? undefined,
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

      const kgSystemPrompt = kgContext
        ? `You have access to a knowledge graph for this ${scopeType}. Use these facts to inform your answers:\n\n${kgContext}\n\n`
        : "";

      const result = await nativeCloudChat({
        selectedModel: DEFAULT_MODEL,
        systemPrompt: kgSystemPrompt || null,
        history: [],
        message,
      });

      return {
        success: true,
        reply: result.reply,
        model: result.model,
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

  // =========================================================================
  // Deploy / Isolation boundary tools
  // =========================================================================

  {
    name: "rivr.deploy.get_capability",
    description: "Return the deploy capability and isolation tier for this instance. Shows what operations are allowed (self-deploy, Docker, host access, etc.).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async () => {
      const cap = getDeployCapability();
      const sandbox = getSandboxSummary();
      return { success: true, capability: cap, sandbox };
    },
  },
  {
    name: "rivr.deploy.self_deploy",
    description: "Trigger a self-deploy (git pull + rebuild) on sovereign instances. Denied on shared instances.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        branch: { type: "string", description: "Git branch to deploy. Default: current branch." },
      },
    },
    // PSN-CORE-001 layer 3: deploy-class tools are host-mutating operator
    // actions, not assistant capabilities. `"operator"` is a mode no caller
    // ever sets, so this tool is no longer reachable from the LLM tool loop
    // (authMode "session") or an MCP bearer (authMode "token").
    enabledFor: ["operator"],
    handler: async (args) => {
      const cap = getDeployCapability();
      if (!cap.canSelfDeploy) {
        return {
          success: false,
          error: `Self-deploy is not available on ${cap.isolationTier} instances. This operation requires a sovereign instance.`,
          isolationTier: cap.isolationTier,
        };
      }

      if (!isOperationAllowed("self_deploy")) {
        return {
          success: false,
          error: "self_deploy operation is denied by the current sandbox configuration.",
        };
      }

      const branch = getString(args.branch) ?? "main";
      // PSN-CORE-001: `branch` arrives from tool arguments an LLM emitted, and
      // the LLM's context contains attacker-influenceable text. Validate against
      // the git ref grammar AND spawn without a shell — either alone would close
      // the injection; both are kept.
      if (!isValidGitRef(branch)) {
        return {
          success: false,
          error:
            "Invalid branch name. Branch must match the git ref grammar (letters, digits, '.', '_', '-', '/') and may not begin with '-'.",
        };
      }

      // On sovereign instances, trigger the deploy script.
      const { execFileSync } = await import("child_process");
      const runGit = (gitArgs: string[]): string =>
        execFileSync("git", gitArgs, {
          cwd: process.cwd(),
          timeout: DEPLOY_COMMAND_TIMEOUT_MS,
          encoding: "utf-8",
          shell: false,
        });
      try {
        const output = [
          runGit(["fetch", "origin"]),
          runGit(["checkout", "--", branch]),
          runGit(["pull", "origin", branch]),
        ].join("\n");
        return { success: true, branch, output: output.slice(0, DEPLOY_OUTPUT_MAX_CHARS) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Deploy script failed";
        return { success: false, error: message };
      }
    },
  },
  {
    name: "rivr.deploy.restart_autobot",
    description: "Restart the autobot/OpenClaw sidecar on sovereign instances. Denied on shared instances.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    // PSN-CORE-001 layer 3: deploy-class tools are host-mutating operator
    // actions, not assistant capabilities. `"operator"` is a mode no caller
    // ever sets, so this tool is no longer reachable from the LLM tool loop
    // (authMode "session") or an MCP bearer (authMode "token").
    enabledFor: ["operator"],
    handler: async () => {
      const cap = getDeployCapability();
      if (!cap.canDeployAutobot) {
        return {
          success: false,
          error: `Autobot restart is not available on ${cap.isolationTier} instances. Autobots on shared servers are containerized and cannot be restarted by agents.`,
          isolationTier: cap.isolationTier,
        };
      }

      if (!isOperationAllowed("autobot_deploy")) {
        return {
          success: false,
          error: "autobot_deploy operation is denied by the current sandbox configuration.",
        };
      }

      // PSN-CORE-001: fixed argv, no shell. The previous form relied on `sh` for
      // the `||` fallback; the fallback is expressed in TypeScript instead so no
      // shell is involved anywhere in this file.
      const { execFileSync } = await import("child_process");
      const attempts: Array<[string, string[]]> = [
        ["docker", ["compose", "restart", AUTOBOT_SIDECAR_SERVICE]],
        ["systemctl", ["restart", AUTOBOT_SIDECAR_SERVICE]],
      ];
      let lastError = "Autobot restart failed";
      for (const [command, commandArgs] of attempts) {
        try {
          const output = execFileSync(command, commandArgs, {
            cwd: process.cwd(),
            timeout: DEPLOY_COMMAND_TIMEOUT_MS,
            encoding: "utf-8",
            shell: false,
          });
          return { success: true, output: output.slice(0, DEPLOY_OUTPUT_MAX_CHARS) };
        } catch (err) {
          lastError = err instanceof Error ? err.message : lastError;
        }
      }
      return { success: false, error: lastError };
    },
  },
  {
    name: "rivr.deploy.docker_rebuild",
    description: "Trigger a Docker rebuild on sovereign instances. Denied on shared instances.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", description: "Docker compose service name to rebuild. Default: app." },
      },
    },
    // PSN-CORE-001 layer 3: deploy-class tools are host-mutating operator
    // actions, not assistant capabilities. `"operator"` is a mode no caller
    // ever sets, so this tool is no longer reachable from the LLM tool loop
    // (authMode "session") or an MCP bearer (authMode "token").
    enabledFor: ["operator"],
    handler: async (args) => {
      const cap = getDeployCapability();
      if (!cap.canBuildDocker) {
        return {
          success: false,
          error: `Docker operations are not available on ${cap.isolationTier} instances. Agents on shared infrastructure cannot alter Docker containers.`,
          isolationTier: cap.isolationTier,
        };
      }

      if (!isOperationAllowed("docker_build")) {
        return {
          success: false,
          error: "docker_build operation is denied by the current sandbox configuration.",
        };
      }

      const service = getString(args.service) ?? "app";
      // PSN-CORE-001: reject rather than silently rewrite, and spawn without a
      // shell so the value is an argv element and never a command fragment.
      if (!isValidDockerServiceName(service)) {
        return {
          success: false,
          error:
            "Invalid service name. Service must be letters, digits, '_' or '-' and may not begin with '-'.",
        };
      }

      const { execFileSync } = await import("child_process");
      const runDocker = (dockerArgs: string[]): string =>
        execFileSync("docker", dockerArgs, {
          cwd: process.cwd(),
          timeout: DOCKER_BUILD_TIMEOUT_MS,
          encoding: "utf-8",
          shell: false,
        });
      try {
        const output = [
          runDocker(["compose", "build", service]),
          runDocker(["compose", "up", "-d", service]),
        ].join("\n");
        return { success: true, service, output: output.slice(0, DEPLOY_OUTPUT_MAX_CHARS) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Docker rebuild failed";
        return { success: false, error: message };
      }
    },
  },
  {
    name: "rivr.sandbox.status",
    description: "Return the current autobot sandbox configuration — what operations are allowed, resource limits, and network restrictions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    enabledFor: ["session", "token"],
    handler: async () => {
      const sandbox = getAutobotSandbox();
      const summary = getSandboxSummary();
      return { success: true, sandbox: summary, deniedOperations: [...sandbox.deniedOperations] };
    },
  },
  {
    name: "rivr.sandbox.check_operation",
    description: "Check whether a specific operation is allowed in the current sandbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description: "Operation name to check (e.g., ssh, docker, fs_write_host, self_deploy, autobot_deploy).",
        },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args) => {
      const operation = getString(args.operation);
      if (!operation) throw new Error("operation is required.");

      const allowed = isOperationAllowed(operation);
      const cap = getDeployCapability();
      return {
        success: true,
        operation,
        allowed,
        isolationTier: cap.isolationTier,
        reason: allowed
          ? `Operation "${operation}" is permitted on ${cap.isolationTier} instances.`
          : `Operation "${operation}" is denied on ${cap.isolationTier} instances.`,
      };
    },
  },

  // ── Outbound Dispatch ─────────────────────────────────────────────────
  {
    name: "rivr.dispatch.send_message",
    description:
      "Send a message through a connected external service (Slack, Discord, or email). " +
      "Requires the target service to be connected via autobot connectors. " +
      "For Slack: provide channel name or ID. For Discord: provide channel ID. " +
      "For email: provide recipient address, subject, and body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: {
          type: "string",
          enum: ["slack", "discord", "email"],
          description: "The connected service to send through.",
        },
        channel: {
          type: "string",
          description: "Slack channel name or ID (for Slack provider).",
        },
        channelId: {
          type: "string",
          description: "Discord channel ID (for Discord provider).",
        },
        text: {
          type: "string",
          description: "Message text (for Slack/Discord).",
        },
        threadTs: {
          type: "string",
          description: "Slack thread timestamp to reply in a thread (optional, Slack only).",
        },
        to: {
          type: "string",
          description: "Email recipient address (for email provider).",
        },
        subject: {
          type: "string",
          description: "Email subject line (for email provider).",
        },
        body: {
          type: "string",
          description: "Email body text (for email provider).",
        },
      },
      required: ["provider"],
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const { dispatch } = await import("@/lib/autobot/outbound-dispatch");
      const provider = args.provider as string;

      if (provider === "slack") {
        if (!args.channel || !args.text) {
          return { success: false, error: "Slack dispatch requires 'channel' and 'text'." };
        }
        return dispatch(context.actorId, {
          provider: "slack",
          channel: args.channel as string,
          text: args.text as string,
          threadTs: args.threadTs as string | undefined,
        });
      }

      if (provider === "discord") {
        if (!args.channelId || !args.text) {
          return { success: false, error: "Discord dispatch requires 'channelId' and 'text'." };
        }
        return dispatch(context.actorId, {
          provider: "discord",
          channelId: args.channelId as string,
          content: args.text as string,
        });
      }

      if (provider === "email") {
        if (!args.to || !args.subject || !args.body) {
          return { success: false, error: "Email dispatch requires 'to', 'subject', and 'body'." };
        }
        return dispatch(context.actorId, {
          provider: "email",
          to: args.to as string,
          subject: args.subject as string,
          body: args.body as string,
        });
      }

      return { success: false, error: `Unsupported dispatch provider: ${provider}` };
    },
  },

  // ── Connector Sync ────────────────────────────────────────────────────
  {
    name: "rivr.connectors.sync",
    description:
      "Trigger a sync of one of the active actor's configured autobot connector lanes " +
      "(e.g. pull Notion pages / Google Docs into Rivr documents, sync Google Calendar, " +
      "import Slack/Discord/Dropbox/Zoom content). The connector must already be configured " +
      "on the actor's connections; this runs the same lane the settings 'Sync now' button runs, " +
      "scoped to the calling actor, then ingests the synced resources into the knowledge graph. " +
      `Supported providers: ${SYNCABLE_CONNECTOR_PROVIDERS.join(", ")}.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: {
        provider: {
          type: "string",
          enum: SYNCABLE_CONNECTOR_PROVIDERS,
          description:
            "The connector provider to sync. Must be a provider the actor has configured.",
        },
      },
    },
    enabledFor: ["session", "token"],
    handler: async (args, context) => {
      const provider = getString(args.provider);
      if (!provider) {
        throw new Error("provider is required.");
      }

      try {
        const { result, kgIngest, connections } = await runConnectorSync(
          context.actorId,
          provider,
        );
        return { success: true, result, kgIngest, connections };
      } catch (error) {
        if (error instanceof ConnectorSyncError) {
          // Return a structured failure (not a throw) so the central provenance
          // logger records resultStatus="error" off the `{ success: false }`
          // shape, the same way blocked server actions are recorded.
          return { success: false, code: error.code, error: error.message };
        }
        throw error;
      }
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
