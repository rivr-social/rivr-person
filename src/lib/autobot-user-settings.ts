import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";

export type VoiceMode = "browser" | "clone";
export type GpuProvider = "vast" | "local" | "custom";

export type AutobotUserSettings = {
  selectedModel: string;
  ttsEnabled: boolean;
  voiceMode: VoiceMode;
  gpuProvider: GpuProvider;
  gpuProviderApiKey: string;
  gpuProviderEndpoint: string;
  updatedAt?: string;
};

const SETTINGS_KEY = "autobotSettings";

const DEFAULT_SETTINGS: AutobotUserSettings = {
  selectedModel: "openai/gpt-4o-mini",
  ttsEnabled: false,
  voiceMode: "browser",
  gpuProvider: "vast",
  gpuProviderApiKey: "",
  gpuProviderEndpoint: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : undefined;

  return {
    selectedModel,
    ttsEnabled,
    voiceMode,
    gpuProvider,
    gpuProviderApiKey,
    gpuProviderEndpoint,
    updatedAt,
  };
}

export async function getAutobotUserSettings(agentId: string): Promise<AutobotUserSettings> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  return sanitizeSettings(metadata[SETTINGS_KEY]);
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
