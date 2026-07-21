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
export type GpuProvider = "vast" | "local" | "custom";
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

export type DigitalTwinPipeline = "retalk" | "portrait";
export type DigitalTwinModel = "edityourself" | "liveportrait" | "skyreels";
export type HostFraming = "tight-medium" | "medium" | "wide";
export type BackgroundMode = "captured" | "clean" | "generated";
export type DigitalTwinJobMode = "host-update" | "event-recap" | "marketplace-promo";
export type DigitalTwinJobStatus = "draft" | "queued" | "processing" | "completed" | "failed";

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

export type DigitalTwinJob = {
  id: string;
  mode: DigitalTwinJobMode;
  sourceType: "script" | "transcript";
  sourceText: string;
  status: DigitalTwinJobStatus;
  workerJobId?: string;
  videoUrl?: string;
  outputPath?: string;
  errorDetail?: string;
  createdAt: string;
  updatedAt: string;
};

export type DigitalTwinProfile = {
  pipeline: DigitalTwinPipeline;
  model: DigitalTwinModel;
  hostFraming: HostFraming;
  backgroundMode: BackgroundMode;
  notes: string;
  assets: DigitalTwinAsset[];
  jobs: DigitalTwinJob[];
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
  /** bin label (closed/slight/open/wide_open/round/wide) → stored frame URL */
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
  gpuProviderEndpoint: string;
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
  gpuProviderEndpoint: "",
  voiceSample: null,
  chatterboxGpu: null,
  visemePack: null,
  liveAvatarCalibration: null,
  connections: [],
  customSoulMd: "",
  includedPersonaKgIds: [],
  digitalTwin: {
    pipeline: "retalk",
    model: "edityourself",
    hostFraming: "medium",
    backgroundMode: "captured",
    notes: "",
    assets: [],
    jobs: [],
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

function sanitizeDigitalTwinJob(input: unknown): DigitalTwinJob | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const mode =
    input.mode === "host-update" ||
    input.mode === "event-recap" ||
    input.mode === "marketplace-promo"
      ? input.mode
      : null;
  const sourceType = input.sourceType === "transcript" ? "transcript" : input.sourceType === "script" ? "script" : null;
  const sourceText =
    typeof input.sourceText === "string" && input.sourceText.trim()
      ? input.sourceText.trim()
      : null;
  const status =
    input.status === "draft" ||
    input.status === "queued" ||
    input.status === "processing" ||
    input.status === "completed" ||
    input.status === "failed"
      ? input.status
      : null;
  const createdAt =
    typeof input.createdAt === "string" && input.createdAt.trim()
      ? input.createdAt.trim()
      : null;
  const updatedAt =
    typeof input.updatedAt === "string" && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : null;
  if (!id || !mode || !sourceType || !sourceText || !status || !createdAt || !updatedAt) {
    return null;
  }
  const workerJobId =
    typeof input.workerJobId === "string" && input.workerJobId.trim()
      ? input.workerJobId.trim()
      : undefined;
  const videoUrl =
    typeof input.videoUrl === "string" && input.videoUrl.trim()
      ? input.videoUrl.trim()
      : undefined;
  const outputPath =
    typeof input.outputPath === "string" && input.outputPath.trim()
      ? input.outputPath.trim()
      : undefined;
  const errorDetail =
    typeof input.errorDetail === "string" && input.errorDetail.trim()
      ? input.errorDetail.trim()
      : undefined;
  return { id, mode, sourceType, sourceText, status, createdAt, updatedAt, workerJobId, videoUrl, outputPath, errorDetail };
}

function sanitizeDigitalTwinProfile(input: unknown): DigitalTwinProfile {
  const record = isRecord(input) ? input : {};
  return {
    pipeline: record.pipeline === "portrait" ? "portrait" : "retalk",
    model:
      record.model === "liveportrait" || record.model === "skyreels"
        ? record.model
        : "edityourself",
    hostFraming:
      record.hostFraming === "tight-medium" || record.hostFraming === "wide"
        ? record.hostFraming
        : "medium",
    backgroundMode:
      record.backgroundMode === "clean" || record.backgroundMode === "generated"
        ? record.backgroundMode
        : "captured",
    notes: typeof record.notes === "string" ? record.notes.trim() : "",
    assets: Array.isArray(record.assets)
      ? record.assets.map(sanitizeDigitalTwinAsset).filter(Boolean) as DigitalTwinAsset[]
      : [],
    jobs: Array.isArray(record.jobs)
      ? record.jobs.map(sanitizeDigitalTwinJob).filter(Boolean) as DigitalTwinJob[]
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
  const authToken =
    typeof input.authToken === "string" && input.authToken.trim()
      ? input.authToken.trim()
      : null;
  if (instanceId === null || !authToken) return null;
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
  const gpuProvider: GpuProvider =
    record.gpuProvider === "local" || record.gpuProvider === "custom"
      ? record.gpuProvider
      : DEFAULT_SETTINGS.gpuProvider;
  const gpuProviderApiKey =
    typeof record.gpuProviderApiKey === "string"
      ? record.gpuProviderApiKey.trim()
      : "";
  const gpuProviderEndpoint =
    typeof record.gpuProviderEndpoint === "string"
      ? record.gpuProviderEndpoint.trim()
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
    gpuProviderEndpoint,
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
