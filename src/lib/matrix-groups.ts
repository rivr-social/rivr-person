"use server";

/**
 * Server-side Matrix group room management.
 *
 * Purpose:
 * - Create and manage Matrix rooms for group agents.
 * - Invite/remove members from group Matrix rooms.
 * - Toggle chat mode (ledger, matrix, both) for groups.
 *
 * Key exports:
 * - `createGroupMatrixRoom` — creates a Matrix room and links it to a group agent.
 * - `inviteToGroupRoom` — invites a user to a group's Matrix room.
 * - `removeFromGroupRoom` — kicks a user from a group's Matrix room.
 * - `setGroupChatMode` — updates the chat mode for a group's Matrix room.
 * - `getGroupMatrixRoom` — fetches the Matrix room record for a group.
 *
 * Dependencies:
 * - `@/lib/env` for Matrix configuration.
 * - `@/db` for group_matrix_rooms table operations.
 * - `@/db/schema` for table definitions.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db } from "@/db";
import { agents, groupMatrixRooms, dmRooms, type ChatMode } from "@/db/schema";

/**
 * Makes an authenticated request to the Synapse Admin API.
 */
async function synapseAdminRequest(path: string, options: RequestInit = {}) {
  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  const response = await fetch(`${homeserverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Synapse admin API error: ${response.status} - ${JSON.stringify(error)}`
    );
  }

  return response.json();
}

/**
 * Creates a Matrix room for a group and stores the mapping in group_matrix_rooms.
 *
 * The room is created via the Synapse Admin API as a public group chat.
 * The group's owner (creator) is set as the room admin.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.groupName - Display name for the room
 * @param params.creatorMatrixUserId - Matrix user ID of the group creator
 * @param params.chatMode - Initial chat mode (default: "both")
 * @returns The Matrix room ID and the database record ID
 */
export async function createGroupMatrixRoom(params: {
  groupAgentId: string;
  groupName: string;
  creatorMatrixUserId: string;
  chatMode?: ChatMode;
}): Promise<{ matrixRoomId: string; recordId: string }> {
  // Check if a live (not soft-deleted) room already exists for this group.
  // Tombstoned rows must not be reused — their Synapse room has been purged.
  const existing = await db.query.groupMatrixRooms.findFirst({
    where: and(
      eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
      isNull(groupMatrixRooms.deletedAt),
    ),
  });

  if (existing) {
    return { matrixRoomId: existing.matrixRoomId, recordId: existing.id };
  }

  // Create room via Synapse Admin API
  const result = await synapseAdminRequest("/_synapse/admin/v1/rooms", {
    method: "POST",
    body: JSON.stringify({
      creator: params.creatorMatrixUserId,
      name: params.groupName,
      topic: `Group chat for ${params.groupName}`,
      preset: "private_chat",
      room_alias_name: `group-${params.groupAgentId.replace(/-/g, "")}`,
    }),
  });

  const matrixRoomId: string = result.room_id;

  // Store the mapping
  const [record] = await db
    .insert(groupMatrixRooms)
    .values({
      groupAgentId: params.groupAgentId,
      matrixRoomId,
      chatMode: params.chatMode ?? "both",
    })
    .returning({ id: groupMatrixRooms.id });

  return { matrixRoomId, recordId: record.id };
}

/**
 * Invites a user to a group's Matrix room.
 *
 * Looks up both the group's Matrix room and the target user's Matrix ID,
 * then sends an invite via the Synapse Admin API.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.targetAgentId - UUID of the user agent to invite
 */
export async function inviteToGroupRoom(params: {
  groupAgentId: string;
  targetAgentId: string;
}): Promise<void> {
  const groupRoom = await db.query.groupMatrixRooms.findFirst({
    where: and(
      eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
      isNull(groupMatrixRooms.deletedAt),
    ),
  });

  if (!groupRoom) {
    throw new Error(`No Matrix room found for group ${params.groupAgentId}`);
  }

  const targetAgent = await db.query.agents.findFirst({
    where: eq(agents.id, params.targetAgentId),
    columns: { matrixUserId: true },
  });

  if (!targetAgent?.matrixUserId) {
    throw new Error(
      `Target agent ${params.targetAgentId} has no Matrix account`
    );
  }

  // Invite via Synapse Admin API
  await synapseAdminRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(groupRoom.matrixRoomId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: targetAgent.matrixUserId,
      }),
    }
  );
}

/**
 * Removes a user from a group's Matrix room by kicking them.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.targetAgentId - UUID of the user agent to remove
 */
export async function removeFromGroupRoom(params: {
  groupAgentId: string;
  targetAgentId: string;
}): Promise<void> {
  const groupRoom = await db.query.groupMatrixRooms.findFirst({
    where: and(
      eq(groupMatrixRooms.groupAgentId, params.groupAgentId),
      isNull(groupMatrixRooms.deletedAt),
    ),
  });

  if (!groupRoom) return; // No room to remove from

  const targetAgent = await db.query.agents.findFirst({
    where: eq(agents.id, params.targetAgentId),
    columns: { matrixUserId: true },
  });

  if (!targetAgent?.matrixUserId) return; // No Matrix account to remove

  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  // Use the standard Matrix API with admin token to kick the user
  await fetch(
    `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(groupRoom.matrixRoomId)}/kick`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        user_id: targetAgent.matrixUserId,
        reason: "Removed from group",
      }),
    }
  );
}

/**
 * Updates the chat mode for a group's Matrix room.
 *
 * @param params.groupAgentId - UUID of the group agent
 * @param params.chatMode - New chat mode ("ledger", "matrix", or "both")
 */
export async function setGroupChatMode(params: {
  groupAgentId: string;
  chatMode: ChatMode;
}): Promise<void> {
  await db
    .update(groupMatrixRooms)
    .set({
      chatMode: params.chatMode,
      updatedAt: new Date(),
    })
    .where(eq(groupMatrixRooms.groupAgentId, params.groupAgentId));
}

/**
 * Fetches the Matrix room record for a group agent.
 *
 * @param groupAgentId - UUID of the group agent
 * @returns The group Matrix room record, or null if none exists
 */
export async function getGroupMatrixRoom(groupAgentId: string) {
  return db.query.groupMatrixRooms.findFirst({
    where: and(
      eq(groupMatrixRooms.groupAgentId, groupAgentId),
      isNull(groupMatrixRooms.deletedAt),
    ),
  }) ?? null;
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Result of one reconciliation pass over the `group_matrix_rooms` table.
 */
export interface ReconcileGroupMatrixRoomsResult {
  /** Total rows considered (rows that are not already soft-deleted). */
  total: number;
  /** Rooms confirmed to still exist in Synapse. */
  alive: number;
  /** Rows newly tombstoned because Synapse returned 404. */
  softDeleted: number;
  /** Errors encountered (network, non-404 Synapse responses, DB write failures). */
  errors: Array<{ recordId: string; matrixRoomId: string; reason: string }>;
}

/**
 * Probes Synapse for room existence via the admin API. Resolves to:
 * - `"alive"` on 2xx
 * - `"missing"` on 404
 * - `"error"` for everything else (including network failures)
 *
 * Exported separately from `reconcileGroupMatrixRooms` so the dmRooms
 * reconciler (in matrix-client) can reuse the exact same probing logic.
 */
export async function probeMatrixRoomExistence(
  matrixRoomId: string,
): Promise<{ status: "alive" } | { status: "missing" } | { status: "error"; reason: string }> {
  if (!matrixRoomId.startsWith("!")) {
    // Synapse room IDs always start with "!"; anything else is malformed and
    // never resolves. Treat as missing so the row is tombstoned and a fresh
    // room can be created next time.
    return { status: "missing" };
  }

  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  if (!homeserverUrl || !adminToken) {
    return {
      status: "error",
      reason: "Matrix admin credentials not configured (MATRIX_HOMESERVER_URL/MATRIX_ADMIN_TOKEN)",
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${homeserverUrl}/_synapse/admin/v1/rooms/${encodeURIComponent(matrixRoomId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
      },
    );
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.ok) return { status: "alive" };
  if (response.status === 404) return { status: "missing" };

  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    // Swallow — we only need the status for the error reason.
  }
  return {
    status: "error",
    reason: `Synapse responded ${response.status}: ${JSON.stringify(body)}`,
  };
}

/**
 * Reconcile the `group_matrix_rooms` table against Synapse. For every live
 * (non-soft-deleted) row, probes Synapse for the room. If Synapse returns
 * 404, the row is marked `deletedAt = now()`. Other errors are logged and
 * the row is left alone so a future pass can retry.
 *
 * Safe to run repeatedly. Non-destructive — never hard-deletes a row, so the
 * historical mapping survives for audit / migration replay.
 *
 * @returns Counts and per-row error details for observability.
 */
export async function reconcileGroupMatrixRooms(): Promise<ReconcileGroupMatrixRoomsResult> {
  const rows = await db
    .select({
      id: groupMatrixRooms.id,
      matrixRoomId: groupMatrixRooms.matrixRoomId,
    })
    .from(groupMatrixRooms)
    .where(isNull(groupMatrixRooms.deletedAt));

  const result: ReconcileGroupMatrixRoomsResult = {
    total: rows.length,
    alive: 0,
    softDeleted: 0,
    errors: [],
  };

  for (const row of rows) {
    const probe = await probeMatrixRoomExistence(row.matrixRoomId);

    if (probe.status === "alive") {
      result.alive += 1;
      continue;
    }

    if (probe.status === "missing") {
      try {
        await db
          .update(groupMatrixRooms)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(groupMatrixRooms.id, row.id));
        result.softDeleted += 1;
      } catch (err) {
        // DB write failure leaves the row alive — next pass will retry.
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ recordId: row.id, matrixRoomId: row.matrixRoomId, reason });
        console.error(
          `[matrix] reconcileGroupMatrixRooms: failed to soft-delete row ${row.id} (${row.matrixRoomId}):`,
          err,
        );
      }
      continue;
    }

    // probe.status === "error" — log and continue per spec.
    result.errors.push({
      recordId: row.id,
      matrixRoomId: row.matrixRoomId,
      reason: probe.reason,
    });
    console.error(
      `[matrix] reconcileGroupMatrixRooms: Synapse probe failed for ${row.matrixRoomId}: ${probe.reason}`,
    );
  }

  return result;
}

/**
 * Module-level latch so we only kick off the lazy startup reconcile once per
 * Node process. The instrumentation hook fires on every cold start, but we
 * don't want to launch a second pass mid-server when something else (e.g. a
 * future hot-reload trigger) imports this module.
 */


// ─── dmRooms reconciliation ─────────────────────────────────────────────────

/**
 * Reconciles the `dm_rooms` mirror against Synapse, using the same
 * `probeMatrixRoomExistence` helper as `reconcileGroupMatrixRooms`. Rows
 * whose underlying Synapse room returned 404 are soft-deleted; other errors
 * are surfaced and the row is left alive.
 */
export async function reconcileDmRooms(): Promise<ReconcileGroupMatrixRoomsResult> {
  const rows = await db
    .select({
      id: dmRooms.id,
      matrixRoomId: dmRooms.matrixRoomId,
    })
    .from(dmRooms)
    .where(isNull(dmRooms.deletedAt));

  const result: ReconcileGroupMatrixRoomsResult = {
    total: rows.length,
    alive: 0,
    softDeleted: 0,
    errors: [],
  };

  for (const row of rows) {
    const probe = await probeMatrixRoomExistence(row.matrixRoomId);

    if (probe.status === "alive") {
      result.alive += 1;
      continue;
    }

    if (probe.status === "missing") {
      try {
        await db
          .update(dmRooms)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(dmRooms.id, row.id));
        result.softDeleted += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ recordId: row.id, matrixRoomId: row.matrixRoomId, reason });
        console.error(
          `[matrix] reconcileDmRooms: failed to soft-delete row ${row.id} (${row.matrixRoomId}):`,
          err,
        );
      }
      continue;
    }

    result.errors.push({
      recordId: row.id,
      matrixRoomId: row.matrixRoomId,
      reason: probe.reason,
    });
    console.error(
      `[matrix] reconcileDmRooms: Synapse probe failed for ${row.matrixRoomId}: ${probe.reason}`,
    );
  }

  return result;
}

/**
 * Returns DM room mirror rows for a given RIVR agent. Used as a fallback
 * when Matrix sync is degraded — the UI can still rebuild the conversation
 * list from the RIVR-side mirror even if the client can't sync m.direct.
 *
 * @param agentId - RIVR agent ID (UUID); rows where this id appears in the
 *   `participants` JSON array are returned.
 */
export async function listDmRoomsForActor(agentId: string): Promise<
  { id: string; matrixRoomId: string; participants: string[]; createdAt: Date; updatedAt: Date }[]
> {
  if (!agentId) return [];
  // `jsonb @> '["agent-id"]'::jsonb` matches when the array contains the id.
  // Drizzle doesn't have a typed jsonb-contains helper, so use the sql tag.
  const rows = await db
    .select({
      id: dmRooms.id,
      matrixRoomId: dmRooms.matrixRoomId,
      participants: dmRooms.participants,
      createdAt: dmRooms.createdAt,
      updatedAt: dmRooms.updatedAt,
    })
    .from(dmRooms)
    .where(
      and(
        isNull(dmRooms.deletedAt),
        sql`${dmRooms.participants} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    matrixRoomId: r.matrixRoomId,
    participants: (r.participants as string[] | null) ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
