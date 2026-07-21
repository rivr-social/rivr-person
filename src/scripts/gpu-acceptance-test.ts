/**
 * Chatterbox GPU lane acceptance test — proves "works from the app in
 * every case" with zero SSH and zero DB hand-edits.
 *
 * Drives the SAME functions the /api/autobot/gpu route runs (vast-gpu
 * lifecycle, settings persistence, voice-sample URL resolution, and the
 * real requestChatterboxTts ladder) through the full hands-off cycle:
 *
 *   destroy existing box -> provision fresh (app create body) -> wait
 *   ready (/docs probe) -> synthesize cloned voice -> stop -> restart ->
 *   wait ready -> synthesize again
 *
 * Run against live infra via the throwaway-container recipe (memory:
 * reference_run_app_tsx_against_live_infra):
 *
 *   node_modules/.bin/tsx src/scripts/gpu-acceptance-test.ts <agentId> \
 *     [--adopt] [--text "hello"]
 *
 * --adopt resumes on the box already recorded in settings (skips destroy
 * + provision) — for re-running the ready/synth/restart phases after an
 * interrupted run. Exits 0 only when BOTH synth passes return clone audio.
 */

import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type ChatterboxGpuState,
} from "@/lib/autobot-user-settings";
import { requestChatterboxTts } from "@/lib/chatterbox-tts";
import { getVoiceSampleUrl } from "@/lib/storage";
import {
  createChatterboxInstance,
  destroyInstance,
  findCheapestOffer,
  getInstance,
  listChatterboxInstances,
  startInstance,
  stopInstance,
  workerUrl,
} from "@/lib/vast-gpu";

const POLL_INTERVAL_MS = 20_000;
const PROVISION_READY_TIMEOUT_MS = 30 * 60 * 1000;
const RESTART_READY_TIMEOUT_MS = 12 * 60 * 1000;
const STOP_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;
const WORKER_PROBE_TIMEOUT_MS = 6_000;
const MIN_CLONE_AUDIO_BYTES = 10_000;
const DEFAULT_SYNTH_TEXT =
  "This is my cloned voice, provisioned entirely from the app with no manual steps.";

function log(phase: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${phase}] ${message}`);
}

function fail(phase: string, message: string): never {
  console.error(`[${new Date().toISOString()}] [${phase}] FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same readiness signal the route's probeWorkerHealth uses: /docs 200. */
async function probeDocs(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/docs`, {
      signal: AbortSignal.timeout(WORKER_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Poll until the instance is running AND the voice server answers /docs,
 * then stamp the resolved url into settings exactly as resolveGpuStatus
 * does. Returns the ready worker url.
 */
async function waitVoiceReady(
  phase: string,
  apiKey: string,
  agentId: string,
  instanceId: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = await getInstance(apiKey, instanceId).catch(() => null);
    if (!instance) {
      log(phase, `instance ${instanceId} not visible yet; waiting`);
    } else if (instance.actualStatus !== "running") {
      log(phase, `box ${instance.actualStatus}; waiting`);
    } else {
      const url = workerUrl(instance);
      if (!url) {
        log(phase, "box running, no port mapping yet; waiting");
      } else if (await probeDocs(url)) {
        const settings = await getAutobotUserSettings(agentId);
        const gpu = settings.chatterboxGpu;
        if (gpu && gpu.url !== url) {
          await saveAutobotUserSettings(agentId, {
            chatterboxGpu: { ...gpu, url },
          });
        }
        log(phase, `VOICE READY at ${url} (stamped in settings)`);
        return url;
      } else {
        log(phase, `box running at ${url}, voice server warming (no /docs yet)`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(phase, `voice not ready within ${Math.round(timeoutMs / 60000)} min`);
}

/** Run the app's REAL TTS ladder and require clone audio back. */
async function assertCloneSynth(
  phase: string,
  agentId: string,
  username: string,
  text: string,
): Promise<void> {
  const started = Date.now();
  const result = await requestChatterboxTts(agentId, username, text);
  if (result.kind !== "audio") {
    fail(phase, `expected clone audio, got ${JSON.stringify(result).slice(0, 300)}`);
  }
  const bytes = result.audio.byteLength;
  if (bytes < MIN_CLONE_AUDIO_BYTES) {
    fail(phase, `audio suspiciously small (${bytes} bytes)`);
  }
  log(
    phase,
    `clone synth OK: ${bytes} bytes ${result.contentType} in ${Date.now() - started}ms`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agentId = args.find((value) => !value.startsWith("--"));
  if (!agentId) fail("setup", "usage: gpu-acceptance-test.ts <agentId> [--adopt] [--text ...]");
  const adopt = args.includes("--adopt");
  const textFlagIndex = args.indexOf("--text");
  const synthText =
    textFlagIndex >= 0 && args[textFlagIndex + 1]
      ? args[textFlagIndex + 1]
      : DEFAULT_SYNTH_TEXT;

  const settings = await getAutobotUserSettings(agentId);
  const apiKey = settings.gpuProviderApiKey?.trim();
  if (!apiKey) fail("setup", "agent has no gpuProviderApiKey in autobot settings");
  const voiceKey = settings.voiceSample?.storedFileName ?? "";
  if (!voiceKey.includes("/")) {
    fail("setup", "agent has no stored voice sample (Settings -> Assistant -> Voice)");
  }
  const username = settings.voiceSample?.originalFileName ?? "owner";

  let instanceId: number;
  if (adopt) {
    // Resume on the recorded box (an interrupted run already provisioned
    // it through the app path) — the ready/synth/restart phases still run.
    if (!settings.chatterboxGpu) fail("adopt", "no recorded chatterboxGpu to adopt");
    instanceId = settings.chatterboxGpu.instanceId;
    log("adopt", `resuming on recorded instance ${instanceId}`);
  } else {
    instanceId = await destroyAndProvision(agentId, apiKey, voiceKey, settings);
  }

  // ── Phase 3: first boot -> voice ready -> cloned-voice synth ───────────
  await waitVoiceReady("first-boot", apiKey, agentId, instanceId, PROVISION_READY_TIMEOUT_MS);
  await assertCloneSynth("first-synth", agentId, username, synthText);

  // ── Phase 4: stop (idle-stop analog), then restart durability ──────────
  log("stop", `stopping instance ${instanceId}`);
  await stopInstance(apiKey, instanceId);
  const stopDeadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
  while (Date.now() < stopDeadline) {
    const instance = await getInstance(apiKey, instanceId).catch(() => null);
    if (instance && (instance.actualStatus === "stopped" || instance.actualStatus === "exited")) {
      log("stop", "box reports stopped");
      break;
    }
    log("stop", `box ${instance?.actualStatus ?? "unknown"}; waiting for stopped`);
    await sleep(POLL_INTERVAL_MS);
  }

  log("restart", `starting instance ${instanceId} (resume-guarded onstart is under test)`);
  await startInstance(apiKey, instanceId);
  await waitVoiceReady("restart", apiKey, agentId, instanceId, RESTART_READY_TIMEOUT_MS);
  await assertCloneSynth("restart-synth", agentId, username, synthText);

  // Leave the box running with fresh usage so the owner can talk now;
  // the idle reapers take it from here.
  const finalSettings = await getAutobotUserSettings(agentId);
  if (finalSettings.chatterboxGpu) {
    await saveAutobotUserSettings(agentId, {
      chatterboxGpu: {
        ...finalSettings.chatterboxGpu,
        lastUsedAt: new Date().toISOString(),
      },
    });
  }

  log(
    "done",
    `ACCEPTANCE PASS: instance ${instanceId} provisioned, synthesized, ` +
      "stopped, restarted, and synthesized again — zero SSH, zero hand-edits",
  );
  process.exit(0);
}

/** Phases 1+2: clean slate, then provision exactly as the route's start action does. */
async function destroyAndProvision(
  agentId: string,
  apiKey: string,
  voiceKey: string,
  settings: Awaited<ReturnType<typeof getAutobotUserSettings>>,
): Promise<number> {
  if (settings.chatterboxGpu) {
    log("destroy", `destroying recorded box ${settings.chatterboxGpu.instanceId}`);
    await destroyInstance(apiKey, settings.chatterboxGpu.instanceId).catch((error) =>
      log("destroy", `recorded box destroy: ${error instanceof Error ? error.message : error}`),
    );
    await saveAutobotUserSettings(agentId, { chatterboxGpu: null });
  }
  const orphans = await listChatterboxInstances(apiKey);
  for (const orphan of orphans) {
    log("destroy", `destroying orphan rivr-chatterbox box ${orphan.instanceId}`);
    await destroyInstance(apiKey, orphan.instanceId).catch((error) =>
      log("destroy", `orphan destroy: ${error instanceof Error ? error.message : error}`),
    );
  }

  // Provision EXACTLY as the route's start action does.
  const voiceSampleUrl = getVoiceSampleUrl(voiceKey);
  log("provision", `voice sample url: ${voiceSampleUrl}`);
  const offerId = await findCheapestOffer(apiKey);
  log("provision", `cheapest offer: ${offerId}`);
  const instanceId = await createChatterboxInstance(apiKey, offerId, { voiceSampleUrl });
  log("provision", `created instance ${instanceId} (app create body, runtype ssh_proxy)`);

  const gpuState: ChatterboxGpuState = {
    instanceId,
    url: "",
    authToken: "",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  await saveAutobotUserSettings(agentId, { chatterboxGpu: gpuState });
  return instanceId;
}

main().catch((error) => {
  fail("unhandled", error instanceof Error ? (error.stack ?? error.message) : String(error));
});
