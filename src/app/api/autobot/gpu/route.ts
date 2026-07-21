/**
 * Chatterbox voice GPU lifecycle (first-party Vast.ai lane).
 *
 * POST /api/autobot/gpu — { action: "start" | "stop" | "heartbeat" | "refresh" | "decommission" }
 *   start        — restart the stopped instance, or provision a new one
 *   stop         — stop the instance (storage-only billing)
 *   decommission — destroy the instance entirely
 *   heartbeat / refresh — alias for a status poll
 * GET  /api/autobot/gpu — status + provider/wallet balance summaries.
 *
 * Replaces the retired OpenClaw token-server proxy: the lifecycle now runs
 * directly against Vast.ai with the user's own API key (settings), and the
 * worker boots from this instance's /api/autobot/gpu/worker-source. The
 * box self-stops when idle; this route also stops it defensively when a
 * status poll sees >35 idle minutes.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type ChatterboxGpuState,
  type GpuProvider,
} from "@/lib/autobot-user-settings";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  createChatterboxInstance,
  destroyInstance,
  findCheapestOffer,
  getInstance,
  getVastBalance,
  listChatterboxInstances,
  startInstance,
  stopInstance,
  workerUrl,
  VastApiError,
} from "@/lib/vast-gpu";
import { getOrCreateWallet, getWalletBalance } from "@/lib/wallet";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUTOBOT_SETTINGS_URL = "/autobot/chat?settings=voice";
const IDLE_STOP_MS = 35 * 60 * 1000;
const WORKER_HEALTH_TIMEOUT_MS = 6_000;

type GpuStatus =
  | "no_gpu"
  | "provisioning"
  | "gpu_starting"
  | "running"
  | "stopped"
  | "unknown";

// ---------------------------------------------------------------------------
// Balance summaries (unchanged surface for GpuStatusBadge)
// ---------------------------------------------------------------------------

type ProviderBalanceStatus = "ok" | "empty" | "unknown" | "unavailable";
type WalletBalanceStatus = "ok" | "empty" | "unknown";

function getProviderLabel(provider: GpuProvider): string {
  switch (provider) {
    case "vast":
      return "Vast.ai";
    case "local":
      return "Local GPU";
    case "custom":
      return "Custom provider";
    default:
      return "GPU provider";
  }
}

async function getProviderBalanceSummary(
  settings: Awaited<ReturnType<typeof getAutobotUserSettings>> | null,
) {
  const provider = settings?.gpuProvider ?? "vast";
  const providerApiKey = settings?.gpuProviderApiKey?.trim() ?? "";
  const providerLabel = getProviderLabel(provider);
  const providerConsoleUrl =
    provider === "vast" ? "https://cloud.vast.ai/billing" : null;

  if (provider !== "vast" || !providerApiKey) {
    return {
      provider,
      providerLabel,
      providerConsoleUrl,
      providerBalance: null,
      providerBalanceStatus: (providerApiKey
        ? "unknown"
        : "unavailable") as ProviderBalanceStatus,
      providerApiKeyConfigured: providerApiKey.length > 0,
      providerEndpoint: settings?.gpuProviderEndpoint?.trim() ?? "",
    };
  }

  try {
    const providerBalance = await getVastBalance(providerApiKey);
    return {
      provider,
      providerLabel,
      providerConsoleUrl,
      providerBalance,
      providerBalanceStatus: (providerBalance !== null && providerBalance <= 0
        ? "empty"
        : "ok") as ProviderBalanceStatus,
      providerApiKeyConfigured: true,
      providerEndpoint: settings?.gpuProviderEndpoint?.trim() ?? "",
    };
  } catch {
    return {
      provider,
      providerLabel,
      providerConsoleUrl,
      providerBalance: null,
      providerBalanceStatus: "unknown" as ProviderBalanceStatus,
      providerApiKeyConfigured: true,
      providerEndpoint: settings?.gpuProviderEndpoint?.trim() ?? "",
    };
  }
}

async function getWalletBalanceSummary(userId: string) {
  try {
    const wallet = await getOrCreateWallet(userId, "personal");
    const balance = await getWalletBalance(wallet.id);
    const walletBalanceDollars =
      typeof balance.balanceDollars === "number" ? balance.balanceDollars : 0;
    return {
      walletBalanceDollars,
      walletBalanceStatus: (walletBalanceDollars <= 0
        ? "empty"
        : "ok") as WalletBalanceStatus,
    };
  } catch {
    return {
      walletBalanceDollars: null,
      walletBalanceStatus: "unknown" as WalletBalanceStatus,
    };
  }
}

// ---------------------------------------------------------------------------
// Worker probing + status resolution
// ---------------------------------------------------------------------------

type WorkerProbe = { healthy: boolean; modelLoaded: boolean };

async function probeWorkerHealth(url: string): Promise<WorkerProbe> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(WORKER_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return { healthy: false, modelLoaded: false };
    const data = (await response.json()) as {
      ok?: boolean;
      model_loaded?: boolean;
    };
    return {
      healthy: data.ok === true,
      modelLoaded: data.model_loaded === true,
    };
  } catch {
    return { healthy: false, modelLoaded: false };
  }
}

interface ResolvedGpu {
  status: GpuStatus;
  gpu: ChatterboxGpuState | null;
  instanceId?: number;
  gpuName?: string | null;
  dphTotal?: number | null;
  url?: string | null;
}

async function resolveGpuStatus(
  userId: string,
  apiKey: string,
  gpu: ChatterboxGpuState | null,
): Promise<ResolvedGpu> {
  if (!gpu) return { status: "no_gpu", gpu: null };

  let instance;
  try {
    instance = await getInstance(apiKey, gpu.instanceId);
  } catch {
    return { status: "unknown", gpu, instanceId: gpu.instanceId };
  }

  if (!instance) {
    // Destroyed outside our control — clear the stale pointer.
    await saveAutobotUserSettings(userId, { chatterboxGpu: null }).catch(() => {});
    return { status: "no_gpu", gpu: null };
  }

  const base = {
    gpu,
    instanceId: instance.instanceId,
    gpuName: instance.gpuName,
    dphTotal: instance.dphTotal,
  };

  if (instance.actualStatus === "stopped" || instance.actualStatus === "exited") {
    return { ...base, status: "stopped" };
  }
  if (instance.actualStatus !== "running") {
    return { ...base, status: "provisioning" };
  }

  const url = workerUrl(instance);
  if (!url) return { ...base, status: "gpu_starting" };

  // "running" means the VOICE is ready — a healthy worker whose model is
  // still loading reports gpu_starting so the UI never claims a voice it
  // can't deliver (the badge shows this as warming).
  const probe = await probeWorkerHealth(url);
  if (!probe.healthy || !probe.modelLoaded) {
    return { ...base, status: "gpu_starting", url };
  }

  // Persist the resolved URL for the TTS lane; defensive idle stop.
  if (gpu.url !== url) {
    await saveAutobotUserSettings(userId, {
      chatterboxGpu: { ...gpu, url },
    }).catch(() => {});
  }
  const idleMs = Date.now() - Date.parse(gpu.lastUsedAt || gpu.createdAt);
  if (Number.isFinite(idleMs) && idleMs > IDLE_STOP_MS) {
    await stopInstance(apiKey, instance.instanceId).catch(() => {});
    return { ...base, status: "stopped", url };
  }

  return { ...base, status: "running", url };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action ?? "";
  const validActions = ["start", "stop", "heartbeat", "refresh", "decommission"];
  if (!validActions.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 },
    );
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const apiKey = settings.gpuProviderApiKey?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Add your Vast.ai API key in voice settings before managing the GPU.",
        settingsUrl: AUTOBOT_SETTINGS_URL,
      },
      { status: 400 },
    );
  }

  try {
    switch (action) {
      case "start": {
        // Reuse a stopped instance when one exists (fast restart path).
        const existing = settings.chatterboxGpu
          ? await getInstance(apiKey, settings.chatterboxGpu.instanceId)
          : null;
        if (existing && settings.chatterboxGpu) {
          if (existing.actualStatus !== "running") {
            await startInstance(apiKey, existing.instanceId);
          }
          await saveAutobotUserSettings(session.user.id, {
            chatterboxGpu: {
              ...settings.chatterboxGpu,
              lastUsedAt: new Date().toISOString(),
            },
          });
          return NextResponse.json({
            status: "gpu_starting",
            instanceId: existing.instanceId,
          });
        }

        // Adopt any orphaned rivr-chatterbox instance before provisioning.
        const orphans = await listChatterboxInstances(apiKey);
        if (orphans.length > 0) {
          const orphan = orphans[0];
          if (orphan.actualStatus !== "running") {
            await startInstance(apiKey, orphan.instanceId).catch(() => {});
          }
          const adopted: ChatterboxGpuState = {
            instanceId: orphan.instanceId,
            url: workerUrl(orphan) ?? "",
            authToken: randomBytes(24).toString("hex"),
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          };
          // NOTE: an adopted box keeps its original boot token; destroy and
          // re-provision if auth fails. Recorded so decommission can clean up.
          await saveAutobotUserSettings(session.user.id, { chatterboxGpu: adopted });
          return NextResponse.json({
            status: "gpu_starting",
            instanceId: orphan.instanceId,
            adopted: true,
          });
        }

        const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
        const authToken = randomBytes(24).toString("hex");
        const offerId = await findCheapestOffer(apiKey);
        const instanceId = await createChatterboxInstance(apiKey, offerId, {
          workerSourceUrl: `${baseUrl}/api/autobot/gpu/worker-source`,
          authToken,
          bakeViseme: true,
        });

        const gpuState: ChatterboxGpuState = {
          instanceId,
          url: "",
          authToken,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        };
        await saveAutobotUserSettings(session.user.id, { chatterboxGpu: gpuState });
        return NextResponse.json({ status: "provisioning", instanceId });
      }

      case "stop": {
        if (!settings.chatterboxGpu) {
          return NextResponse.json({ status: "no_gpu" });
        }
        await stopInstance(apiKey, settings.chatterboxGpu.instanceId);
        return NextResponse.json({
          status: "stopped",
          instanceId: settings.chatterboxGpu.instanceId,
        });
      }

      case "decommission": {
        if (settings.chatterboxGpu) {
          await destroyInstance(apiKey, settings.chatterboxGpu.instanceId).catch(
            () => {},
          );
          await saveAutobotUserSettings(session.user.id, { chatterboxGpu: null });
        }
        return NextResponse.json({ status: "no_gpu" });
      }

      case "heartbeat":
      case "refresh": {
        const resolved = await resolveGpuStatus(
          session.user.id,
          apiKey,
          settings.chatterboxGpu,
        );
        if (resolved.gpu && action === "heartbeat") {
          await saveAutobotUserSettings(session.user.id, {
            chatterboxGpu: {
              ...resolved.gpu,
              url: resolved.url ?? resolved.gpu.url,
              lastUsedAt: new Date().toISOString(),
            },
          }).catch(() => {});
        }
        return NextResponse.json({
          status: resolved.status,
          instanceId: resolved.instanceId,
          gpuName: resolved.gpuName,
          dphTotal: resolved.dphTotal,
        });
      }
    }
    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof VastApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : `Failed to ${action} GPU`;
    console.error(`GPU ${action} error:`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAutobotUserSettings(session.user.id).catch(() => null);
  const [providerSummary, walletSummary] = await Promise.all([
    getProviderBalanceSummary(settings),
    getWalletBalanceSummary(session.user.id),
  ]);

  const apiKey = settings?.gpuProviderApiKey?.trim();
  if (!settings || !apiKey) {
    return NextResponse.json({
      status: "no_gpu" as GpuStatus,
      ...providerSummary,
      ...walletSummary,
      settingsUrl: AUTOBOT_SETTINGS_URL,
    });
  }

  const resolved = await resolveGpuStatus(
    session.user.id,
    apiKey,
    settings.chatterboxGpu,
  );
  return NextResponse.json({
    status: resolved.status,
    instanceId: resolved.instanceId,
    gpuName: resolved.gpuName,
    dphTotal: resolved.dphTotal,
    ...providerSummary,
    ...walletSummary,
    settingsUrl: AUTOBOT_SETTINGS_URL,
  });
}
