/**
 * @fileoverview Server-side fact gathering for the governance eligibility
 * engine (`governance-eligibility.ts`). Resolves an actor's membership/admin/
 * badge/ABAC facts against the owning group so the pure evaluator can decide.
 *
 * REDUCED port (this repo has no share-class rail): `shareHoldings` always
 * resolves empty, so a `share-holder` gate — which can only arrive on a
 * federated projection authored on group/global — safely denies here rather
 * than trusting unverifiable holdings. Do NOT add a share-class lookup without
 * porting the group repo's share-class rail first.
 *
 * Kept out of the actions file: pages import these helpers directly, and a
 * `"use server"` module must only export server actions.
 */

import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isGroupMember, check } from "@/lib/permissions";
import { isGroupAdmin } from "@/app/actions/group-admin";
import {
  combinedFactNeeds,
  gateFactNeeds,
  evaluateEligibilityGate,
  type EligibilityFactNeeds,
  type EligibilityFacts,
  type EligibilityGate,
  type EligibilityVerdict,
} from "@/lib/governance-eligibility";

const EMPTY_FACTS: EligibilityFacts = {
  isAuthenticated: false,
  isMember: false,
  isAdmin: false,
  heldBadgeIds: [],
  shareHoldings: {},
  abacAllowed: false,
};

/** The group's governance badges (id + name), oldest first. */
export async function listGovernanceBadges(
  groupId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: resources.id, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, groupId),
        eq(resources.type, "badge"),
        sql`${resources.metadata}->>'badgeType' = 'governance'`,
        sql`${resources.deletedAt} IS NULL`,
      ),
    );
  return rows.map((r) => ({ id: r.id, name: r.name ?? "Badge" }));
}

/** Active governance-badge ids (of this group) the actor holds. */
async function resolveHeldGovernanceBadgeIds(userId: string, groupId: string): Promise<string[]> {
  const badges = await listGovernanceBadges(groupId);
  if (badges.length === 0) return [];
  const badgeIds = badges.map((b) => b.id);
  const assignments = await db
    .select({ objectId: ledger.objectId })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, "assign"),
        eq(ledger.isActive, true),
        inArray(ledger.objectId, badgeIds),
      ),
    );
  return assignments.map((a) => a.objectId).filter((id): id is string => id !== null);
}

/**
 * Resolve only the fact families `needs` asks for (the rest stay at their
 * false/empty defaults). Anonymous actors resolve to {@link EMPTY_FACTS}.
 */
export async function resolveGovernanceEligibilityFacts(
  userId: string | null | undefined,
  groupId: string,
  needs: EligibilityFactNeeds,
): Promise<EligibilityFacts> {
  if (!userId) return { ...EMPTY_FACTS };

  const [membership, isAdmin, heldBadgeIds, abacResult] = await Promise.all([
    needs.member ? isGroupMember(userId, groupId) : Promise.resolve({ isMember: false }),
    needs.admin ? isGroupAdmin(userId, groupId) : Promise.resolve(false),
    needs.badges ? resolveHeldGovernanceBadgeIds(userId, groupId) : Promise.resolve([]),
    needs.abac
      ? check(userId, "vote", groupId, "agent").catch((error) => {
          console.error("[governance-eligibility] abac check failed:", error);
          return { allowed: false };
        })
      : Promise.resolve({ allowed: false }),
  ]);

  return {
    isAuthenticated: true,
    isMember: membership.isMember,
    isAdmin,
    heldBadgeIds,
    // No share-class rail in this repo — see the fileoverview.
    shareHoldings: {},
    abacAllowed: abacResult.allowed === true,
  };
}

/** Resolve facts for one gate and evaluate it — the single-item convenience. */
export async function evaluateGovernanceGateForUser(
  userId: string | null | undefined,
  groupId: string,
  gate: EligibilityGate,
): Promise<EligibilityVerdict> {
  const facts = await resolveGovernanceEligibilityFacts(userId, groupId, gateFactNeeds(gate));
  return evaluateEligibilityGate(gate, facts);
}

/**
 * Batch evaluation for a page render: resolve the union of the gates' fact
 * needs ONCE, then evaluate each gate against the shared facts.
 */
export async function evaluateGovernanceGatesForUser(
  userId: string | null | undefined,
  groupId: string,
  gates: readonly EligibilityGate[],
): Promise<EligibilityVerdict[]> {
  if (gates.length === 0) return [];
  const facts = await resolveGovernanceEligibilityFacts(userId, groupId, combinedFactNeeds(gates));
  return gates.map((gate) => evaluateEligibilityGate(gate, facts));
}
