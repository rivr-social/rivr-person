import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  sanitizeAutobotConnections,
  type AutobotConnection,
} from "@/lib/autobot-connectors";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { signPackedPayload } from "@/lib/federation-remote-session";

export type VoiceMode = "browser" | "clone";
/**
 * Vast.ai is the only provider the GPU lane can drive. Accounts that stored the
 * retired "local" / "custom" options are normalized back to "vast" on read.
 */
export type GpuProvider = "vast";
export type VoiceSample = {
  fileName: string;
  size: number;
  mimeType?: string;
  uploadedAt: string;
  storedFileName?: string;
  voiceId?: string;
};

export type DigitalTwinAssetKind =
  | "host-video"
  | "reference-portrait"
  | "idle-video"
  | "background-plate";

export type DigitalTwinAsset = {
  id: string;
  kind: DigitalTwinAssetKind;
  fileName: string;
  key: string;
  url: string;
  bucket: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

/**
 * Reference media for the live avatar.
 *
 * This used to also carry a generative VIDEO pipeline (pipeline/model/
 * hostFraming/backgroundMode/notes plus a `jobs` queue) aimed at a worker that
 * has never existed in this repo. That surface was removed on 2026-07-22; only
 * `assets` was ever load-bearing — the live-avatar bake and session routes read
 * the `reference-portrait` asset out of it.
 */
export type DigitalTwinProfile = {
  assets: DigitalTwinAsset[];
  updatedAt?: string;
};

/** State of the user's Chatterbox voice GPU (Vast.ai instance). */
export type ChatterboxGpuState = {
  instanceId: number;
  /** Worker base URL (http://ip:port) once running; empty while provisioning. */
  url: string;
  /** Bearer token the worker was booted with. */
  authToken: string;
  createdAt: string;
  lastUsedAt: string;
};

/** Baked viseme frame pack for the live avatar (one-time GPU generation). */
export type VisemePack = {
  /**
   * Frame label → stored frame URL. Labels: mouth bins (closed/slight/
   * open/wide_open/round/wide), openness-ladder steps (step_00..step_11,
   * real in-between shapes for transitions), and region variants
   * (eyes_closed/brows_raised for blink + expression compositing).
   */
  frames: Record<string, string>;
  generatedAt: string;
  /** Source image URL the pack was baked from (staleness check). */
  sourceImage: string;
};

/** Manual mouth/eye placement for portraits that defeat face detection. */
export type LiveAvatarCalibration = {
  /** Normalized [x, y] in 0..1 image space. */
  mouth: [number, number];
  leftEye: [number, number];
  rightEye: [number, number];
};

/** Auto-provisioned scoped MCP token stored alongside settings. */
export type AutobotMcpToken = {
  token: string;
  expiresAt: string;
  scopes: string[];
  issuedAt: string;
};

export type AutobotUserSettings = {
  selectedModel: string;
  ttsEnabled: boolean;
  voiceMode: VoiceMode;
  gpuProvider: GpuProvider;
  gpuProviderApiKey: string;
  voiceSample: VoiceSample | null;
  digitalTwin: DigitalTwinProfile;
  chatterboxGpu: ChatterboxGpuState | null;
  visemePack: VisemePack | null;
  liveAvatarCalibration: LiveAvatarCalibration | null;
  connections: AutobotConnection[];
  customSoulMd: string;
  includedPersonaKgIds: string[];
  /** Auto-provisioned MCP token for this actor. Lazily created on first access. */
  mcpToken?: AutobotMcpToken | null;
  updatedAt?: string;
};

const SETTINGS_KEY = "autobotSettings";

const DEFAULT_SETTINGS: AutobotUserSettings = {
  selectedModel: "anthropic/claude-sonnet-4-6",
  ttsEnabled: false,
  voiceMode: "browser",
  gpuProvider: "vast",
  gpuProviderApiKey: "",
  voiceSample: null,
  chatterboxGpu: null,
  visemePack: null,
  liveAvatarCalibration: null,
  connections: [],
  customSoulMd: "",
  includedPersonaKgIds: [],
  digitalTwin: {
    assets: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeVoiceSample(input: unknown): VoiceSample | null {
  if (!isRecord(input)) return null;
  const fileName =
    typeof input.fileName === "string" && input.fileName.trim()
      ? input.fileName.trim()
      : null;
  const size =
    typeof input.size === "number" && Number.isFinite(input.size) && input.size >= 0
      ? input.size
      : null;
  const uploadedAt =
    typeof input.uploadedAt === "string" && input.uploadedAt.trim()
      ? input.uploadedAt.trim()
      : null;

  if (!fileName || size === null || !uploadedAt) return null;

  return {
    fileName,
    size,
    mimeType:
      typeof input.mimeType === "string" && input.mimeType.trim()
        ? input.mimeType.trim()
        : undefined,
    uploadedAt,
    storedFileName:
      typeof input.storedFileName === "string" && input.storedFileName.trim()
        ? input.storedFileName.trim()
        : undefined,
    voiceId:
      typeof input.voiceId === "string" && input.voiceId.trim()
        ? input.voiceId.trim()
        : undefined,
  };
}

function sanitizeDigitalTwinAsset(input: unknown): DigitalTwinAsset | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const kind =
    input.kind === "host-video" ||
    input.kind === "reference-portrait" ||
    input.kind === "idle-video" ||
    input.kind === "background-plate"
      ? input.kind
      : null;
  const fileName =
    typeof input.fileName === "string" && input.fileName.trim() ? input.fileName.trim() : null;
  const key = typeof input.key === "string" && input.key.trim() ? input.key.trim() : null;
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
  const bucket =
    typeof input.bucket === "string" && input.bucket.trim() ? input.bucket.trim() : null;
  const size =
    typeof input.size === "number" && Number.isFinite(input.size) && input.size >= 0
      ? input.size
      : null;
  const mimeType =
    typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim() : null;
  const uploadedAt =
    typeof input.uploadedAt === "string" && input.uploadedAt.trim()
      ? input.uploadedAt.trim()
      : null;
  if (!id || !kind || !fileName || !key || !url || !bucket || size === null || !mimeType || !uploadedAt) {
    return null;
  }
  return { id, kind, fileName, key, url, bucket, size, mimeType, uploadedAt };
}

/**
 * Reads the avatar-asset profile out of stored metadata. Rows written by older
 * builds still carry the retired video-pipeline keys; they are simply dropped
 * on read rather than migrated, because nothing consumes them.
 */
function sanitizeDigitalTwinProfile(input: unknown): DigitalTwinProfile {
  const record = isRecord(input) ? input : {};
  return {
    assets: Array.isArray(record.assets)
      ? record.assets.map(sanitizeDigitalTwinAsset).filter(Boolean) as DigitalTwinAsset[]
      : [],
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt.trim()
        : undefined,
  };
}

function sanitizeChatterboxGpu(input: unknown): ChatterboxGpuState | null {
  if (!isRecord(input)) return null;
  const instanceId =
    typeof input.instanceId === "number" && Number.isFinite(input.instanceId)
      ? input.instanceId
      : null;
  // The maintained Chatterbox server has NO bearer auth, so authToken is
  // optional (empty string). Only instanceId is required — requiring a
  // non-empty token here silently nulled the whole GPU record.
  const authToken =
    typeof input.authToken === "string" ? input.authToken.trim() : "";
  if (instanceId === null) return null;
  return {
    instanceId,
    authToken,
    url: typeof input.url === "string" ? input.url.trim() : "",
    createdAt:
      typeof input.createdAt === "string" && input.createdAt.trim()
        ? input.createdAt.trim()
        : new Date(0).toISOString(),
    lastUsedAt:
      typeof input.lastUsedAt === "string" && input.lastUsedAt.trim()
        ? input.lastUsedAt.trim()
        : new Date(0).toISOString(),
  };
}

function sanitizeVisemePack(input: unknown): VisemePack | null {
  if (!isRecord(input) || !isRecord(input.frames)) return null;
  const frames: Record<string, string> = {};
  for (const [label, url] of Object.entries(input.frames)) {
    if (typeof url === "string" && url.trim()) frames[label] = url.trim();
  }
  if (Object.keys(frames).length === 0) return null;
  return {
    frames,
    generatedAt:
      typeof input.generatedAt === "string" && input.generatedAt.trim()
        ? input.generatedAt.trim()
        : new Date(0).toISOString(),
    sourceImage:
      typeof input.sourceImage === "string" ? input.sourceImage.trim() : "",
  };
}

function sanitizeNormalizedPoint(input: unknown): [number, number] | null {
  if (!Array.isArray(input) || input.length !== 2) return null;
  const [x, y] = input;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [x, y];
}

function sanitizeLiveAvatarCalibration(
  input: unknown,
): LiveAvatarCalibration | null {
  if (!isRecord(input)) return null;
  const mouth = sanitizeNormalizedPoint(input.mouth);
  const leftEye = sanitizeNormalizedPoint(input.leftEye);
  const rightEye = sanitizeNormalizedPoint(input.rightEye);
  if (!mouth || !leftEye || !rightEye) return null;
  return { mouth, leftEye, rightEye };
}

function sanitizeSettings(input: unknown): AutobotUserSettings {
  const record = isRecord(input) ? input : {};
  const selectedModel =
    typeof record.selectedModel === "string" && record.selectedModel.trim()
      ? record.selectedModel.trim()
      : DEFAULT_SETTINGS.selectedModel;
  const ttsEnabled = record.ttsEnabled === true;
  const voiceMode: VoiceMode =
    record.voiceMode === "clone" ? "clone" : DEFAULT_SETTINGS.voiceMode;
  // Parsing stays tolerant of the retired "local" / "custom" values: whatever is
  // stored, the one provider this app can drive is Vast.
  const gpuProvider: GpuProvider = DEFAULT_SETTINGS.gpuProvider;
  const gpuProviderApiKey =
    typeof record.gpuProviderApiKey === "string"
      ? record.gpuProviderApiKey.trim()
      : "";
  const voiceSample = sanitizeVoiceSample(record.voiceSample);
  const connections = sanitizeAutobotConnections(record.connections);
  const customSoulMd =
    typeof record.customSoulMd === "string" ? record.customSoulMd.trim() : "";
  const includedPersonaKgIds = Array.isArray(record.includedPersonaKgIds)
    ? record.includedPersonaKgIds
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  const digitalTwin = sanitizeDigitalTwinProfile(record.digitalTwin);
  const chatterboxGpu = sanitizeChatterboxGpu(record.chatterboxGpu);
  const visemePack = sanitizeVisemePack(record.visemePack);
  const liveAvatarCalibration = sanitizeLiveAvatarCalibration(
    record.liveAvatarCalibration,
  );
  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : undefined;

  return {
    selectedModel,
    ttsEnabled,
    voiceMode,
    gpuProvider,
    gpuProviderApiKey,
    voiceSample,
    chatterboxGpu,
    visemePack,
    liveAvatarCalibration,
    connections,
    customSoulMd,
    includedPersonaKgIds,
    digitalTwin,
    updatedAt,
  };
}

/**
 * Auto-provision a scoped MCP token for an actor.
 * Called lazily on first settings access or on persona switch.
 */
const MCP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MCP_TOKEN_SCOPES = [
  "mcp:tools",
  "profile:read",
  "profile:write",
  "post:create",
  "event:create",
  "offering:create",
  "group:write",
  "federation:write",
];

export function provisionMcpToken(actorId: string): AutobotMcpToken {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const now = Date.now();
  const payload = {
    type: "rivr_mcp_token",
    actorId,
    controllerId: actorId,
    actorType: "human",
    issuer: baseUrl,
    audience: baseUrl,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MCP_TOKEN_TTL_MS).toISOString(),
    scopes: MCP_TOKEN_SCOPES,
  };

  return {
    token: signPackedPayload(payload as unknown as Record<string, unknown>),
    expiresAt: payload.expiresAt,
    scopes: MCP_TOKEN_SCOPES,
    issuedAt: payload.issuedAt,
  };
}

/**
 * Check if a stored MCP token is still valid (not expired, with 1-day buffer).
 */
function isMcpTokenValid(mcpToken: AutobotMcpToken | null | undefined): boolean {
  if (!mcpToken?.token || !mcpToken.expiresAt) return false;
  const expiresAt = Date.parse(mcpToken.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  // Refresh if less than 1 day remaining
  return expiresAt > Date.now() + 24 * 60 * 60 * 1000;
}

export async function getAutobotUserSettings(agentId: string): Promise<AutobotUserSettings> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  const settings = sanitizeSettings(metadata[SETTINGS_KEY]);

  // Auto-provision MCP token if missing or expired
  if (!isMcpTokenValid(settings.mcpToken)) {
    const mcpToken = provisionMcpToken(agentId);
    settings.mcpToken = mcpToken;
    // Persist the token back (fire-and-forget — don't block on this)
    saveAutobotUserSettings(agentId, { mcpToken }).catch(() => {});
  }

  return settings;
}

export async function saveAutobotUserSettings(
  agentId: string,
  patch: Partial<AutobotUserSettings>,
): Promise<AutobotUserSettings> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  const current = sanitizeSettings(metadata[SETTINGS_KEY]);
  const next = sanitizeSettings({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });

  await db
    .update(agents)
    .set({
      metadata: {
        ...metadata,
        [SETTINGS_KEY]: next,
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  return next;
}
