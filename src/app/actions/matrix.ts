"use server";

/**
 * Matrix server actions for authenticated Matrix credential retrieval.
 *
 * Purpose:
 * - Provide authenticated access to Matrix credentials for the current user.
 * - Look up Matrix user IDs for DM targeting.
 *
 * Key exports:
 * - `getMatrixCredentials` — returns the current user's Matrix credentials.
 * - `getDmRoomForUser` — returns the target user's Matrix user ID for DM creation.
 *
 * Dependencies:
 * - `@/auth` for session authentication.
 * - `@/db` for database queries.
 * - `@/db/schema` for the agents table.
 */
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources, ledger, groupMatrixRooms, dmRooms } from "@/db/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import {
  adminJoinRoom,
  createGroupRoomAsAdmin,
  getRoomMembers,
  postSystemNotice,
} from "@/lib/matrix-admin";
import { provisionMatrixUser } from "@/lib/matrix-admin";
import { MatrixProvisioningError } from "@/lib/matrix-errors";

/**
 * Ensures an agent has a fully-provisioned Matrix identity, treating null
 * access tokens as "not provisioned." Returns the agent's Matrix user ID
 * on success, or null on any failure.
 *
 * Behavior:
 * - If both `matrixUserId` and `matrixAccessToken` are set, returns the user id
 *   without touching Synapse.
 * - If either column is null/empty, calls `provisionMatrixUser` (which is
 *   idempotent on Synapse — re-creating a user is a no-op, re-issuing a token
 *   always works) and persists BOTH columns atomically in a single UPDATE.
 *   On any failure, the DB is left untouched, leaving the row marked as
 *   "not provisioned" so the next call retries cleanly.
 * - If the agent record doesn't exist, returns null.
 */
async function ensureAgentMatrixIdentity(agentId: string): Promise<string | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: {
      id: true,
      name: true,
      email: true,
      matrixUserId: true,
      matrixAccessToken: true,
    },
  });

  if (!agent) return null;

  // Treat empty strings the same as null — an empty access token is unusable.
  const hasValidUserId =
    typeof agent.matrixUserId === "string" && agent.matrixUserId.length > 0;
  const hasValidToken =
    typeof agent.matrixAccessToken === "string" &&
    agent.matrixAccessToken.length > 0;

  if (hasValidUserId && hasValidToken) return agent.matrixUserId as string;

  // Half-provisioned state (userId set, token missing) is recoverable because
  // Synapse PUT is idempotent and `/login` can re-issue tokens for existing
  // users. Log it explicitly so we can spot recurring drift in monitoring.
  if (hasValidUserId && !hasValidToken) {
    console.warn(
      "[matrix] Agent has matrixUserId but null/empty matrixAccessToken; re-provisioning:",
      agentId,
    );
  }

  try {
    const localpart = agent.id.replace(/-/g, "");
    const result = await provisionMatrixUser({
      localpart,
      displayName: agent.name,
    });

    // Atomic write — both columns set together so callers can rely on the
    // invariant: matrixAccessToken non-null implies matrixUserId non-null.
    // If this UPDATE fails (very rare; only catastrophic DB faults), we
    // explicitly clear any stale row so a future retry can re-provision
    // cleanly without leaving a half-state behind.
    try {
      await db
        .update(agents)
        .set({
          matrixUserId: result.matrixUserId,
          matrixAccessToken: result.accessToken,
        })
        .where(eq(agents.id, agent.id));
    } catch (dbError) {
      console.error(
        "[matrix] DB write of new Matrix credentials failed; clearing partial state for agent:",
        agentId,
        dbError,
      );
      // Best-effort rollback. If this also fails, the row is stale but a
      // subsequent ensureAgentMatrixIdentity call will treat null token as
      // not-provisioned and retry — so we don't bubble this cascade error.
      await db
        .update(agents)
        .set({ matrixUserId: null, matrixAccessToken: null })
        .where(eq(agents.id, agent.id))
        .catch((rollbackError) => {
          console.error(
            "[matrix] Rollback of partial Matrix state also failed for agent:",
            agentId,
            rollbackError,
          );
        });
      return null;
    }

    return result.matrixUserId;
  } catch (error) {
    if (error instanceof MatrixProvisioningError) {
      console.error(
        `[matrix] Provisioning stage=${error.stage} failed for agent ${agentId}:`,
        error.message,
      );
    } else {
      console.error(
        "[matrix] Unexpected provisioning error for agent:",
        agentId,
        error,
      );
    }
    return null;
  }
}

/**
 * Retrieves Matrix credentials for the currently authenticated user.
 *
 * @returns Matrix userId, accessToken, and homeserverUrl, or null if not authenticated
 *          or if the user has no Matrix credentials provisioned.
 */
export async function getMatrixCredentials(): Promise<{
  userId: string;
  accessToken: string;
  homeserverUrl: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, session.user.id),
    columns: {
      id: true,
      matrixUserId: true,
      matrixAccessToken: true,
    },
  });

  if (!agent) return null;

  let matrixUserId = agent.matrixUserId;
  let matrixAccessToken = agent.matrixAccessToken;

  if (!matrixUserId || !matrixAccessToken) {
    matrixUserId = await ensureAgentMatrixIdentity(agent.id);
    if (!matrixUserId) return null;

    const refreshed = await db.query.agents.findFirst({
      where: eq(agents.id, agent.id),
      columns: {
        matrixAccessToken: true,
      },
    });
    matrixAccessToken = refreshed?.matrixAccessToken ?? null;
  }

  if (!matrixUserId || !matrixAccessToken) return null;

  return {
    userId: matrixUserId,
    accessToken: matrixAccessToken,
    homeserverUrl: process.env.NEXT_PUBLIC_MATRIX_HOMESERVER_URL || "",
  };
}

/**
 * Looks up the Matrix user ID for a target agent, used for initiating DMs.
 *
 * @param targetAgentId - The UUID of the agent to look up
 * @returns The target agent's Matrix user ID, or null if not found or not provisioned.
 */
export async function getDmRoomForUser(targetAgentId: string): Promise<{
  targetMatrixUserId: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const matrixUserId = await ensureAgentMatrixIdentity(targetAgentId);
  if (!matrixUserId) return null;

  return {
    targetMatrixUserId: matrixUserId,
  };
}

/**
 * Looks up Matrix user IDs for multiple target agents.
 * Used for creating group DM rooms with multiple participants.
 *
 * @param targetAgentIds - Array of agent UUIDs to look up
 * @returns Array of Matrix user IDs for agents that have Matrix credentials provisioned.
 */
export async function getMatrixUserIdsForAgents(
  targetAgentIds: string[]
): Promise<string[]> {
  const session = await auth();
  if (!session?.user?.id) return [];
  if (targetAgentIds.length === 0) return [];

  // Cap to prevent unbounded concurrent identity provisioning requests.
  const MAX_MATRIX_AGENT_IDS = 50;
  const cappedIds = targetAgentIds.slice(0, MAX_MATRIX_AGENT_IDS);

  const matrixUserIds = await Promise.all(cappedIds.map((agentId) => ensureAgentMatrixIdentity(agentId)));
  return matrixUserIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Force-joins the target user into a DM room so they see it immediately
 * without needing to manually accept an invite.
 *
 * @param targetMatrixUserId - Full Matrix user ID to join
 * @param roomId - The Matrix room ID to join them into
 */
export async function ensureUserJoinedRoom(
  targetMatrixUserId: string,
  roomId: string
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  // Validate Matrix identifier formats to prevent injection of arbitrary strings into admin API calls.
  if (!targetMatrixUserId.startsWith("@")) {
    console.error("[matrix] ensureUserJoinedRoom: invalid targetMatrixUserId, must start with @");
    return;
  }
  if (!roomId.startsWith("!")) {
    console.error("[matrix] ensureUserJoinedRoom: invalid roomId, must start with !");
    return;
  }

  try {
    await adminJoinRoom({ userId: targetMatrixUserId, roomId });
  } catch (err) {
    console.error("[matrix] adminJoinRoom failed:", err);
  }
}

// ─── dmRooms mirror ────────────────────────────────────────────────────────

/**
 * Records a DM (1:1 or group) into the RIVR-side `dm_rooms` mirror table.
 *
 * Called by `getOrCreateDmRoom`/`createGroupDmRoom` (client-side) right
 * after Synapse confirms the new room. The mirror is keyed by
 * `matrixRoomId` so reposting an existing pairing is a no-op — we only
 * insert when the row doesn't already exist for that room (and is not
 * tombstoned). Failures are logged but never propagated to the caller;
 * a missing mirror row is recoverable via reconcile.
 *
 * @param matrixRoomId - The Matrix room ID (must start with `!`)
 * @param participantAgentIds - RIVR agent IDs of all participants
 *   including the caller. Stored in the row so a homeserver migration
 *   can rebuild the room with the same participants.
 */
export async function recordDmRoomMirror(
  matrixRoomId: string,
  participantAgentIds: string[],
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  if (!matrixRoomId.startsWith("!")) {
    console.error("[matrix] recordDmRoomMirror: invalid roomId:", matrixRoomId);
    return;
  }

  // Dedupe + ensure the caller is always in the participants list so the
  // mirror is internally consistent even if the client forgot to include
  // themselves.
  const participants = Array.from(
    new Set([session.user.id, ...participantAgentIds.filter(Boolean)]),
  );

  try {
    const existing = await db.query.dmRooms.findFirst({
      where: and(eq(dmRooms.matrixRoomId, matrixRoomId), isNull(dmRooms.deletedAt)),
      columns: { id: true },
    });

    if (existing) {
      // Refresh updatedAt + participants in case the membership grew.
      await db
        .update(dmRooms)
        .set({ participants, updatedAt: new Date() })
        .where(eq(dmRooms.id, existing.id));
      return;
    }

    await db.insert(dmRooms).values({
      matrixRoomId,
      participants,
    });
  } catch (err) {
    // Don't surface to the caller — mirror is recoverable via reconcile.
    console.error(
      `[matrix] recordDmRoomMirror failed for ${matrixRoomId}:`,
      err,
    );
  }
}

// ─── Add-to-chat & DM→Group promotion ──────────────────────────────────────

/**
 * Per-agent outcome for `addParticipantsToRoom`. Failures carry a reason
 * string so the UI can show "could not add @X: not provisioned" instead of
 * silently dropping the agent.
 */
export interface AddParticipantsFailure {
  agentId: string;
  reason: string;
}

/**
 * Result of `addParticipantsToRoom`. If the original room was a 1:1 DM and
 * new participants were added, `promotedToRoomId` carries the new group
 * room ID so the client can navigate. Otherwise it's null and the new
 * participants joined the original room.
 */
export interface AddParticipantsResult {
  /** Agent IDs that were successfully invited/joined */
  added: string[];
  /** Per-agent failures with reasons */
  failed: AddParticipantsFailure[];
  /** New group room ID when a 1:1 DM was promoted; null otherwise */
  promotedToRoomId: string | null;
}

/** Maximum number of new participants accepted in one call (prevents abuse). */
const MAX_PARTICIPANTS_PER_CALL = 50;

/**
 * Adds one or more agents to an existing Matrix room. For each agent we:
 *   1. Ensure the agent has a Matrix identity (provisioning if needed).
 *   2. Force-join them into the target room via the Synapse admin API
 *      (`/_synapse/admin/v1/join/{roomId}`), which both invites and accepts
 *      so the room appears immediately without manual confirmation.
 *
 * If the target room is a 1:1 DM (exactly 2 current members) and at least
 * one new agent is being added, the room is promoted to a fresh group room:
 *   - A new room is created with the original 2 members + new participants.
 *   - A system notice is posted in the new room.
 *   - The new room ID is returned via `promotedToRoomId` for client-side
 *     navigation. The original DM is left untouched (clients can leave it
 *     via the existing leave path if desired).
 *
 * @param roomId - Existing Matrix room ID (must start with `!`)
 * @param agentIds - RIVR agent IDs (UUIDs) to add as participants
 * @returns Result with per-agent success/failure and optional promotion target
 */
export async function addParticipantsToRoom(
  roomId: string,
  agentIds: string[],
): Promise<AddParticipantsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      added: [],
      failed: agentIds.map((agentId) => ({
        agentId,
        reason: "Not authenticated",
      })),
      promotedToRoomId: null,
    };
  }

  if (!roomId.startsWith("!")) {
    return {
      added: [],
      failed: agentIds.map((agentId) => ({
        agentId,
        reason: "Invalid roomId: must start with !",
      })),
      promotedToRoomId: null,
    };
  }

  // Dedupe + cap to keep things bounded.
  const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean))).slice(
    0,
    MAX_PARTICIPANTS_PER_CALL,
  );

  if (uniqueAgentIds.length === 0) {
    return { added: [], failed: [], promotedToRoomId: null };
  }

  // Ensure all target agents have Matrix identities first. Provisioning is
  // serialized inside ensureAgentMatrixIdentity but we run the lookups in
  // parallel here.
  const resolved = await Promise.all(
    uniqueAgentIds.map(async (agentId) => {
      try {
        const matrixUserId = await ensureAgentMatrixIdentity(agentId);
        return { agentId, matrixUserId };
      } catch (err) {
        return {
          agentId,
          matrixUserId: null as string | null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const failed: AddParticipantsFailure[] = [];
  const targetsToInvite: { agentId: string; matrixUserId: string }[] = [];
  for (const entry of resolved) {
    if (!entry.matrixUserId) {
      failed.push({
        agentId: entry.agentId,
        reason:
          ("reason" in entry && typeof entry.reason === "string"
            ? entry.reason
            : null) ?? "Could not provision Matrix identity",
      });
      continue;
    }
    targetsToInvite.push({
      agentId: entry.agentId,
      matrixUserId: entry.matrixUserId,
    });
  }

  if (targetsToInvite.length === 0) {
    return { added: [], failed, promotedToRoomId: null };
  }

  // Detect whether this is a 1:1 DM we should promote. Failure to read the
  // member list (e.g. transient Synapse hiccup) falls back to a plain
  // invite to preserve the user's intent.
  let currentMembers: string[] = [];
  try {
    currentMembers = await getRoomMembers(roomId);
  } catch (err) {
    console.warn(
      `[matrix] addParticipantsToRoom: getRoomMembers failed for ${roomId}; treating as non-DM:`,
      err,
    );
    currentMembers = [];
  }

  const isOneToOneDm = currentMembers.length === 2;
  const callerAgent = await db.query.agents.findFirst({
    where: eq(agents.id, session.user.id),
    columns: { matrixUserId: true },
  });
  const callerMatrixUserId = callerAgent?.matrixUserId ?? null;

  if (isOneToOneDm && targetsToInvite.length > 0 && callerMatrixUserId) {
    // Promote the DM to a fresh group room with all members.
    const allInvitees = Array.from(
      new Set([
        ...currentMembers.filter((m) => m !== callerMatrixUserId),
        ...targetsToInvite.map((t) => t.matrixUserId),
      ]),
    );

    try {
      const { roomId: newRoomId } = await createGroupRoomAsAdmin({
        creatorUserId: callerMatrixUserId,
        inviteeUserIds: allInvitees,
      });

      // Force-join every invitee so they see the room without manually
      // accepting. Best-effort: any individual failure shows up in `failed`.
      const added: string[] = [];
      for (const target of targetsToInvite) {
        try {
          await adminJoinRoom({
            userId: target.matrixUserId,
            roomId: newRoomId,
          });
          added.push(target.agentId);
        } catch (err) {
          failed.push({
            agentId: target.agentId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Also force-join the original other-party (the previous DM partner)
      // so the new room has continuity for them.
      for (const memberId of currentMembers) {
        if (memberId === callerMatrixUserId) continue;
        try {
          await adminJoinRoom({ userId: memberId, roomId: newRoomId });
        } catch (err) {
          console.error(
            `[matrix] promotion: failed to force-join prior DM partner ${memberId}:`,
            err,
          );
        }
      }

      // Post a system notice marking the upgrade. Non-blocking — if it
      // fails the promotion still succeeded.
      try {
        await postSystemNotice({
          senderUserId: callerMatrixUserId,
          roomId: newRoomId,
          body: "Conversation upgraded to group chat",
        });
      } catch (err) {
        console.error("[matrix] promotion: postSystemNotice failed:", err);
      }

      // Mirror the new group DM row so the room survives a homeserver
      // migration. Failure to mirror doesn't affect the promotion success.
      try {
        await recordDmRoomMirror(newRoomId, [
          session.user.id,
          ...targetsToInvite.map((t) => t.agentId),
        ]);
      } catch (err) {
        console.error("[matrix] promotion: recordDmRoomMirror failed:", err);
      }

      return { added, failed, promotedToRoomId: newRoomId };
    } catch (err) {
      // Promotion failed — fall through to the plain-invite path so the
      // user still gets *some* effect rather than a silent error.
      console.error(
        `[matrix] addParticipantsToRoom: promotion failed for ${roomId}; falling back to direct invite:`,
        err,
      );
    }
  }

  // Non-DM (or promotion fallback): force-join everyone into the existing room.
  const added: string[] = [];
  for (const target of targetsToInvite) {
    try {
      await adminJoinRoom({ userId: target.matrixUserId, roomId });
      added.push(target.agentId);
    } catch (err) {
      failed.push({
        agentId: target.agentId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { added, failed, promotedToRoomId: null };
}

/**
 * Resolves a marketplace listing to its owner's Matrix user ID.
 *
 * @param listingId - Resource id for the marketplace listing.
 * @returns The seller's Matrix user ID, or null if the listing/seller cannot be resolved.
 */
export async function getDmRoomForListing(listingId: string): Promise<{
  targetMatrixUserId: string;
} | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const listing = await db.query.resources.findFirst({
    where: eq(resources.id, listingId),
    columns: {
      ownerId: true,
    },
  });

  if (!listing?.ownerId) return null;

  const matrixUserId = await ensureAgentMatrixIdentity(listing.ownerId);
  if (!matrixUserId) return null;

  return {
    targetMatrixUserId: matrixUserId,
  };
}

/**
 * Fetches all group rooms the current user is a member of.
 *
 * Queries the ledger for active "join" memberships, then resolves
 * each group's Matrix room via the group_matrix_rooms table. Also
 * fetches sub-groups (children agents) for each group.
 *
 * @returns Array of group room metadata, or null if not authenticated.
 */
export async function getUserGroupRooms(): Promise<
  {
    groupId: string;
    groupName: string;
    groupImage: string | null;
    matrixRoomId: string;
    chatMode: string;
    subgroups: { id: string; name: string; matrixRoomId: string | null }[];
  }[]
| null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  // 1. Find all groups the user has actively joined
  const memberships = await db
    .select({
      objectId: ledger.objectId,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, session.user.id),
        eq(ledger.verb, "join"),
        eq(ledger.isActive, true)
      )
    );

  const groupIds = memberships
    .map((m) => m.objectId)
    .filter((id): id is string => id !== null);

  if (groupIds.length === 0) return [];

  // 2. Fetch the group agents
  const groupAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      image: agents.image,
    })
    .from(agents)
    .where(inArray(agents.id, groupIds));

  // 3. Fetch Matrix room mappings for these groups
  // Soft-deleted rows (deletedAt IS NOT NULL) are excluded so we don't surface
  // rooms whose underlying Synapse room has been purged.
  const matrixRooms = await db
    .select({
      groupAgentId: groupMatrixRooms.groupAgentId,
      matrixRoomId: groupMatrixRooms.matrixRoomId,
      chatMode: groupMatrixRooms.chatMode,
    })
    .from(groupMatrixRooms)
    .where(
      and(
        inArray(groupMatrixRooms.groupAgentId, groupIds),
        isNull(groupMatrixRooms.deletedAt),
      ),
    );

  const roomsByGroupId = new Map(
    matrixRooms.map((r) => [r.groupAgentId, r])
  );

  // 4. Fetch sub-groups (children) for each group
  const subgroupAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      parentId: agents.parentId,
    })
    .from(agents)
    .where(inArray(agents.parentId, groupIds));

  // Fetch Matrix rooms for sub-groups that have them
  const subgroupIds = subgroupAgents.map((s) => s.id);
  const subgroupMatrixRooms =
    subgroupIds.length > 0
      ? await db
          .select({
            groupAgentId: groupMatrixRooms.groupAgentId,
            matrixRoomId: groupMatrixRooms.matrixRoomId,
          })
          .from(groupMatrixRooms)
          .where(
            and(
              inArray(groupMatrixRooms.groupAgentId, subgroupIds),
              isNull(groupMatrixRooms.deletedAt),
            ),
          )
      : [];

  const subgroupRoomMap = new Map(
    subgroupMatrixRooms.map((r) => [r.groupAgentId, r.matrixRoomId])
  );

  const subgroupsByParent = new Map<
    string,
    { id: string; name: string; matrixRoomId: string | null }[]
  >();
  for (const sub of subgroupAgents) {
    if (!sub.parentId) continue;
    const list = subgroupsByParent.get(sub.parentId) ?? [];
    list.push({
      id: sub.id,
      name: sub.name,
      matrixRoomId: subgroupRoomMap.get(sub.id) ?? null,
    });
    subgroupsByParent.set(sub.parentId, list);
  }

  // 5. Assemble results — only include groups that have a Matrix room
  const results: {
    groupId: string;
    groupName: string;
    groupImage: string | null;
    matrixRoomId: string;
    chatMode: string;
    subgroups: { id: string; name: string; matrixRoomId: string | null }[];
  }[] = [];

  for (const group of groupAgents) {
    const room = roomsByGroupId.get(group.id);
    if (!room) continue;

    results.push({
      groupId: group.id,
      groupName: group.name,
      groupImage: group.image,
      matrixRoomId: room.matrixRoomId,
      chatMode: room.chatMode,
      subgroups: subgroupsByParent.get(group.id) ?? [],
    });
  }

  return results;
}
