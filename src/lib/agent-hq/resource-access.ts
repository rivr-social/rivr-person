/**
 * @fileoverview Pure DTO shaping for the unified filesystem organizer's
 * per-resource ACL panel and read-only Ledger history (Wave 2 / T2.1).
 *
 * No database access and no Node-only APIs — the route layer queries the ledger
 * and an agent-name lookup, then calls these shapers to build the response. This
 * keeps the routes thin and the shaping unit-testable.
 *
 * Permission model recap (see src/lib/permissions.ts): a grant is a ledger row
 * with `verb = "grant"`, `objectId = <resourceId>`, `isActive = true`, and the
 * effective permission stored in `metadata.action`. Visibility on the resource
 * row is the implicit-access fallback; explicit grants layer on top.
 */
import type { VerbType } from "@/db/schema";

/**
 * Verbs an owner may grant from the ACL panel. Read/use/manage/share is the
 * meaningful spectrum for a Resource; ownership-transfer and grant-of-grant are
 * intentionally excluded from the simple sharing UI.
 */
export const GRANTABLE_VERBS: VerbType[] = ["view", "use", "manage", "share"];

/** Minimal agent identity used to humanize subject ids in DTOs. */
export interface AgentIdentity {
  id: string;
  name: string | null;
  image: string | null;
  /** True when the agent is a persona of the resource owner. */
  isPersona?: boolean;
}

/** A raw active grant row read from the ledger. */
export interface RawGrantRow {
  subjectId: string;
  action: string | null;
  role: string | null;
  /** Grant context: "locale" (scoped) or "global" (default). */
  scope: string | null;
  grantedAt: Date | string;
}

/** A grant as surfaced in the ACL panel. */
export interface AccessGrantDTO {
  subjectId: string;
  subjectName: string;
  subjectImage: string | null;
  isPersona: boolean;
  verb: VerbType;
  role: string | null;
  scope: string | null;
  grantedAt: string;
}

/** A raw ledger row read for a resource's history. */
export interface RawLedgerRow {
  id: string;
  verb: string;
  subjectId: string;
  objectType: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: Date | string;
}

/** A read-only ledger history entry for the resource. */
export interface LedgerHistoryDTO {
  id: string;
  verb: string;
  subjectId: string;
  subjectName: string;
  summary: string;
  timestamp: string;
}

const VERB_SET = new Set<string>(GRANTABLE_VERBS);

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nameFor(id: string, lookup: ReadonlyMap<string, AgentIdentity>): string {
  const identity = lookup.get(id);
  const name = identity?.name?.trim();
  return name && name.length > 0 ? name : "Unknown agent";
}

/**
 * Shapes active grant rows into ACL-panel DTOs. Rows whose `action` is not a
 * recognized verb are dropped (defensive — the ledger stores arbitrary verbs in
 * `metadata.action`). Grants are sorted by subject name then verb for stable
 * rendering.
 */
export function shapeAccessGrants(
  rows: readonly RawGrantRow[],
  lookup: ReadonlyMap<string, AgentIdentity>,
): AccessGrantDTO[] {
  const shaped: AccessGrantDTO[] = [];
  for (const row of rows) {
    const action = row.action?.trim();
    if (!action || !VERB_SET.has(action)) continue;
    const identity = lookup.get(row.subjectId);
    shaped.push({
      subjectId: row.subjectId,
      subjectName: nameFor(row.subjectId, lookup),
      subjectImage: identity?.image ?? null,
      isPersona: identity?.isPersona === true,
      verb: action as VerbType,
      role: row.role,
      scope: row.scope,
      grantedAt: toIso(row.grantedAt),
    });
  }
  return shaped.sort(
    (a, b) => a.subjectName.localeCompare(b.subjectName) || a.verb.localeCompare(b.verb),
  );
}

/**
 * Produces a short human summary for a ledger entry, e.g.
 * `"granted view"` / `"revoked use"` / `"updated"`.
 */
export function summarizeLedgerVerb(
  verb: string,
  metadata: Record<string, unknown> | null,
): string {
  const action = typeof metadata?.action === "string" ? metadata.action : null;
  switch (verb) {
    case "grant":
      return action ? `granted ${action}` : "granted access";
    case "revoke":
      return action ? `revoked ${action}` : "revoked access";
    case "create":
      return "created";
    case "update":
      return "updated";
    case "delete":
      return "deleted";
    case "view":
      return "viewed";
    default:
      return verb;
  }
}

/**
 * Shapes raw ledger rows into read-only history DTOs, newest first.
 */
export function shapeLedgerHistory(
  rows: readonly RawLedgerRow[],
  lookup: ReadonlyMap<string, AgentIdentity>,
): LedgerHistoryDTO[] {
  return rows
    .map((row) => ({
      id: row.id,
      verb: row.verb,
      subjectId: row.subjectId,
      subjectName: nameFor(row.subjectId, lookup),
      summary: summarizeLedgerVerb(row.verb, row.metadata),
      timestamp: toIso(row.timestamp),
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Type guard usable by routes to validate an incoming grant verb. */
export function isGrantableVerb(value: unknown): value is VerbType {
  return typeof value === "string" && VERB_SET.has(value);
}
