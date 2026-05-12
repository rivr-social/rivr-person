/**
 * Browser-side Matrix client wrapper around matrix-js-sdk.
 *
 * Purpose:
 * - Provides a singleton MatrixClient lifecycle (create, start sync, stop).
 * - Wraps common chat operations: send message, get/create DM rooms.
 * - Manages m.direct account data for DM room tracking.
 *
 * Key exports:
 * - `getMatrixClient` — creates or returns the cached MatrixClient instance.
 * - `startSync` / `stopSync` — lifecycle controls for the Matrix sync loop.
 * - `sendMessage` — sends a text message to a Matrix room.
 * - `getOrCreateDmRoom` — finds an existing DM or creates a new one.
 * - `getDmRooms` — lists all rooms marked as direct messages.
 *
 * Dependencies:
 * - `matrix-js-sdk` for the underlying Matrix protocol client.
 */
import { ClientEvent, createClient, EventType, MatrixClient, MsgType, Preset, Room } from "matrix-js-sdk";
import { ensureUserJoinedRoom, recordDmRoomMirror } from "@/app/actions/matrix";
import {
  emitMatrixSyncRepair,
  MATRIX_SYNC_REPAIR_EXHAUSTED,
  MATRIX_SYNC_REPAIR_FAILED,
  MATRIX_SYNC_REPAIR_SUCCEEDED,
} from "@/lib/matrix-sync-events";

let matrixClient: MatrixClient | null = null;

// ─── Retry tuning for m.direct repair ───────────────────────────────────────
// Repair runs once during startSync. Network blips and Synapse rate-limits
// are short-lived; bounded exponential backoff catches them without looping
// forever on a misconfigured server.
const M_DIRECT_REPAIR_MAX_ATTEMPTS = 4;
const M_DIRECT_REPAIR_BASE_DELAY_MS = 400;
const M_DIRECT_REPAIR_BACKOFF_FACTOR = 2;
const M_DIRECT_REPAIR_MAX_DELAY_MS = 5_000;

/**
 * Error thrown when m.direct repair fails for every retry attempt during
 * `startSync()`. The sync proceeds, but the caller knows the DM mirror is
 * potentially stale until the user refreshes or the next sync runs.
 */
export class MatrixDirectRepairError extends Error {
  public readonly attempts: number;
  public readonly lastErrorMessage: string;
  constructor(attempts: number, lastErrorMessage: string) {
    super(
      `Failed to persist m.direct after ${attempts} attempts: ${lastErrorMessage}`,
    );
    this.name = "MatrixDirectRepairError";
    this.attempts = attempts;
    this.lastErrorMessage = lastErrorMessage;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function computeBackoffMs(attemptIndex: number): number {
  // Exponential backoff capped at M_DIRECT_REPAIR_MAX_DELAY_MS so the worst
  // case stays bounded even if the constants are tuned upward later.
  const raw = M_DIRECT_REPAIR_BASE_DELAY_MS * Math.pow(M_DIRECT_REPAIR_BACKOFF_FACTOR, attemptIndex);
  return Math.min(raw, M_DIRECT_REPAIR_MAX_DELAY_MS);
}

/**
 * Persist `m.direct` account data with bounded exponential backoff.
 *
 * On every failure, emits `MATRIX_SYNC_REPAIR_FAILED`. On success, emits
 * `MATRIX_SYNC_REPAIR_SUCCEEDED`. If every attempt fails, emits
 * `MATRIX_SYNC_REPAIR_EXHAUSTED` and throws `MatrixDirectRepairError`.
 *
 * Exported for tests; production callers go through `startSync`.
 */
export async function persistMDirectWithRetry(
  client: MatrixClient,
  directContent: Record<string, string[]>,
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= M_DIRECT_REPAIR_MAX_ATTEMPTS; attempt++) {
    try {
      await client.setAccountData(EventType.Direct, directContent);
      emitMatrixSyncRepair({ type: MATRIX_SYNC_REPAIR_SUCCEEDED, attempt });
      return;
    } catch (err) {
      lastError = err;
      const isFinalAttempt = attempt === M_DIRECT_REPAIR_MAX_ATTEMPTS;
      const nextRetryMs = isFinalAttempt ? null : computeBackoffMs(attempt - 1);
      emitMatrixSyncRepair({
        type: MATRIX_SYNC_REPAIR_FAILED,
        attempt,
        maxAttempts: M_DIRECT_REPAIR_MAX_ATTEMPTS,
        nextRetryMs,
        message: describeError(err),
      });
      console.error(
        `[matrix] m.direct repair failed (attempt ${attempt}/${M_DIRECT_REPAIR_MAX_ATTEMPTS}):`,
        err,
      );
      if (!isFinalAttempt && nextRetryMs !== null) {
        await new Promise((resolve) => setTimeout(resolve, nextRetryMs));
      }
    }
  }

  const finalMessage = describeError(lastError);
  emitMatrixSyncRepair({
    type: MATRIX_SYNC_REPAIR_EXHAUSTED,
    attempts: M_DIRECT_REPAIR_MAX_ATTEMPTS,
    message: finalMessage,
  });
  throw new MatrixDirectRepairError(M_DIRECT_REPAIR_MAX_ATTEMPTS, finalMessage);
}

/**
 * Creates or returns the cached MatrixClient instance.
 * If the userId differs from the current client, the old client is stopped
 * and a new one is created.
 *
 * @param params.homeserverUrl - Matrix homeserver base URL
 * @param params.userId - Full Matrix user ID (e.g. `@user:server`)
 * @param params.accessToken - Access token for authentication
 * @returns The MatrixClient instance
 */
export function getMatrixClient(params: {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
}): MatrixClient {
  if (matrixClient && matrixClient.getUserId() === params.userId) {
    return matrixClient;
  }

  // Stop existing client if switching users
  if (matrixClient) {
    matrixClient.stopClient();
  }

  matrixClient = createClient({
    baseUrl: params.homeserverUrl,
    userId: params.userId,
    accessToken: params.accessToken,
  });

  return matrixClient;
}

/**
 * Starts the Matrix sync loop and waits for initial sync to complete.
 * After sync, auto-accepts any pending DM room invites so conversations
 * appear immediately without manual action.
 *
 * @param client - The MatrixClient to start syncing
 */
export async function startSync(client: MatrixClient): Promise<void> {
  await client.startClient({ initialSyncLimit: 20 });

  // Wait for initial sync
  await new Promise<void>((resolve) => {
    client.once(ClientEvent.Sync, (state) => {
      if (state === "PREPARED") resolve();
    });
  });

  // Auto-accept pending DM invites and update m.direct for any joined
  // DM rooms missing from account data (e.g., rooms created by other users).
  const rooms = client.getRooms();
  const directEvent = client.getAccountData(EventType.Direct);
  const directContent = directEvent?.getContent() || {};
  const knownDmRoomIds = new Set<string>();
  for (const roomIds of Object.values(directContent) as string[][]) {
    for (const id of roomIds) knownDmRoomIds.add(id);
  }

  let directContentChanged = false;
  const currentUserId = client.getUserId();

  for (const room of rooms) {
    const membership = room.getMyMembership();

    // Auto-join invited rooms
    if (membership === "invite") {
      try {
        await client.joinRoom(room.roomId);
      } catch (err) {
        console.error(`[matrix] Failed to auto-join invited room ${room.roomId}:`, err);
        continue;
      }
    }

    // Ensure all DM rooms are tracked in m.direct
    if (!knownDmRoomIds.has(room.roomId)) {
      const members = room.getJoinedMembers();
      const isDirect = room.getDMInviter() || members.length === 2;
      if (isDirect && members.length === 2) {
        const otherMember = members.find((m) => m.userId !== currentUserId);
        if (otherMember) {
          if (!directContent[otherMember.userId]) {
            directContent[otherMember.userId] = [];
          }
          directContent[otherMember.userId].push(room.roomId);
          knownDmRoomIds.add(room.roomId);
          directContentChanged = true;
        }
      }
    }
  }

  // Persist updated m.direct if we found new DM rooms.
  // Failures are emitted via matrix-sync-events so the UI can surface them;
  // we don't rethrow here because the sync itself succeeded — we just couldn't
  // mirror the discovered DM rooms back to the account data.
  if (directContentChanged) {
    try {
      await persistMDirectWithRetry(
        client,
        directContent as Record<string, string[]>,
      );
    } catch (err) {
      // Already emitted MATRIX_SYNC_REPAIR_EXHAUSTED inside the helper.
      // Swallow here so startSync() resolves; subscribers receive the
      // exhausted event and can prompt the user.
      if (!(err instanceof MatrixDirectRepairError)) {
        // Should not happen, but be defensive about unexpected errors.
        console.error("[matrix] Unexpected error from persistMDirectWithRetry:", err);
      }
    }
  }
}

/**
 * Stops the Matrix sync loop and clears the cached client.
 */
export function stopSync(): void {
  if (matrixClient) {
    matrixClient.stopClient();
    matrixClient = null;
  }
}

/**
 * Sends a text message to a Matrix room.
 *
 * @param client - The authenticated MatrixClient
 * @param roomId - Target Matrix room ID
 * @param body - Text message content
 * @returns The event ID of the sent message
 */
export async function sendMessage(
  client: MatrixClient,
  roomId: string,
  body: string
): Promise<{ eventId: string }> {
  const result = await client.sendMessage(roomId, {
    msgtype: MsgType.Text,
    body,
  });
  return { eventId: result.event_id };
}

/**
 * Finds an existing DM room with the target user, or creates a new one.
 *
 * Checks the m.direct account data and room membership to find existing DMs.
 * If none exist, creates a new trusted_private_chat room and updates m.direct.
 *
 * @param client - The authenticated MatrixClient
 * @param targetUserId - Full Matrix user ID of the DM partner
 * @returns The Matrix room ID for the DM
 */
export async function getOrCreateDmRoom(
  client: MatrixClient,
  targetUserId: string,
  /**
   * Optional RIVR agent id for the target user. If supplied, the new room
   * is mirrored into the `dm_rooms` table via `recordDmRoomMirror` so the
   * pairing survives a homeserver migration. The caller already knows this
   * id because it just resolved the targetUserId from `getDmRoomForUser`.
   */
  targetAgentId?: string,
): Promise<string> {
  // Check existing DM rooms
  const rooms = client.getRooms();
  for (const room of rooms) {
    const isDm =
      room.getDMInviter() ||
      client
        .getAccountData(EventType.Direct)
        ?.getContent()?.[targetUserId]?.includes(room.roomId);
    if (isDm) {
      const members = room.getJoinedMembers();
      if (
        members.length === 2 &&
        members.some((m) => m.userId === targetUserId)
      ) {
        return room.roomId;
      }
    }
  }

  // Create new DM room
  const result = await client.createRoom({
    is_direct: true,
    invite: [targetUserId],
    preset: Preset.TrustedPrivateChat,
  });

  // Force-join the target user so they see the room immediately
  await ensureUserJoinedRoom(targetUserId, result.room_id);

  // Update m.direct account data
  const directEvent = client.getAccountData(EventType.Direct);
  const directContent = directEvent?.getContent() || {};
  directContent[targetUserId] = [
    ...(directContent[targetUserId] || []),
    result.room_id,
  ];
  await client.setAccountData(EventType.Direct, directContent as Record<string, string[]>);

  // Mirror the room to RIVR's dm_rooms table for migration survival.
  // Best-effort: a failure here is logged server-side and recovered by
  // the reconcile job; the DM itself is still usable client-side.
  if (targetAgentId) {
    try {
      await recordDmRoomMirror(result.room_id, [targetAgentId]);
    } catch (err) {
      console.error("[matrix] getOrCreateDmRoom mirror write failed:", err);
    }
  }

  return result.room_id;
}

/**
 * Creates a group DM room with multiple participants.
 * Unlike `getOrCreateDmRoom` which handles 1-on-1 DMs, this always creates
 * a new room with all specified users invited.
 *
 * @param client - The authenticated MatrixClient
 * @param targetUserIds - Array of full Matrix user IDs to invite
 * @param roomName - Optional display name for the group chat
 * @returns The Matrix room ID for the new group chat
 */
export async function createGroupDmRoom(
  client: MatrixClient,
  targetUserIds: string[],
  roomName?: string,
  /**
   * Optional RIVR agent ids matching `targetUserIds` (same order or any
   * order — we just record the set). When supplied, the new room is
   * mirrored into the `dm_rooms` table for migration survival.
   */
  targetAgentIds?: string[],
): Promise<string> {
  const result = await client.createRoom({
    is_direct: true,
    invite: targetUserIds,
    preset: Preset.TrustedPrivateChat,
    name: roomName,
  });

  // Force-join all target users so they see the room immediately
  for (const userId of targetUserIds) {
    await ensureUserJoinedRoom(userId, result.room_id);
  }

  // Update m.direct account data for each target user
  const directEvent = client.getAccountData(EventType.Direct);
  const directContent = directEvent?.getContent() || {};
  for (const userId of targetUserIds) {
    directContent[userId] = [
      ...(directContent[userId] || []),
      result.room_id,
    ];
  }
  await client.setAccountData(EventType.Direct, directContent as Record<string, string[]>);

  // Mirror the room to RIVR's dm_rooms table for migration survival.
  if (targetAgentIds && targetAgentIds.length > 0) {
    try {
      await recordDmRoomMirror(result.room_id, targetAgentIds);
    } catch (err) {
      console.error("[matrix] createGroupDmRoom mirror write failed:", err);
    }
  }

  return result.room_id;
}

/**
 * Leaves a Matrix room and removes it from m.direct if it's a DM.
 *
 * @param client - The authenticated MatrixClient
 * @param roomId - The Matrix room ID to leave
 */
export async function leaveRoom(
  client: MatrixClient,
  roomId: string
): Promise<void> {
  // Remove from m.direct account data if present
  const directEvent = client.getAccountData(EventType.Direct);
  if (directEvent) {
    const directContent = { ...directEvent.getContent() };
    let changed = false;
    for (const userId of Object.keys(directContent)) {
      const rooms = directContent[userId] as string[];
      if (rooms?.includes(roomId)) {
        directContent[userId] = rooms.filter((id: string) => id !== roomId);
        if ((directContent[userId] as string[]).length === 0) {
          delete directContent[userId];
        }
        changed = true;
      }
    }
    if (changed) {
      await client.setAccountData(EventType.Direct, directContent as Record<string, string[]>);
    }
  }

  // Leave the room
  await client.leave(roomId);

  // Forget the room so it doesn't reappear
  try {
    await client.forget(roomId);
  } catch {
    // forget may fail if server doesn't support it; non-critical
  }
}

/**
 * Returns all rooms marked as direct messages via the m.direct account data.
 *
 * @param client - The authenticated MatrixClient
 * @returns Array of Room objects that are DMs
 */
export function getDmRooms(client: MatrixClient): Room[] {
  const directEvent = client.getAccountData(EventType.Direct);
  if (!directEvent) return [];

  const directContent = directEvent.getContent();
  const dmRoomIds = new Set<string>();
  for (const rooms of Object.values(directContent) as string[][]) {
    for (const roomId of rooms) {
      dmRoomIds.add(roomId);
    }
  }

  return client.getRooms().filter((room) => dmRoomIds.has(room.roomId));
}
