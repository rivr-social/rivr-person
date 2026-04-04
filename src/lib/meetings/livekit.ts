/**
 * LiveKit server-side helpers.
 *
 * Wraps the LiveKit Server SDK to provide:
 * - Configuration validation
 * - Room creation
 * - Participant token generation
 * - Egress (livestream) management
 *
 * All functions read LIVEKIT_URL / LIVEKIT_WS_URL, LIVEKIT_API_KEY, and
 * LIVEKIT_API_SECRET from process.env. The WS URL is resolved with a
 * fallback chain: LIVEKIT_WS_URL -> LIVEKIT_URL.
 */

import {
  RoomServiceClient,
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  StreamOutput,
  StreamProtocol,
} from "livekit-server-sdk";

import {
  ENV_LIVEKIT_URL,
  ENV_LIVEKIT_WS_URL,
  ENV_LIVEKIT_API_KEY,
  ENV_LIVEKIT_API_SECRET,
  TOKEN_TTL_SECONDS,
  DEFAULT_MAX_PARTICIPANTS,
  ROOM_EMPTY_TIMEOUT_SECONDS,
} from "./constants";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Returns the resolved LiveKit configuration from environment variables.
 * Returns `null` when required variables are missing, allowing callers
 * to return a clear "not configured" error.
 */
export function getLiveKitConfig(): LiveKitConfig | null {
  const url = process.env[ENV_LIVEKIT_WS_URL] || process.env[ENV_LIVEKIT_URL];
  const apiKey = process.env[ENV_LIVEKIT_API_KEY];
  const apiSecret = process.env[ENV_LIVEKIT_API_SECRET];

  if (!url || !apiKey || !apiSecret) {
    return null;
  }

  return { url, apiKey, apiSecret };
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

export function createRoomService(config: LiveKitConfig): RoomServiceClient {
  return new RoomServiceClient(config.url, config.apiKey, config.apiSecret);
}

export function createEgressClient(config: LiveKitConfig): EgressClient {
  return new EgressClient(config.url, config.apiKey, config.apiSecret);
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

export interface CreateRoomOptions {
  roomName: string;
  maxParticipants?: number;
  emptyTimeout?: number;
  metadata?: string;
}

/**
 * Creates a LiveKit room and returns the room object.
 */
export async function createRoom(
  config: LiveKitConfig,
  options: CreateRoomOptions,
) {
  const svc = createRoomService(config);
  const room = await svc.createRoom({
    name: options.roomName,
    maxParticipants: options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
    emptyTimeout: options.emptyTimeout ?? ROOM_EMPTY_TIMEOUT_SECONDS,
    metadata: options.metadata,
  });
  return room;
}

/**
 * Lists active participants in a room.
 */
export async function listParticipants(
  config: LiveKitConfig,
  roomName: string,
) {
  const svc = createRoomService(config);
  return svc.listParticipants(roomName);
}

/**
 * Deletes a room.
 */
export async function deleteRoom(config: LiveKitConfig, roomName: string) {
  const svc = createRoomService(config);
  return svc.deleteRoom(roomName);
}

/**
 * Lists all active rooms, optionally filtered by name prefix.
 */
export async function listRooms(config: LiveKitConfig, names?: string[]) {
  const svc = createRoomService(config);
  return svc.listRooms(names);
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

export interface TokenOptions {
  roomName: string;
  identity: string;
  name?: string;
  /** Grant video publishing (default true) */
  canPublish?: boolean;
  /** Grant data publishing (default true) */
  canPublishData?: boolean;
  /** Grant screen sharing (default true) */
  canPublishSources?: string[];
  /** Token TTL override in seconds */
  ttl?: number;
  metadata?: string;
}

/**
 * Generates a LiveKit access token for a participant.
 */
export async function generateToken(
  config: LiveKitConfig,
  options: TokenOptions,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: options.identity,
    name: options.name || options.identity,
    ttl: options.ttl ?? TOKEN_TTL_SECONDS,
    metadata: options.metadata,
  });

  token.addGrant({
    room: options.roomName,
    roomJoin: true,
    canPublish: options.canPublish ?? true,
    canPublishData: options.canPublishData ?? true,
  });

  return await token.toJwt();
}

// ---------------------------------------------------------------------------
// Egress (livestream) management
// ---------------------------------------------------------------------------

/**
 * Starts an RTMP stream egress from a room.
 * Returns the egress info object from LiveKit.
 */
export async function startRtmpEgress(
  config: LiveKitConfig,
  roomName: string,
  rtmpUrl: string,
) {
  const client = createEgressClient(config);
  const output = new StreamOutput({
    protocol: StreamProtocol.RTMP,
    urls: [rtmpUrl],
  });
  return client.startRoomCompositeEgress(roomName, { stream: output });
}

/**
 * Stops an active egress by ID.
 */
export async function stopEgress(config: LiveKitConfig, egressId: string) {
  const client = createEgressClient(config);
  return client.stopEgress(egressId);
}

/**
 * Lists active egresses for a room.
 */
export async function listEgresses(config: LiveKitConfig, roomName: string) {
  const client = createEgressClient(config);
  return client.listEgress({ roomName });
}
