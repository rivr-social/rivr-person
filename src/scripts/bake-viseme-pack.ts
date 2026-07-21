/**
 * Server-side viseme-pack bake — the same lane POST /api/autobot/live-avatar/
 * bake runs (that route is session-authed; this script is its admin twin for
 * acceptance runs). Resolves the agent's portrait, asks the GPU box's
 * SIDECAR for the pack (LivePortrait bins + openness ladder + regions),
 * stores every frame in MinIO, and saves settings.visemePack.
 *
 * Run via the throwaway-container recipe (reference_run_app_tsx_against_
 * live_infra):
 *   node_modules/.bin/tsx src/scripts/bake-viseme-pack.ts <agentId>
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type VisemePack,
} from "@/lib/autobot-user-settings";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { uploadDigitalTwinAsset } from "@/lib/storage";
import { getInstance, sidecarUrl } from "@/lib/vast-gpu";

const BAKE_TIMEOUT_MS = 280_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [bake] ${message}`);
}

function fail(message: string): never {
  console.error(`[${new Date().toISOString()}] [bake] FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId) fail("usage: bake-viseme-pack.ts <agentId>");

  const settings = await getAutobotUserSettings(agentId);
  const gpu = settings.chatterboxGpu;
  const apiKey = settings.gpuProviderApiKey?.trim();
  if (!gpu || !apiKey) fail("no chatterboxGpu/apiKey in settings — start the voice box first");

  const instance = await getInstance(apiKey, gpu.instanceId);
  if (!instance || instance.actualStatus !== "running") {
    fail(`box ${gpu.instanceId} is not running (${instance?.actualStatus ?? "gone"})`);
  }
  const bakeBaseUrl = sidecarUrl(instance);
  if (!bakeBaseUrl) fail("box has no sidecar port mapped — re-provision it");
  log(`sidecar at ${bakeBaseUrl}`);

  // Same portrait-resolution order as the route: reference-portrait → photo.
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
  if (!imageRef) fail("no portrait to bake");
  const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
  const imageUrl = /^https?:\/\//.test(imageRef)
    ? imageRef
    : `${baseUrl}${imageRef.startsWith("/") ? "" : "/"}${imageRef}`;
  log(`portrait: ${imageUrl}`);

  const start = await fetch(`${bakeBaseUrl}/viseme-pack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!start.ok) fail(`bake start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const { jobId } = (await start.json()) as { jobId?: string };
  if (!jobId) fail("no bake job id");
  log(`bake job ${jobId} running (LivePortrait pass + classify)`);

  const deadline = Date.now() + BAKE_TIMEOUT_MS;
  let job: { status?: string; frames?: Record<string, string>; detail?: string } = {};
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetch(`${bakeBaseUrl}/viseme-pack/${jobId}`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!poll?.ok) continue;
    job = (await poll.json()) as typeof job;
    if (job.status === "done" || job.status === "error") break;
    log("still baking...");
  }
  if (job.status === "error") fail(`bake failed: ${job.detail ?? ""}`);
  if (job.status !== "done") fail("bake timed out");

  const frames = job.frames ?? {};
  const labels = Object.keys(frames);
  log(`bake produced ${labels.length} frames: ${labels.sort().join(", ")}`);
  if (labels.length < 2) fail("too few frames");

  const storedFrames: Record<string, string> = {};
  for (const label of labels) {
    const buffer = Buffer.from(frames[label], "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_FRAME_BYTES) continue;
    const uploaded = await uploadDigitalTwinAsset(
      buffer,
      `viseme-${label}.png`,
      "image/png",
      agentId,
    );
    storedFrames[label] = uploaded.url;
  }
  if (Object.keys(storedFrames).length < 2) fail("storing frames failed");

  const visemePack: VisemePack = {
    frames: storedFrames,
    generatedAt: new Date().toISOString(),
    sourceImage: imageRef,
  };
  await saveAutobotUserSettings(agentId, { visemePack });
  await saveAutobotUserSettings(agentId, {
    chatterboxGpu: { ...gpu, lastUsedAt: new Date().toISOString() },
  });

  log(`PACK SAVED: ${Object.keys(storedFrames).length} frames (ladder=${
    Object.keys(storedFrames).filter((l) => l.startsWith("step_")).length
  }, regions=${["eyes_closed", "brows_raised"].filter((l) => l in storedFrames).join("+") || "none"})`);
  process.exit(0);
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
