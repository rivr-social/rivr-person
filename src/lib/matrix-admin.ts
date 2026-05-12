"use server";

import { MatrixProvisioningError } from "./matrix-errors";

/**
 * Server-side Matrix Synapse Admin API client.
 *
 * Purpose:
 * - Provision and manage Matrix user accounts via Synapse Admin API v2.
 * - Create DM rooms between provisioned users.
 * - Update profile metadata (display name, avatar) for Matrix accounts.
 *
 * Key exports:
 * - `provisionMatrixUser` — registers a new Matrix user and obtains an access token.
 * - `deactivateMatrixUser` — deactivates a Matrix user account.
 * - `updateMatrixProfile` — updates display name and/or avatar for a Matrix user.
 * - `createDirectMessageRoom` — creates a DM room between two Matrix users.
 *
 * Dependencies:
 * - `@/lib/env` for `MATRIX_HOMESERVER_URL`, `MATRIX_ADMIN_TOKEN`, `MATRIX_SERVER_NAME`.
 */
import { getEnv } from "@/lib/env";


/**
 * Makes an authenticated request to the Synapse Admin API.
 *
 * @param path - API path (e.g. `/_synapse/admin/v2/users/...`)
 * @param options - Standard fetch options
 * @returns Parsed JSON response body
 * @throws Error if the response status is not OK
 */
async function synapseAdminRequest(path: string, options: RequestInit = {}) {
  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");

  const response = await fetch(`${homeserverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminToken}`,
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
 * Provisions a new Matrix user via the Synapse Admin API v2.
 *
 * Uses PUT /_synapse/admin/v2/users/{userId} to create or update the user,
 * then POST /_synapse/admin/v1/users/{userId}/login to obtain an access token.
 *
 * @param params.localpart - Username portion (no @ prefix, no :server suffix)
 * @param params.displayName - Display name for the Matrix profile
 * @param params.avatarUrl - Optional mxc:// avatar URL
 * @returns The full Matrix user ID and an access token for client-side use
 */
export async function provisionMatrixUser(params: {
  localpart: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<{ matrixUserId: string; accessToken: string }> {
  const serverName = getEnv("MATRIX_SERVER_NAME");
  const matrixUserId = `@${params.localpart}:${serverName}`;

  // Register user via admin API v2.
  // PUT is idempotent — Synapse returns 200 if the user already exists, 201 if newly
  // created. Either is fine for our flow; we just need the row to exist before login.
  try {
    await synapseAdminRequest(
      `/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          displayname: params.displayName,
          admin: false,
          deactivated: false,
        }),
      }
    );
  } catch (error) {
    throw new MatrixProvisioningError(
      "user_create",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }

  // Get an access token for the user. This path also covers re-provisioning
  // when the caller knows the Synapse user already exists but the local
  // `matrixAccessToken` column is null (admin login is repeatable).
  let loginResult: { access_token?: unknown };
  try {
    loginResult = await synapseAdminRequest(
      `/_synapse/admin/v1/users/${encodeURIComponent(matrixUserId)}/login`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
  } catch (error) {
    throw new MatrixProvisioningError(
      "user_login",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }

  const accessToken = loginResult.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // Synapse returned 200 but didn't include a token. Treat as a hard failure
    // so we never persist a half-provisioned row.
    throw new MatrixProvisioningError(
      "missing_token",
      `Synapse /login returned no access_token for ${matrixUserId}`,
    );
  }

  return {
    matrixUserId,
    accessToken,
  };
}

/**
 * Deactivates a Matrix user account via the Synapse Admin API.
 *
 * @param matrixUserId - Full Matrix user ID (e.g. `@user:server.name`)
 */
export async function deactivateMatrixUser(matrixUserId: string): Promise<void> {
  await synapseAdminRequest(
    `/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ deactivated: true }),
    }
  );
}

/**
 * Updates the Matrix profile for a user (display name and/or avatar).
 *
 * @param params.matrixUserId - Full Matrix user ID
 * @param params.displayName - New display name (optional)
 * @param params.avatarUrl - New mxc:// avatar URL (optional)
 */
export async function updateMatrixProfile(params: {
  matrixUserId: string;
  displayName?: string;
  avatarUrl?: string;
}): Promise<void> {
  const updates: Record<string, string> = {};
  if (params.displayName) updates.displayname = params.displayName;
  if (params.avatarUrl) updates.avatar_url = params.avatarUrl;

  if (Object.keys(updates).length > 0) {
    await synapseAdminRequest(
      `/_synapse/admin/v2/users/${encodeURIComponent(params.matrixUserId)}`,
      {
        method: "PUT",
        body: JSON.stringify(updates),
      }
    );
  }
}

/**
 * Force-joins a Matrix user into a room via the Synapse Admin API.
 * Used to auto-accept DM invitations so both parties see the room immediately.
 *
 * @param params.userId - Full Matrix user ID to join into the room
 * @param params.roomId - The Matrix room ID to join
 */
export async function adminJoinRoom(params: {
  userId: string;
  roomId: string;
}): Promise<void> {
  await synapseAdminRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(params.roomId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
      }),
    }
  );
}

/**
 * Creates a direct message room between two Matrix users via Synapse Admin API.
 *
 * @param params.inviterUserId - Full Matrix user ID of the room creator
 * @param params.inviteeUserId - Full Matrix user ID of the invited user
 * @returns The Matrix room ID for the new DM room
 */
export async function createDirectMessageRoom(params: {
  inviterUserId: string;
  inviteeUserId: string;
}): Promise<{ roomId: string }> {
  const result = await synapseAdminRequest(
    `/_synapse/admin/v1/rooms`,
    {
      method: "POST",
      body: JSON.stringify({
        creator: params.inviterUserId,
        invite: [params.inviteeUserId],
        is_direct: true,
        preset: "trusted_private_chat",
      }),
    }
  );

  return { roomId: result.room_id };
}

/**
 * Lists current room members via the Synapse Admin API.
 *
 * Used by `addParticipantsToRoom` to decide whether the target room is a
 * 1:1 DM (2 members) that should be promoted to a group room when extra
 * participants are added.
 *
 * @param roomId - Synapse room ID (must start with `!`)
 * @returns Array of full Matrix user IDs currently joined to the room
 */
export async function getRoomMembers(roomId: string): Promise<string[]> {
  if (!roomId.startsWith("!")) {
    throw new Error(`Invalid Matrix roomId: ${roomId}`);
  }
  const result = await synapseAdminRequest(
    `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`,
    { method: "GET" },
  );
  const members = (result?.members as unknown) ?? [];
  if (!Array.isArray(members)) return [];
  return members.filter((m): m is string => typeof m === "string");
}

/**
 * Creates a new Matrix room with multiple invitees via Synapse Admin API.
 * Used when promoting a 1:1 DM to a group chat — the original two members
 * plus the new participants are all invited into a fresh room.
 *
 * @param params.creatorUserId - Full Matrix user ID who will be the room creator
 * @param params.inviteeUserIds - Full Matrix user IDs to invite (creator excluded)
 * @param params.name - Optional room display name
 * @returns The newly created Matrix room ID
 */
export async function createGroupRoomAsAdmin(params: {
  creatorUserId: string;
  inviteeUserIds: string[];
  name?: string;
}): Promise<{ roomId: string }> {
  const result = await synapseAdminRequest(`/_synapse/admin/v1/rooms`, {
    method: "POST",
    body: JSON.stringify({
      creator: params.creatorUserId,
      invite: params.inviteeUserIds,
      // `is_direct` stays false here: the room is a group chat even if the
      // promotion path originated from a DM. The DM-specific m.direct
      // mirror tracking is removed by the caller after promotion.
      is_direct: false,
      preset: "trusted_private_chat",
      name: params.name,
    }),
  });
  return { roomId: result.room_id };
}

/**
 * Posts a server-side system message via the Synapse client API using the
 * admin token. We don't have the sender's per-user access token here, so
 * we impersonate via the admin endpoint and use the special m.notice msg
 * type to render as a system event rather than a user-typed message.
 *
 * @param params.senderUserId - Full Matrix user ID to attribute the post to
 * @param params.roomId - Target Matrix room ID
 * @param params.body - Text body of the notice
 */
export async function postSystemNotice(params: {
  senderUserId: string;
  roomId: string;
  body: string;
}): Promise<{ eventId: string }> {
  if (!params.roomId.startsWith("!")) {
    throw new Error(`Invalid Matrix roomId: ${params.roomId}`);
  }
  if (!params.senderUserId.startsWith("@")) {
    throw new Error(`Invalid Matrix userId: ${params.senderUserId}`);
  }

  const homeserverUrl = getEnv("MATRIX_HOMESERVER_URL");
  const adminToken = getEnv("MATRIX_ADMIN_TOKEN");
  const txnId = `system-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // `user_id` query parameter lets the admin token impersonate the user
  // for sending the event. Supported by Synapse admin API.
  const url = new URL(
    `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
  );
  url.searchParams.set("user_id", params.senderUserId);

  const response = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      msgtype: "m.notice",
      body: params.body,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(
      `Synapse send error: ${response.status} - ${JSON.stringify(errBody)}`,
    );
  }

  const result = await response.json().catch(() => ({}));
  const eventId = typeof result?.event_id === "string" ? result.event_id : "";
  return { eventId };
}
