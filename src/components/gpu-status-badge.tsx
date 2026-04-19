"use client";

/**
 * GpuStatusBadge — persistent floating indicator for GPU (Chatterbox TTS) status.
 *
 * ALWAYS visible in the bottom-left corner so the user can see GPU state at a glance.
 * Polls GET /api/autobot/gpu every 15 s while the tab is visible.
 *
 * States shown:
 * - GPU Active (emerald): running, with stop button
 * - GPU Starting (amber, pulsing): provisioning / gpu_starting
 * - GPU Idle (zinc): stopped with instanceId, with decommission button
 * - No GPU (slate): no instance, with "Start Voice" button
 * - Unknown (slate): initial/fetch-error state, with "Start Voice" button
 *
 * Transitions:
 * - provisioning -> running: plays notification beep + shows "Personal voice ready" modal
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Cpu,
  ExternalLink,
  Loader2,
  Play,
  Power,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────────

const GPU_STATUS_ENDPOINT = "/api/autobot/gpu";
const POLL_INTERVAL_MS = 15_000;

/**
 * Short notification beep encoded as a base64 WAV data URI.
 * ~0.25 s, 880 Hz sine tone, 8-bit PCM mono @ 8 kHz.
 */
const NOTIFICATION_SOUND_URI =
  "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAAC" +
  "BhYqFbF1sbWxtamlsamdramtrbW5ta2hqbG5zdnl7e3t5dnRycXBwcHJ0d3l7fX5+fn18" +
  "enl4eHh5ent9fn9/gICAgH9+fX19fX5+f4CAgICAgH9/f39/f39/f4CAgICAgICAgICAg" +
  "H9/f39/f39/gICAgICAgICAgICAf39/f39/f39/gICBgYGBgYGBgIB/f39/f39/f3+AgI" +
  "GBgYGBgYGAgH9/f39/f39/f4CAgYGBgYGBgIB/f39+fn5+fn+AgIGBgoKCgoGBgH9/fn5" +
  "+fn5+f4CAgYGCgoKCgYGAf39+fn5+fn5/gICBgYKCgoKBgYB/f35+fn5+fn+AgIGBgoKC" +
  "goGBgH9/fn5+fn5+f4CBgYKCg4OCgYGAf39+fn19fn5/gIGBgoKDg4KBgYB/f35+fX1+f" +
  "n+AgYGCgoODgoGBgH9/fn59fX5+f4CBgYKCg4OCgYGAf39+fn19fn5/gIGBgoKDg4KBgX" +
  "9/f35+fX1+fn+AgYGCgoODgoGBf39/fn59fX5+f4CBgYKCg4OCgYF/f39+fn19fn5/gIG" +
  "BgoKDg4KBgX9/f35+fX5+f4CBgYKCg4OCgYF/f39+fn19fn5/gIGBgoKDg4KBgH9/fn5+" +
  "fX1+fn+AgYGCgoODgoGAf39+fn59fX5+f4CBgYKCg4KCgYB/f35+fn19fn5/gIGBgoKDg" +
  "oKBgH9/fn5+fX1+fn+AgYGCgoOCgoGAf39+fn59fX5+f4CBgYKCg4KCgYB/f35+fn19fX" +
  "5/gIGBgoKDgoKBgH9/fn5+fX19fn+AgYGCgoKCgoGAf39+fn5+fX1+f4CBgYKCgoKCgYB" +
  "/f35+fn5+fX5/gIGBgYKCgoKBgH9/fn5+fn5+fn+AgYGBgoKCgoGAf39+fn5+fn5+f4CB" +
  "gYGCgoKCgYB/f35+fn5+fn5/gIGBgYKCgoKBgH9/fn5+fn5+fn+AgYGBgoKCgoGAf39+f" +
  "n5+fn5+f4CBgYGCgoKBgYB/f35+fn5+fn5/gIGBgYKCgoGBgH9/fn5+fn5+fn+AgYGBgo" +
  "KCgYGAf39+fn5+fn5+f4CBgYGCgoKBgYB/f35+fn5+fn5/gA==";

type GpuStatus =
  | "stopped"
  | "stopping"
  | "running"
  | "provisioning"
  | "gpu_starting"
  | "no_gpu"
  | "unknown";

interface GpuStatusResponse {
  status: GpuStatus;
  instanceId?: string;
  url?: string;
  idleSec?: number;
  gpuName?: string | null;
  dphTotal?: number | null;
  storageCostDph?: number | null;
  provider?: "vast" | "local" | "custom";
  providerLabel?: string | null;
  providerConsoleUrl?: string | null;
  providerBalance?: number | null;
  providerBalanceStatus?: "ok" | "empty" | "unknown" | "unavailable";
  providerApiKeyConfigured?: boolean;
  walletBalanceDollars?: number | null;
  walletBalanceStatus?: "ok" | "empty" | "unknown";
  settingsUrl?: string;
}

/** Statuses where the GPU is actively computing */
const ACTIVE_STATUSES: ReadonlySet<GpuStatus> = new Set([
  "running",
  "provisioning",
  "gpu_starting",
]);

/** Statuses where the instance is rented but idle */
const RENTED_IDLE_STATUSES: ReadonlySet<GpuStatus> = new Set([
  "stopped",
  "stopping",
]);

/** Statuses where the user can start the GPU */
const STARTABLE_STATUSES: ReadonlySet<GpuStatus> = new Set([
  "no_gpu",
  "unknown",
  "stopped",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatPrice(dph: number | null | undefined): string | null {
  if (dph == null) return null;
  return `$${dph.toFixed(2)}/hr`;
}

function playNotificationSound(): void {
  try {
    const audio = new Audio(NOTIFICATION_SOUND_URI);
    audio.volume = 0.6;
    audio.play().catch(() => {
      // Browser may block autoplay — non-critical
    });
  } catch {
    // Audio API unavailable — non-critical
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function GpuStatusBadge() {
  const router = useRouter();
  const [gpuStatus, setGpuStatus] = useState<GpuStatusResponse | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [showReadyModal, setShowReadyModal] = useState(false);
  const [showDecommissionConfirm, setShowDecommissionConfirm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<GpuStatus | null>(null);

  // ── Fetch GPU status ─────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(GPU_STATUS_ENDPOINT);
      if (!res.ok) {
        setFetchError(true);
        return;
      }
      const data: GpuStatusResponse = await res.json();
      setGpuStatus(data);
      setFetchError(false);

      // Detect provisioning -> running transition
      const prev = prevStatusRef.current;
      if (
        data.status === "running" &&
        prev != null &&
        (prev === "provisioning" || prev === "gpu_starting")
      ) {
        playNotificationSound();
        setShowReadyModal(true);
        setMinimized(false);
      }

      prevStatusRef.current = data.status;
    } catch {
      setFetchError(true);
    }
  }, []);

  // ── Poll while tab is visible ───────────────────────────────────────────
  useEffect(() => {
    fetchStatus();

    const startPolling = () => {
      if (pollRef.current) return;
      pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    startPolling();

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchStatus();
        startPolling();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchStatus]);

  // ── GPU actions ──────────────────────────────────────────────────────────
  const performAction = async (action: string) => {
    setActionInProgress(action);
    try {
      const res = await fetch(GPU_STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        await fetchStatus();
      }
    } catch {
      // Swallow — next poll will correct state
    } finally {
      setActionInProgress(null);
    }
  };

  const handleStart = () => performAction("start");
  const handleStop = () => performAction("stop");

  const handleDecommission = async () => {
    setShowDecommissionConfirm(false);
    await performAction("decommission");
  };

  // ── Determine current state ─────────────────────────────────────────────

  const status = gpuStatus?.status ?? "unknown";
  const isProvisioning =
    status === "provisioning" || status === "gpu_starting";
  const isRunning = status === "running";
  const isRentedIdle =
    RENTED_IDLE_STATUSES.has(status) && !!gpuStatus?.instanceId;
  const isOff = status === "no_gpu" || status === "unknown" || (status === "stopped" && !gpuStatus?.instanceId);
  const canStart = STARTABLE_STATUSES.has(status) && actionInProgress === null;

  const priceLabel = formatPrice(gpuStatus?.dphTotal);
  const storageLabel = formatPrice(gpuStatus?.storageCostDph);
  const gpuLabel = gpuStatus?.gpuName || null;
  const providerLabel = gpuStatus?.providerLabel || "Provider";
  const providerBalanceLabel =
    typeof gpuStatus?.providerBalance === "number"
      ? `$${gpuStatus.providerBalance.toFixed(2)}`
      : null;
  const isProviderEmpty = gpuStatus?.providerBalanceStatus === "empty";
  const isWalletEmpty = gpuStatus?.walletBalanceStatus === "empty";
  const settingsUrl = gpuStatus?.settingsUrl || "/autobot/chat?settings=voice";

  const openSettings = useCallback(() => {
    router.push(settingsUrl);
  }, [router, settingsUrl]);

  const openProviderConsole = useCallback(() => {
    if (!gpuStatus?.providerConsoleUrl) return;
    window.open(gpuStatus.providerConsoleUrl, "_blank", "noopener,noreferrer");
  }, [gpuStatus?.providerConsoleUrl]);

  // Status label and color
  let badgeLabel = "No GPU";
  let badgeSubLabel: string | null = null;
  let badgeColor = "border-slate-500/40 bg-slate-900/80 text-slate-400";
  let dotColor = "bg-slate-500";

  if (fetchError && !gpuStatus) {
    badgeLabel = "GPU Offline";
    badgeColor = "border-slate-500/40 bg-slate-900/80 text-slate-400";
    dotColor = "bg-slate-500";
  } else if (isProviderEmpty) {
    badgeLabel = `${providerLabel} credits empty`;
    badgeSubLabel = providerBalanceLabel
      ? `Balance ${providerBalanceLabel} · add provider credits`
      : "Add provider credits to start voice";
    badgeColor = "border-red-500/40 bg-red-950/80 text-red-200";
    dotColor = "bg-red-500";
  } else if (isWalletEmpty) {
    badgeLabel = "Buy credits";
    badgeSubLabel = "Your Autobot balance is empty";
    badgeColor = "border-red-500/40 bg-red-950/80 text-red-200";
    dotColor = "bg-red-500";
  } else if (isProvisioning) {
    badgeLabel = gpuLabel ? `${gpuLabel} starting...` : "GPU Starting";
    badgeSubLabel = priceLabel;
    badgeColor = "border-amber-500/40 bg-amber-950/80 text-amber-300";
    dotColor = "bg-amber-500 animate-pulse";
  } else if (isRunning) {
    badgeLabel = gpuLabel ? `${gpuLabel} active` : "GPU Active";
    badgeSubLabel = priceLabel;
    badgeColor = "border-emerald-500/40 bg-emerald-950/80 text-emerald-300";
    dotColor = "bg-emerald-500";
  } else if (isRentedIdle) {
    badgeLabel = gpuLabel ? `${gpuLabel} idle` : "GPU Idle";
    badgeSubLabel = storageLabel ? `Storage: ${storageLabel}` : null;
    badgeColor = "border-zinc-500/40 bg-zinc-900/80 text-zinc-400";
    dotColor = "bg-zinc-500";
  } else if (isOff) {
    badgeLabel = "No GPU";
    badgeColor = "border-slate-500/40 bg-slate-900/80 text-slate-400";
    dotColor = "bg-slate-500";
  }

  return (
    <>
      {/* ── "Personal voice ready" notification modal ────────────── */}
      <Dialog open={showReadyModal} onOpenChange={setShowReadyModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-emerald-500" />
              Personal voice ready
            </DialogTitle>
            <DialogDescription>
              {gpuLabel
                ? `Your ${gpuLabel} GPU is active and your cloned voice is loaded.`
                : "Your GPU is active and your cloned voice is loaded."}
              {priceLabel && (
                <span className="block mt-1 text-xs text-muted-foreground">
                  Current rate: {priceLabel}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setShowReadyModal(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Decommission confirmation dialog ─────────────────────── */}
      <AlertDialog
        open={showDecommissionConfirm}
        onOpenChange={setShowDecommissionConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Release GPU?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will release the GPU and stop all billing. Re-provisioning
              takes <strong>5-10 minutes</strong> to find a new instance and
              re-install your personal voice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDecommission}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionInProgress === "decommission" ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Release GPU
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Floating status badge — ALWAYS visible ──────────────── */}
      <div
        className={cn(
          "fixed bottom-[5.5rem] left-3 z-50",
          "animate-in fade-in slide-in-from-bottom-2 duration-300",
        )}
      >
        {minimized ? (
          /* Minimized: just a colored dot that expands on click */
          <button
            onClick={() => setMinimized(false)}
            className={cn(
              "flex items-center justify-center h-7 w-7 rounded-full shadow-lg border backdrop-blur-md transition-all hover:scale-110",
              badgeColor,
            )}
            aria-label={`GPU status: ${badgeLabel}. Click to expand.`}
          >
            <span className={cn("h-2.5 w-2.5 rounded-full", dotColor)} />
          </button>
        ) : (
          /* Expanded badge */
          <div
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 shadow-lg border backdrop-blur-md",
              badgeColor,
            )}
          >
            {/* Status dot / icon */}
            {isProvisioning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : isRunning ? (
              <Cpu className="h-3.5 w-3.5 shrink-0" />
            ) : isRentedIdle ? (
              <Power className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", dotColor)} />
            )}

            {/* Label + price sub-line */}
            <button
              type="button"
              onClick={
                isProviderEmpty
                  ? openProviderConsole
                  : isWalletEmpty
                    ? openSettings
                    : undefined
              }
              className={cn(
                "flex flex-col leading-tight text-left",
                (isProviderEmpty || isWalletEmpty) && "hover:opacity-90",
              )}
              disabled={
                (isProviderEmpty && !gpuStatus?.providerConsoleUrl) ||
                (!isProviderEmpty && !isWalletEmpty)
              }
            >
              <span className="text-xs font-medium whitespace-nowrap">
                {badgeLabel}
              </span>
              {badgeSubLabel && (
                <span className="text-[10px] opacity-70">{badgeSubLabel}</span>
              )}
            </button>

            {/* Start Voice button (no GPU / off / stopped without instance) */}
            {!isProviderEmpty && !isWalletEmpty && (isOff || (status === "stopped" && !gpuStatus?.instanceId)) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={actionInProgress !== null}
                onClick={handleStart}
                className={cn(
                  "h-6 px-2 rounded-full text-[10px] font-medium gap-1",
                  "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20",
                )}
                aria-label="Start personal voice GPU"
              >
                {actionInProgress === "start" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                Start Voice
              </Button>
            )}

            {isWalletEmpty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={openSettings}
                className={cn(
                  "h-6 px-2 rounded-full text-[10px] font-medium gap-1",
                  "text-red-200 hover:text-white hover:bg-red-500/20",
                )}
              >
                Buy Credits
              </Button>
            )}

            {isProviderEmpty && gpuStatus?.providerConsoleUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={openProviderConsole}
                className={cn(
                  "h-6 px-2 rounded-full text-[10px] font-medium gap-1",
                  "text-red-200 hover:text-white hover:bg-red-500/20",
                )}
              >
                <ExternalLink className="h-3 w-3" />
                Open {providerLabel}
              </Button>
            )}

            {/* Stop button (running only) */}
            {isRunning && (
              <Button
                variant="ghost"
                size="sm"
                disabled={actionInProgress !== null}
                onClick={handleStop}
                className={cn(
                  "h-5 w-5 p-0 rounded-full",
                  "text-emerald-400 hover:text-red-400 hover:bg-red-500/20",
                )}
                aria-label="Stop GPU"
              >
                {actionInProgress === "stop" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Square className="h-3 w-3" />
                )}
              </Button>
            )}

            {/* Decommission button (rented idle only) */}
            {isRentedIdle && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actionInProgress !== null}
                  onClick={handleStart}
                  className={cn(
                    "h-5 px-1.5 rounded-full text-[10px] font-medium gap-1",
                    "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20",
                  )}
                  aria-label="Restart GPU"
                >
                  {actionInProgress === "start" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actionInProgress !== null}
                  onClick={() => setShowDecommissionConfirm(true)}
                  className={cn(
                    "h-5 w-5 p-0 rounded-full",
                    "text-zinc-400 hover:text-red-400 hover:bg-red-500/20",
                  )}
                  aria-label="Release GPU"
                >
                  {actionInProgress === "decommission" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </>
            )}

            {/* Minimize button */}
            <button
              onClick={() => setMinimized(true)}
              className={cn(
                "h-4 w-4 rounded-full inline-flex items-center justify-center shrink-0",
                "opacity-60 hover:opacity-100 transition-opacity",
              )}
              aria-label="Minimize GPU status"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
