/**
 * Shared Chatterbox TTS client.
 *
 * Resolution ladder for cloned-voice synthesis:
 *   1. The user's OWN Vast GPU worker (settings.chatterboxGpu — the
 *      first-party lane; see /api/autobot/gpu + lib/vast-gpu).
 *   2. A static worker at env CHATTERBOX_URL (+ CHATTERBOX_API_KEY).
 *   3. The legacy OpenClaw token-server proxy (retired in prod, kept for
 *      compatibility).
 * Any failure falls through; callers treat non-audio results as "use
 * browser TTS", so voice quality degrades gracefully, never errors out.
 */

import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import { getVoiceSampleUrl } from "@/lib/storage";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";
const CHATTERBOX_URL = (process.env.CHATTERBOX_URL || "").replace(/\/+$/, "");
const CHATTERBOX_API_KEY = process.env.CHATTERBOX_API_KEY || "";

export const TTS_MAX_TEXT_LENGTH = 2000;
const WORKER_TIMEOUT_MS = 90_000;

export type ChatterboxTtsResult =
  /** Synthesized speech audio ready to play / lip-sync against. */
  | { kind: "audio"; audio: ArrayBuffer; contentType: string }
  /** Upstream answered with a JSON signal (e.g. { fallback: true }). */
  | { kind: "json"; data: unknown }
  /** Upstream answered non-OK. */
  | { kind: "error"; status: number; detail: string }
  /** Network failure reaching the TTS backend. */
  | { kind: "unreachable"; detail: string };

/** POST {text, voice_url} to a first-party worker; null on any failure. */
async function tryWorkerLane(
  baseUrl: string,
  authToken: string,
  text: string,
  voiceUrl: string,
): Promise<ChatterboxTtsResult | null> {
  try {
    const response = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        text,
        voice_url: voiceUrl,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("audio/")) return null;
    return {
      kind: "audio",
      audio: await response.arrayBuffer(),
      contentType,
    };
  } catch {
    return null;
  }
}

export async function requestChatterboxTts(
  userId: string,
  username: string,
  text: string,
): Promise<ChatterboxTtsResult> {
  const settings = await getAutobotUserSettings(userId).catch(() => null);
  const speechText = text.slice(0, TTS_MAX_TEXT_LENGTH);

  // Conditioning audio: the user's stored voice sample. Keys from the new
  // MinIO lane contain a path ("voice-samples/<id>/..."); bare legacy names
  // from the retired OpenClaw store are unreachable and skipped.
  const voiceKey = settings?.voiceSample?.storedFileName ?? "";
  const voiceUrl = voiceKey.includes("/") ? getVoiceSampleUrl(voiceKey) : "";

  // Lane 1: the user's own GPU worker.
  const gpu = settings?.chatterboxGpu;
  if (gpu?.url && voiceUrl) {
    const result = await tryWorkerLane(gpu.url, gpu.authToken, speechText, voiceUrl);
    if (result) {
      // Stamp usage so the idle reaper leaves an active box alone.
      saveAutobotUserSettings(userId, {
        chatterboxGpu: { ...gpu, lastUsedAt: new Date().toISOString() },
      }).catch(() => {});
      return result;
    }
  }

  // Lane 2: static instance-level worker.
  if (CHATTERBOX_URL && voiceUrl) {
    const result = await tryWorkerLane(
      CHATTERBOX_URL,
      CHATTERBOX_API_KEY,
      speechText,
      voiceUrl,
    );
    if (result) return result;
  }

  // Lane 3: legacy OpenClaw proxy (retired in prod; kept for compatibility).
  let response: Response;
  try {
    response = await fetch(`${OPENCLAW_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: speechText,
        provider: settings?.gpuProvider,
        providerApiKey: settings?.gpuProviderApiKey || undefined,
        providerEndpoint: settings?.gpuProviderEndpoint || undefined,
        voice: settings?.voiceSample?.voiceId || undefined,
        voiceSampleStoredFileName:
          settings?.voiceSample?.storedFileName || undefined,
        username,
      }),
    });
  } catch (error) {
    return {
      kind: "unreachable",
      detail:
        error instanceof Error ? error.message : "Failed to reach TTS server",
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      kind: "error",
      status: response.status,
      detail: detail.slice(0, 1000),
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("audio/")) {
    return {
      kind: "audio",
      audio: await response.arrayBuffer(),
      contentType,
    };
  }

  const data = await response.json().catch(() => ({ fallback: true }));
  return { kind: "json", data };
}
