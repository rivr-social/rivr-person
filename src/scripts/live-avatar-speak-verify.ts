/**
 * Live-avatar speak verification — drives the app's own worker client
 * (the same functions the session/speak routes call) end to end:
 * resolves the agent's portrait + pack + sidecar, opens a REAL worker
 * session, synthesizes a cloned-voice reply, and speaks it through the
 * session. Reports which lane animated the utterance:
 *   source "gpu"   — Wav2Lip frames from the sidecar (Tier 2 live)
 *   source "audio" — baked-pack timeline (Tier 1; also the fallback)
 *
 * Run via the throwaway-container recipe:
 *   node_modules/.bin/tsx src/scripts/live-avatar-speak-verify.ts <agentId> \
 *     [--expect gpu|audio] [--text "hello"]
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { requestChatterboxTts } from "@/lib/chatterbox-tts";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  createAvatarSession,
  deleteAvatarSession,
  speakAudio,
} from "@/lib/live-avatar-worker";
import { getInstance, sidecarUrl } from "@/lib/vast-gpu";

const DEFAULT_TEXT =
  "The face you are watching was rendered by the graphics card, in my own voice.";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [speak-verify] ${message}`);
}

function fail(message: string): never {
  console.error(`[${new Date().toISOString()}] [speak-verify] FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agentId = args.find((value) => !value.startsWith("--"));
  if (!agentId) fail("usage: live-avatar-speak-verify.ts <agentId> [--expect gpu|audio]");
  const expectIndex = args.indexOf("--expect");
  const expected = expectIndex >= 0 ? args[expectIndex + 1] : null;
  const textIndex = args.indexOf("--text");
  const text = textIndex >= 0 && args[textIndex + 1] ? args[textIndex + 1] : DEFAULT_TEXT;

  const settings = await getAutobotUserSettings(agentId);

  // Portrait: same order as the session route (reference-portrait → photo).
  const referencePortrait = settings.digitalTwin.assets.find(
    (asset) =>
      asset.kind === "reference-portrait" && asset.mimeType.startsWith("image/"),
  );
  let imageRef = referencePortrait?.url ?? null;
  if (!imageRef) {
    const [agentRow] = await db
      .select({ image: agents.image })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    imageRef = agentRow?.image ?? null;
  }
  if (!imageRef) fail("no portrait");
  const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
  const imageUrl = /^https?:\/\//.test(imageRef)
    ? imageRef
    : `${baseUrl}${imageRef.startsWith("/") ? "" : "/"}${imageRef}`;
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
  if (!imageResponse.ok) fail(`portrait fetch ${imageResponse.status}`);
  const imageBytes = await imageResponse.arrayBuffer();

  // Sidecar (GPU-live), same resolution as the session route.
  let gpuAnimateUrl: string | undefined;
  const apiKey = settings.gpuProviderApiKey?.trim();
  if (settings.chatterboxGpu?.url && apiKey) {
    const instance = await getInstance(apiKey, settings.chatterboxGpu.instanceId).catch(
      () => null,
    );
    if (instance?.actualStatus === "running") {
      gpuAnimateUrl = sidecarUrl(instance) ?? undefined;
    }
  }
  log(`sidecar: ${gpuAnimateUrl ?? "none (pack-only session)"}`);

  const pack = settings.visemePack;
  const info = await createAvatarSession(imageBytes, "avatar.jpg", "image/jpeg", {
    visemeFrames: pack?.frames,
    calibration: settings.liveAvatarCalibration ?? undefined,
    gpuAnimateUrl,
  });
  log(
    `session ${info.sessionId}: mode=${info.mode} fps=${info.fps} ` +
      `pack=${pack ? Object.keys(pack.frames).length : 0} frames`,
  );

  try {
    const tts = await requestChatterboxTts(agentId, text);
    if (tts.kind !== "audio") {
      fail(`no clone audio (${JSON.stringify(tts).slice(0, 200)}) — is the voice box warm?`);
    }
    log(`clone audio: ${tts.audio.byteLength} bytes ${tts.contentType}`);

    const started = Date.now();
    const result = await speakAudio(info.sessionId, tts.audio, tts.contentType, text);
    log(
      `speak: source=${result.source} durationMs=${result.durationMs} ` +
        `frames=${result.frames} (speak call took ${Date.now() - started}ms)`,
    );
    if (expected && result.source !== expected) {
      fail(`expected source=${expected}, got ${result.source}`);
    }
    log("VERIFY PASS");
  } finally {
    await deleteAvatarSession(info.sessionId).catch(() => {});
  }
  process.exit(0);
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
