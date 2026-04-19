/**
 * Constants for the meetings/livestream/video subsystem.
 *
 * All LiveKit-related configuration, error codes, and status values
 * are centralized here to avoid magic strings throughout the codebase.
 */

// ---------------------------------------------------------------------------
// Environment variable keys
// ---------------------------------------------------------------------------

export const ENV_LIVEKIT_URL = "LIVEKIT_URL";
export const ENV_LIVEKIT_WS_URL = "LIVEKIT_WS_URL";
export const ENV_LIVEKIT_API_KEY = "LIVEKIT_API_KEY";
export const ENV_LIVEKIT_API_SECRET = "LIVEKIT_API_SECRET";

// ---------------------------------------------------------------------------
// Room configuration defaults
// ---------------------------------------------------------------------------

/** Maximum number of concurrent participants per room. */
export const DEFAULT_MAX_PARTICIPANTS = 100;

/** Token time-to-live in seconds (6 hours). */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** Room empty timeout in seconds (10 minutes). */
export const ROOM_EMPTY_TIMEOUT_SECONDS = 10 * 60;

// ---------------------------------------------------------------------------
// Room name prefixes (used to namespace meeting vs. livestream rooms)
// ---------------------------------------------------------------------------

export const ROOM_PREFIX_MEETING = "mtg";
export const ROOM_PREFIX_EVENT = "evt";
export const ROOM_PREFIX_LIVESTREAM = "live";

// ---------------------------------------------------------------------------
// Meeting status values
// ---------------------------------------------------------------------------

export const MEETING_STATUS = {
  ACTIVE: "active",
  ENDED: "ended",
  SCHEDULED: "scheduled",
} as const;

export type MeetingStatus = (typeof MEETING_STATUS)[keyof typeof MEETING_STATUS];

// ---------------------------------------------------------------------------
// Livestream status values
// ---------------------------------------------------------------------------

export const LIVESTREAM_STATUS = {
  IDLE: "idle",
  STREAMING: "streaming",
  STOPPING: "stopping",
} as const;

export type LivestreamStatus =
  (typeof LIVESTREAM_STATUS)[keyof typeof LIVESTREAM_STATUS];

// ---------------------------------------------------------------------------
// HTTP status codes used across meeting routes
// ---------------------------------------------------------------------------

export const STATUS_OK = 200;
export const STATUS_CREATED = 201;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_NOT_FOUND = 404;
export const STATUS_CONFLICT = 409;
export const STATUS_UNPROCESSABLE = 422;
export const STATUS_INTERNAL_ERROR = 500;
export const STATUS_SERVICE_UNAVAILABLE = 503;

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

export const ERROR_UNAUTHORIZED = "Unauthorized";
export const ERROR_MISSING_IDENTITY = "Missing required field: identity";
export const ERROR_MISSING_ROOM_NAME = "Missing required field: roomName";
export const ERROR_MISSING_RTMP_URL = "Missing required field: rtmpUrl";
export const ERROR_ROOM_NOT_FOUND = "Room not found";
export const ERROR_LIVEKIT_NOT_CONFIGURED =
  "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.";
export const ERROR_EGRESS_NOT_FOUND = "No active egress found for this room";
export const ERROR_EVENT_NOT_FOUND = "Event not found";

// ---------------------------------------------------------------------------
// Metadata keys stored in resource.metadata for event-linked meetings
// ---------------------------------------------------------------------------

export const META_MEETING_ROOM = "meetingRoom";
export const META_MEETING_CREATED_AT = "meetingCreatedAt";
export const META_MEETING_CREATED_BY = "meetingCreatedBy";
export const META_LIVESTREAM_EGRESS_ID = "livestreamEgressId";
