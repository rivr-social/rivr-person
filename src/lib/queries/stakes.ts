/**
 * Stake query module for group membership contribution data.
 *
 * Purpose:
 * - Aggregates ledger entries to derive member stakes and contribution metrics.
 * - Provides group-scoped membership and contribution data for stake UI.
 *
 * Key exports:
 * - `getMemberStakesForGroup`: Returns member stake data with contribution metrics.
 * - `calculateTotalStakes`: Sums profit share percentages for a set of stakes.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for Drizzle database access.
 * - `drizzle-orm` SQL templating for aggregation queries.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import type { MemberStake } from "@/lib/types";

/**
 * Returns member stake data for a group by aggregating ledger entries.
 *
 * Membership is determined by active 'join' or 'belong' ledger edges pointing
 * at the group. Contribution metrics are counted ONLY within that group.
 *
 * ## The group scope (fixed 2026-08-03 — Cameron: "people are allocated stake
 * who have done no jobs")
 *
 * This query used to join `ledger ml ON ml.subject_id = gm.member_id` with NO
 * group predicate at all, so every `create`/`approve`/`endorse`/`propose`/
 * `vote` a member had EVER made — in any other group, on their own profile,
 * anywhere on the platform — counted toward their share of THIS group. On prod
 * that handed a member 4 contribution points in the RIVR org while they had
 * done nothing in it, and because profit share is proportional, it diluted
 * everyone who actually had. (The docstring claimed the counts were "scoped to
 * the group context". They were not.)
 *
 * A row counts for this group when any of these is true — decided once in
 * `group_scoped_ledger` below and used by EVERY metric:
 *
 *   1. its object is a RESOURCE owned by the group — the load-bearing case,
 *      and the one `earned_points` already got right;
 *   2. `metadata.groupId` names the group explicitly;
 *   3. its object IS the group agent (endorsing or voting on the group itself).
 *
 * Scoping on `metadata.groupId` alone would NOT work: it is absent from most
 * rows, including creates of resources the group owns.
 *
 * Rows must also be `is_active` — a reverted or superseded edge is not a
 * contribution, and the old query counted those too.
 *
 * @param groupId Group agent UUID.
 * @returns Array of MemberStake records for all active group members.
 * @throws Propagates database/connection errors from the underlying query.
 */
export async function getMemberStakesForGroup(groupId: string): Promise<MemberStake[]> {
  const result = await db.execute(sql`
    WITH group_members AS (
      SELECT
        l.subject_id as member_id,
        MIN(l.timestamp) as joined_at
      FROM ledger l
      WHERE l.object_id = ${groupId}::uuid
        AND l.verb IN ('join', 'belong')
        AND l.is_active = true
      GROUP BY l.subject_id
    ),
    -- Every ledger row that belongs to THIS group, by any of the three
    -- recognized signals. All contribution metrics below read from here, so a
    -- member's activity elsewhere on the platform can never earn stake here.
    group_scoped_ledger AS (
      SELECT l.*
      FROM ledger l
      WHERE l.is_active = true
        AND (
          EXISTS (
            SELECT 1 FROM resources r
            WHERE r.id = l.object_id
              AND r.owner_id = ${groupId}::uuid
              AND r.deleted_at IS NULL
          )
          OR l.metadata->>'groupId' = ${groupId}
          OR l.object_id = ${groupId}::uuid
        )
    ),
    member_contributions AS (
      SELECT
        gm.member_id,
        gm.joined_at,
        COALESCE(SUM(CASE WHEN ml.verb = 'create' THEN 1 ELSE 0 END), 0)::int as offers_created,
        COALESCE(SUM(CASE WHEN ml.verb = 'approve' THEN 1 ELSE 0 END), 0)::int as offers_accepted,
        COALESCE(SUM(CASE WHEN ml.verb = 'endorse' THEN 1 ELSE 0 END), 0)::int as thanks_given,
        COALESCE(SUM(CASE WHEN ml.verb = 'propose' THEN 1 ELSE 0 END), 0)::int as proposals_created,
        COALESCE(SUM(CASE WHEN ml.verb = 'vote' THEN 1 ELSE 0 END), 0)::int as votes_participated
      FROM group_members gm
      LEFT JOIN group_scoped_ledger ml ON ml.subject_id = gm.member_id
      GROUP BY gm.member_id, gm.joined_at
    ),
    -- Thanks a member RECEIVED for work in this group. Scoped by the group
    -- context recorded on the endorsement, not by the member being the object:
    -- an endorsement whose object is the member cannot also have the group as
    -- its object, so group_scoped_ledger does not apply here.
    thanks_received AS (
      SELECT
        l.object_id as member_id,
        COUNT(*)::int as count
      FROM ledger l
      WHERE l.object_id IN (SELECT member_id FROM group_members)
        AND l.verb = 'endorse'
        AND l.is_active = true
        AND (
          l.metadata->>'groupId' = ${groupId}
          OR EXISTS (
            -- The uuid cast is guarded: contextId is free-form metadata, and a
            -- non-uuid value would abort the whole query rather than skip a row.
            SELECT 1 FROM resources r
            WHERE l.metadata->>'contextId' ~ '^[0-9a-fA-F-]{36}$'
              AND r.id = (l.metadata->>'contextId')::uuid
              AND r.owner_id = ${groupId}::uuid
              AND r.deleted_at IS NULL
          )
        )
      GROUP BY l.object_id
    )
    SELECT
      mc.member_id,
      mc.joined_at,
      mc.offers_created,
      mc.offers_accepted,
      COALESCE(tr.count, 0)::int as thanks_received,
      mc.thanks_given,
      mc.proposals_created,
      mc.votes_participated,
      a.name as user_name,
      COALESCE(a.metadata->>'username', a.name) as username,
      COALESCE(a.description, '') as bio,
      COALESCE(a.image, '') as avatar
    FROM member_contributions mc
    JOIN agents a ON mc.member_id = a.id
    LEFT JOIN thanks_received tr ON tr.member_id = mc.member_id
    WHERE a.deleted_at IS NULL
    ORDER BY (mc.offers_created + mc.offers_accepted + COALESCE(tr.count, 0) + mc.proposals_created + mc.votes_participated) DESC
  `);

  const rows = result as Record<string, unknown>[];

  // Calculate total contribution score for proportional profit share.
  const totalScore = rows.reduce((sum, row) => {
    return sum
      + Number(row.offers_created ?? 0)
      + Number(row.offers_accepted ?? 0)
      + Number(row.thanks_received ?? 0)
      + Number(row.proposals_created ?? 0)
      + Number(row.votes_participated ?? 0);
  }, 0);

  return rows.map((row) => {
    const memberScore =
      Number(row.offers_created ?? 0)
      + Number(row.offers_accepted ?? 0)
      + Number(row.thanks_received ?? 0)
      + Number(row.proposals_created ?? 0)
      + Number(row.votes_participated ?? 0);

    return {
      user: {
        id: row.member_id as string,
        name: row.user_name as string,
        username: row.username as string,
        bio: row.bio as string,
        avatar: row.avatar as string,
        followers: 0,
        following: 0,
      },
      profitShare: totalScore > 0
        ? Number(((memberScore / totalScore) * 100).toFixed(1))
        : 0,
      contributionMetrics: {
        offersCreated: Number(row.offers_created ?? 0),
        offersAccepted: Number(row.offers_accepted ?? 0),
        thanksReceived: Number(row.thanks_received ?? 0),
        thanksGiven: Number(row.thanks_given ?? 0),
        proposalsCreated: Number(row.proposals_created ?? 0),
        votesParticipated: Number(row.votes_participated ?? 0),
      },
      joinedAt: (row.joined_at as Date).toISOString(),
      groupId,
    };
  });
}

/**
 * Sums the profit share percentages for a set of member stakes.
 *
 * @param stakes Array of MemberStake records.
 * @returns Total profit share percentage.
 */
export function calculateTotalStakes(stakes: MemberStake[]): number {
  return stakes.reduce((sum, s) => sum + s.profitShare, 0);
}
