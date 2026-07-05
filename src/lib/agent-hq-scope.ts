/**
 * @fileoverview Pure scope-model helpers for the agent-hq filesystem tree.
 *
 * The tree's relationship model in one line: GROUPS ARE AGENTS — an identity's
 * `agents/` folder lists every agent it holds an active membership ledger edge
 * to (own/manage/join/belong), labeled by the strongest relationship, and each
 * opens as its own scope (admin = manage surface, member = read-only).
 *
 * Dependencies: none (pure). The DB/auth glue lives in
 * `agent-hq-db-explorer.ts`, which imports from here; keeping these pure makes
 * the precedence/labeling rules unit-testable without next-auth/drizzle.
 */

/** How the viewer relates to a browsable agent — drives labels and scope depth. */
export type AgentHqRelationship = "self" | "persona" | "admin" | "member";

/**
 * Visibility levels a plain group MEMBER may see when browsing a group scope
 * read-only. Private stays owner/grant-gated: a member sees a private resource
 * only via an explicit grant to the viewer, never via membership alone.
 */
export const MEMBER_VISIBLE_LEVELS = ["public", "locale", "members"] as const;

/** Membership verbs that relate an identity to another agent in the tree. */
export const MEMBERSHIP_VERBS = ["own", "manage", "join", "belong"] as const;
export type MembershipVerb = (typeof MEMBERSHIP_VERBS)[number];

/**
 * Picks the stronger of two membership verbs for labeling a related agent:
 * own > manage > join/belong. Used when an identity holds several active
 * edges to the same agent (e.g. both join and manage).
 */
export function strongerMembershipVerb(
  prior: MembershipVerb | undefined,
  next: MembershipVerb,
): MembershipVerb {
  if (!prior) return next;
  if (prior === "own") return prior;
  if (next === "own") return next;
  if (prior === "manage") return prior;
  if (next === "manage") return next;
  return prior;
}

/** Display label for a membership verb: admin for own/manage, member otherwise. */
export function membershipVerbLabel(verb: MembershipVerb | undefined): "admin" | "member" {
  return verb === "own" || verb === "manage" ? "admin" : "member";
}
