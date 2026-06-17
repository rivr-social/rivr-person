/**
 * Agent role / chat-access / KG-object model for personas (and the controller
 * agent).
 *
 * All of this is persisted in `agents.metadata` (no schema migration needed),
 * mirroring how persona profile + skill data already live there. This module
 * sits OUTSIDE the "use server" boundary so both client hub components and
 * server actions/routes can import the value-level constants, the metadata
 * parsers, and the pure access-evaluation helper.
 *
 * Three independent metadata sub-objects:
 *   - `metadata.agentRole`       — { privateAgent, publicAgent } role flags.
 *   - `metadata.agentChatVisibility` — who may chat with the PUBLIC agent.
 *   - `metadata.kgObjects`       — hand-picked rivr objects the agent may query
 *                                  as its knowledge graph.
 *
 * Naming note: we store `privateAgent`/`publicAgent` (not `private`/`public`)
 * because `private` is a reserved word in some serialization contexts and to
 * avoid collisions with the unrelated `agents.visibility` enum, which governs
 * federation/discovery — NOT chat access.
 */

// ---------------------------------------------------------------------------
// Chat-visibility levels (reuses the group TabVisibilityLevel taxonomy)
// ---------------------------------------------------------------------------

/**
 * Who may chat with a persona acting as a PUBLIC agent. Mirrors the group
 * tab-visibility levels so the same selector UX and mental model apply:
 *   - public  — anyone (incl. signed-out guests, subject to route auth)
 *   - members — members of any scoped group, or explicitly listed users
 *   - admin   — only the owner / account admins
 *   - hidden  — nobody (public chat effectively disabled)
 */
export const AGENT_CHAT_VISIBILITY_LEVELS = [
  "public",
  "members",
  "admin",
  "hidden",
] as const;
export type AgentChatVisibilityLevel =
  (typeof AGENT_CHAT_VISIBILITY_LEVELS)[number];

export const DEFAULT_AGENT_CHAT_VISIBILITY_LEVEL: AgentChatVisibilityLevel =
  "public";

// ---------------------------------------------------------------------------
// KG object types
// ---------------------------------------------------------------------------

/**
 * Object kinds the KG picker can hand-pick. `resource` is the catch-all for
 * the resource_type enum; posts/events/groups are surfaced as first-class
 * kinds because the picker groups by type.
 */
export const KG_OBJECT_TYPES = [
  "post",
  "event",
  "group",
  "document",
  "resource",
  "offering",
  "listing",
  "project",
  "job",
] as const;
export type KgObjectType = (typeof KG_OBJECT_TYPES)[number];

const KG_OBJECT_TYPE_SET = new Set<string>(KG_OBJECT_TYPES);

/**
 * A single hand-picked KG object reference. `visibility` is captured at
 * selection time purely so the picker can group/sort by it; retrieval-time
 * enforcement always re-checks live visibility relative to the asker.
 */
export interface KgObjectRef {
  type: KgObjectType;
  id: string;
  /** Object's visibility at selection time (advisory; for grouping only). */
  visibility?: string;
}

// ---------------------------------------------------------------------------
// Metadata shapes
// ---------------------------------------------------------------------------

/**
 * Per-persona role flags. A persona may be either, both, or neither.
 *   - privateAgent — the owner's personal assistant; only the owner may chat.
 *   - publicAgent  — others may chat, gated by `agentChatVisibility`.
 */
export interface AgentRoleFlags {
  privateAgent: boolean;
  publicAgent: boolean;
}

export const DEFAULT_AGENT_ROLE: AgentRoleFlags = {
  privateAgent: false,
  publicAgent: false,
};

/** Per-persona public-chat access scope. */
export interface AgentChatVisibility {
  level: AgentChatVisibilityLevel;
  groupIds: string[];
  userIds: string[];
  localeIds: string[];
}

export const DEFAULT_AGENT_CHAT_VISIBILITY: AgentChatVisibility = {
  level: DEFAULT_AGENT_CHAT_VISIBILITY_LEVEL,
  groupIds: [],
  userIds: [],
  localeIds: [],
};

// ---------------------------------------------------------------------------
// Parsers — tolerant readers over an arbitrary metadata blob
// ---------------------------------------------------------------------------

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Read `metadata.agentRole`, falling back to all-false defaults. */
export function readAgentRole(
  metadata: Record<string, unknown> | null | undefined,
): AgentRoleFlags {
  const raw = (metadata?.agentRole ?? {}) as Record<string, unknown>;
  return {
    privateAgent: Boolean(raw.privateAgent),
    publicAgent: Boolean(raw.publicAgent),
  };
}

/** Read `metadata.agentChatVisibility`, falling back to public defaults. */
export function readAgentChatVisibility(
  metadata: Record<string, unknown> | null | undefined,
): AgentChatVisibility {
  const raw = (metadata?.agentChatVisibility ?? {}) as Record<string, unknown>;
  const level = AGENT_CHAT_VISIBILITY_LEVELS.includes(
    raw.level as AgentChatVisibilityLevel,
  )
    ? (raw.level as AgentChatVisibilityLevel)
    : DEFAULT_AGENT_CHAT_VISIBILITY_LEVEL;
  return {
    level,
    groupIds: asStringArray(raw.groupIds),
    userIds: asStringArray(raw.userIds),
    localeIds: asStringArray(raw.localeIds),
  };
}

/** Read `metadata.kgObjects`, dropping malformed/unknown-type entries. */
export function readKgObjects(
  metadata: Record<string, unknown> | null | undefined,
): KgObjectRef[] {
  const raw = metadata?.kgObjects;
  if (!Array.isArray(raw)) return [];
  const out: KgObjectRef[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).id === "string" &&
      KG_OBJECT_TYPE_SET.has((entry as Record<string, unknown>).type as string)
    ) {
      const e = entry as Record<string, unknown>;
      out.push({
        type: e.type as KgObjectType,
        id: e.id as string,
        visibility: typeof e.visibility === "string" ? e.visibility : undefined,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sanitizers — for write paths (server actions)
// ---------------------------------------------------------------------------

export function sanitizeAgentRole(raw: unknown): AgentRoleFlags {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    privateAgent: Boolean(obj.privateAgent),
    publicAgent: Boolean(obj.publicAgent),
  };
}

export function sanitizeAgentChatVisibility(raw: unknown): AgentChatVisibility {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const level = AGENT_CHAT_VISIBILITY_LEVELS.includes(
    obj.level as AgentChatVisibilityLevel,
  )
    ? (obj.level as AgentChatVisibilityLevel)
    : DEFAULT_AGENT_CHAT_VISIBILITY_LEVEL;
  return {
    level,
    groupIds: asStringArray(obj.groupIds),
    userIds: asStringArray(obj.userIds),
    localeIds: asStringArray(obj.localeIds),
  };
}

export function sanitizeKgObjects(raw: unknown): KgObjectRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KgObjectRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !KG_OBJECT_TYPE_SET.has(e.type as string)) {
      continue;
    }
    const key = `${e.type}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: e.type as KgObjectType,
      id: e.id,
      visibility: typeof e.visibility === "string" ? e.visibility : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Access evaluation (pure)
// ---------------------------------------------------------------------------

export interface ChatAccessQuery {
  /** Resolved role flags for the target persona/agent. */
  role: AgentRoleFlags;
  /** Public-chat scope for the target persona/agent. */
  visibility: AgentChatVisibility;
  /** True when the asker is the owner (controller) of this agent. */
  isOwner: boolean;
  /** Group IDs the asker belongs to (for `members` level). */
  askerGroupIds?: string[];
  /** Asker's agent id (for explicit user allowlist). May be null for guests. */
  askerId?: string | null;
  /** True when the asker is an account admin of the owner. */
  askerIsAdmin?: boolean;
}

export interface ChatAccessResult {
  allowed: boolean;
  /** Machine-readable reason, useful for 401/403 messaging. */
  reason:
    | "owner"
    | "public"
    | "member"
    | "explicit-user"
    | "admin"
    | "not-an-agent"
    | "private-only"
    | "hidden"
    | "out-of-scope";
}

/**
 * Decide whether `asker` may chat with the target agent.
 *
 * Rules:
 *  - The owner may always chat with their own agent (private or public).
 *  - If the agent is NOT a public agent, only the owner may chat (private-only).
 *  - For a public agent, the `agentChatVisibility.level` gates non-owners:
 *      public  → anyone
 *      members → asker is in a scoped group OR explicitly listed OR admin
 *      admin   → only account admins (and owner)
 *      hidden  → nobody but the owner
 */
export function evaluateChatAccess(query: ChatAccessQuery): ChatAccessResult {
  if (query.isOwner) {
    return { allowed: true, reason: "owner" };
  }

  if (!query.role.publicAgent) {
    return { allowed: false, reason: "private-only" };
  }

  const { level, groupIds, userIds } = query.visibility;

  if (level === "hidden") {
    return { allowed: false, reason: "hidden" };
  }

  if (level === "public") {
    return { allowed: true, reason: "public" };
  }

  if (query.askerIsAdmin) {
    return { allowed: true, reason: "admin" };
  }

  if (level === "admin") {
    // Only owner/admins; non-admins fall through to denial.
    return { allowed: false, reason: "out-of-scope" };
  }

  // level === "members"
  if (query.askerId && userIds.includes(query.askerId)) {
    return { allowed: true, reason: "explicit-user" };
  }
  const askerGroups = query.askerGroupIds ?? [];
  if (groupIds.length > 0 && askerGroups.some((g) => groupIds.includes(g))) {
    return { allowed: true, reason: "member" };
  }

  return { allowed: false, reason: "out-of-scope" };
}
