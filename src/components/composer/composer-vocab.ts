// ---------------------------------------------------------------------------
// Composer vocabulary + types
//
// Shared, JSX-free building blocks for the Subject-Verb-Object condition
// authoring UI. Consumed by:
//   - the Explore graph query composer (query-composer.tsx)
//   - the per-document ABAC rule editor (resource access policies)
//
// Keeping the verb/determiner/type vocabulary and the condition types in one
// module means both authoring surfaces speak the exact same grammar and stay
// in sync with the DB enums.
// ---------------------------------------------------------------------------

import { ENTITY_COLORS } from "@/lib/entity-style";

// ─── Verb vocabulary ─────────────────────────────────────────────────────────

/** All verbs from the verbTypeEnum in schema.ts, grouped logically. */
export const VERB_GROUPS: { label: string; verbs: string[] }[] = [
  {
    label: "Economic",
    verbs: ["buy", "sell", "trade", "gift", "give", "earn", "redeem", "fund", "pledge", "transact", "refund"],
  },
  {
    label: "CRUD",
    verbs: ["create", "update", "delete", "transfer", "share", "view", "clone", "merge", "split"],
  },
  {
    label: "Work",
    verbs: ["work", "clock_in", "clock_out", "produce", "consume"],
  },
  {
    label: "Governance",
    verbs: ["vote", "propose", "approve", "reject"],
  },
  {
    label: "Membership",
    verbs: ["join", "manage", "own", "locate", "follow", "belong", "assign", "invite", "employ", "contain", "leave"],
  },
  {
    label: "Lifecycle",
    verbs: ["start", "complete", "cancel", "archive", "publish"],
  },
  {
    label: "Social",
    verbs: ["attend", "host", "schedule", "endorse", "mention", "comment", "react"],
  },
  {
    label: "Permissions",
    verbs: ["grant", "revoke", "rent", "use", "request"],
  },
];

/** All known verb strings for NLP matching */
export const ALL_VERBS = VERB_GROUPS.flatMap((g) => g.verbs);

// ─── Color + sizing maps ──────────────────────────────────────────────────────

/** Color map for agent/resource types — delegates to centralized entity-style. */
export const TYPE_COLORS: Record<string, string> = {
  ...ENTITY_COLORS,
  offering: ENTITY_COLORS.listing,
  wildcard: ENTITY_COLORS.unknown,
  self: ENTITY_COLORS.person,
};

/** Node radii for the mini canvas */
export const MINI_NODE_RADII: Record<string, number> = {
  person: 14,
  organization: 18,
  group: 18,
  event: 16,
  post: 10,
  offering: 12,
  wildcard: 12,
  self: 14,
  default: 12,
};

// ─── Determiners + wildcards ────────────────────────────────────────────────

export const WILDCARD_AGENTS = [
  { id: "__everyone__", name: "Everyone", type: "wildcard" },
  { id: "__any_person__", name: "Any Person", type: "person" },
  { id: "__any_group__", name: "Any Group", type: "organization" },
];

/** Agent determiner options */
export const AGENT_DETERMINERS = ["any", "my", "the", "that"] as const;
/** Resource determiner options */
export const RESOURCE_DETERMINERS = ["any", "my", "the", "that", "a", "all"] as const;

// ─── Verb ↔ Resource Type Contextual Mappings ──────────────────────────────

/** Which resource types each verb can operate on. Empty array = targets agents only. */
export const VERB_RESOURCE_TYPES: Record<string, string[]> = {
  // Commerce
  buy: ["listing", "product", "voucher"],
  sell: ["listing", "product", "voucher"],
  trade: ["listing", "product", "voucher", "thanks_token"],
  transact: ["listing", "product", "voucher", "thanks_token"],
  refund: ["listing", "product", "voucher", "receipt"],

  // Gifting
  give: ["thanks_token", "voucher", "listing", "product", "badge"],
  gift: ["thanks_token", "voucher", "listing", "product", "badge"],
  earn: ["thanks_token", "voucher", "badge"],
  redeem: ["voucher", "thanks_token"],
  fund: ["project", "proposal"],
  pledge: ["project", "proposal"],

  // CRUD
  create: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note", "group", "shift", "booking"],
  update: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note", "group", "shift", "booking"],
  delete: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note"],
  transfer: ["thanks_token", "voucher", "listing", "product", "asset"],
  share: ["post", "event", "listing", "project", "document", "note"],
  view: ["post", "event", "listing", "project", "document", "note", "badge", "image", "video"],
  clone: ["document", "project", "listing"],
  merge: ["document", "project"],
  split: ["document", "project"],

  // Work
  work: ["job", "task", "shift", "project"],
  clock_in: ["shift", "job"],
  clock_out: ["shift", "job"],
  produce: ["product", "listing", "document"],
  consume: ["voucher", "thanks_token"],

  // Governance
  vote: ["proposal"],
  propose: ["proposal", "project"],
  approve: ["proposal", "task", "job"],
  reject: ["proposal", "task", "job"],

  // Membership — these target agents (groups, people), not resources
  join: [],
  manage: [],
  own: [],
  locate: ["place", "venue"],
  follow: [],
  belong: [],
  assign: ["job", "task", "shift"],
  invite: [],
  employ: [],
  contain: [],
  leave: [],

  // Lifecycle
  start: ["event", "project", "task", "job", "shift"],
  complete: ["task", "job", "shift", "project"],
  cancel: ["event", "booking", "listing", "job", "shift"],
  archive: ["post", "event", "listing", "project", "document"],
  publish: ["post", "event", "listing", "document"],

  // Social
  attend: ["event"],
  host: ["event"],
  schedule: ["event", "booking", "shift"],
  endorse: ["post", "listing", "badge"],
  mention: ["post"],
  comment: ["post", "event", "listing"],
  react: ["post", "event", "listing"],

  // Permissions
  grant: ["badge", "permission_policy"],
  revoke: ["badge", "permission_policy"],
  rent: ["listing", "asset", "venue"],
  use: ["voucher", "thanks_token", "asset"],
  request: ["listing", "job", "badge", "permission_policy"],
};

/** Verbs that target AGENTS (groups, people) instead of resources */
export const AGENT_VERBS = new Set(["join", "leave", "manage", "own", "follow", "belong", "invite", "employ", "contain"]);

/** Resource types that support quantity (stored in metadata.quantityAvailable) */
export const QUANTIFIABLE_RESOURCE_TYPES = new Set(["voucher", "thanks_token", "product", "listing", "badge"]);

/** Reverse mapping: resource type → applicable verbs. Derived from VERB_RESOURCE_TYPES. */
export const RESOURCE_TYPE_VERBS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [verb, types] of Object.entries(VERB_RESOURCE_TYPES)) {
    for (const t of types) {
      if (!map[t]) map[t] = [];
      map[t].push(verb);
    }
  }
  return map;
})();

/** Known determiner words for NLP extraction */
export const KNOWN_DETERMINERS = new Set(["any", "my", "the", "that", "a", "all", "every", "each"]);

/** Agent-like type keywords the NLP parser might produce */
export const AGENT_TYPE_KEYWORDS = new Set(["person", "people", "user", "member", "group", "organization", "org", "team"]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryCondition {
  agentDeterminer?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  verb?: string;
  resourceDeterminer?: string;
  resourceId?: string;
  resourceName?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
}

/** THEN action row with 4 slots: [I] [do what] [det+what] to [det+who] */
export interface ThenAction {
  verb?: string;
  objectDeterminer?: string;
  objectId?: string;
  objectName?: string;
  objectType?: string;
  /** Quantity for quantifiable resources (vouchers, tokens, products). Stored as contract delta. */
  delta?: number;
  targetDeterminer?: string;
  targetId?: string;
  targetName?: string;
  targetType?: string;
}

export interface ComposerQuery {
  when: QueryCondition;
  then: ThenAction[];
  if?: QueryCondition;
}

export interface DropdownOption {
  id: string;
  name: string;
  type: string;
  /** Total quantity available (from metadata.quantityAvailable) */
  quantityAvailable?: number;
  /** Remaining quantity (from metadata.quantityRemaining) */
  quantityRemaining?: number;
}
