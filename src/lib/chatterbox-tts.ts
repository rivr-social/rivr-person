/**
 * Shared Chatterbox TTS client.
 *
 * Wraps the OpenClaw token server's /api/tts endpoint (the Vast-backed
 * Chatterbox voice-clone lane) so both the plain TTS route and the
 * live-avatar speak route drive the same synthesis path.
 */

import { getAutobotUserSettings } from "@/lib/autobot-user-settings";

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

export const TTS_MAX_TEXT_LENGTH = 2000;

export type ChatterboxTtsResult =
  /** Synthesized speech audio ready to play / lip-sync against. */
  | { kind: "audio"; audio: ArrayBuffer; contentType: string }
  /** Upstream answered with a JSON signal (e.g. { fallback: true }). */
  | { kind: "json"; data: unknown }
  /** Upstream answered non-OK. */
  | { kind: "error"; status: number; detail: string }
  /** Network failure reaching the OpenClaw server. */
  | { kind: "unreachable"; detail: string };

export async function requestChatterboxTts(
  userId: string,
  username: string,
  text: string,
): Promise<ChatterboxTtsResult> {
  const settings = await getAutobotUserSettings(userId).catch(() => null);

  let response: Response;
  try {
    response = await fetch(`${OPENCLAW_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, TTS_MAX_TEXT_LENGTH),
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
