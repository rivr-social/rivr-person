// ---------------------------------------------------------------------------
// REA scope vocabularies
//
// Plain catalogs of the "kinds" offered by the builder Sources scope picker for
// each REA source. Mirrors the DB enums (resourceTypeEnum / agentTypeEnum /
// verbTypeEnum) as plain string arrays so the client picker doesn't pull the
// full Drizzle schema into the browser bundle. Keep in sync with src/db/schema.ts.
// ---------------------------------------------------------------------------

import type { DataSourceMeta } from "./data-source-registry";

export const RESOURCE_TYPE_VOCAB: readonly string[] = [
  "document",
  "image",
  "video",
  "audio",
  "link",
  "note",
  "file",
  "dataset",
  "resource",
  "skill",
  "project",
  "job",
  "shift",
  "task",
  "training",
  "place",
  "venue",
  "booking",
  "asset",
  "voucher",
  "currency",
  "thanks_token",
  "listing",
  "proposal",
  "badge",
  "post",
  "event",
  "group",
  "permission_policy",
  "receipt",
] as const;

export const AGENT_TYPE_VOCAB: readonly string[] = [
  "person",
  "organization",
  "project",
  "event",
  "place",
  "system",
  "bot",
  "org",
  "domain",
  "ring",
  "family",
  "guild",
  "community",
] as const;

export const VERB_TYPE_VOCAB: readonly string[] = [
  "create",
  "update",
  "delete",
  "transfer",
  "share",
  "view",
  "clone",
  "merge",
  "split",
  "transact",
  "buy",
  "sell",
  "trade",
  "gift",
  "give",
  "earn",
  "redeem",
  "fund",
  "pledge",
  "work",
  "clock_in",
  "clock_out",
  "produce",
  "consume",
  "vote",
  "propose",
  "approve",
  "reject",
  "join",
  "manage",
  "own",
  "locate",
  "follow",
  "belong",
  "assign",
  "invite",
  "employ",
  "contain",
  "leave",
  "start",
  "complete",
  "cancel",
  "archive",
  "publish",
  "attend",
  "host",
  "schedule",
  "endorse",
  "mention",
  "comment",
  "react",
  "grant",
  "revoke",
  "rent",
  "use",
  "request",
] as const;

/** Resolve the kind catalog for a given scope vocabulary. */
export function scopeVocabularyCatalog(
  vocab: NonNullable<DataSourceMeta["scopeVocabulary"]>,
): readonly string[] {
  switch (vocab) {
    case "resource-types":
      return RESOURCE_TYPE_VOCAB;
    case "agent-types":
      return AGENT_TYPE_VOCAB;
    case "verb-types":
      return VERB_TYPE_VOCAB;
  }
}
