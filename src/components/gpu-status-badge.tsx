"use client";

/**
 * GpuStatusBadge — persistent floating indicator for GPU (Chatterbox TTS) status.
 *
 * Polls GET /api/autobot/gpu every 15 s while the tab is visible.
 * Only renders when TTS is enabled (localStorage `rivr_autobot_tts_enabled`).
 *
 * States:
 * - Provisioning / gpu_starting: amber pill, GPU name if known, burn rate
 * - Running: emerald pill, GPU name, burn rate, stop button
 * - Stopped with instanceId: zinc pill, storage cost, decommission button
 * - Stopped without instance / no_gpu: hidden
 *
 * Transitions:
 * - provisioning -> running: plays notification beep + shows "Personal voice ready" modal
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cpu, Loader2, Power, Square, Trash2, X } from "lucide-react";
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

const TTS_ENABLED_KEY = "rivr_autobot_tts_enabled";
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
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [gpuStatus, setGpuStatus] = useState<GpuStatusResponse | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [showReadyModal, setShowReadyModal] = useState(false);
  const [showDecommissionConfirm, setShowDecommissionConfirm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<GpuStatus | null>(null);

  // ── Check localStorage for TTS enabled flag ──────────────────────────────
  useEffect(() => {
    const check = () => {
      try {
        setTtsEnabled(localStorage.getItem(TTS_ENABLED_KEY) === "true");
      } catch {
        setTtsEnabled(false);
      }
    };
    check();

    const onStorage = (e: StorageEvent) => {
      if (e.key === TTS_ENABLED_KEY) check();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
        setDismissed(false);
      }

      // Auto-clear dismissed when badge should no longer be visible
      const wouldBeVisible =
        ACTIVE_STATUSES.has(data.status) ||
        (RENTED_IDLE_STATUSES.has(data.status) && !!data.instanceId);
      if (!wouldBeVisible) {
        setDismissed(false);
      }

      prevStatusRef.current = data.status;
    } catch {
      setFetchError(true);
    }
  }, []);

  // ── Poll while visible and TTS enabled ───────────────────────────────────
  useEffect(() => {
    if (!ttsEnabled) return;

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
  }, [ttsEnabled, fetchStatus]);

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

  const handleStop = () => performAction("stop");

  const handleDecommission = async () => {
    setShowDecommissionConfirm(false);
    await performAction("decommission");
  };

  // ── Determine visibility ─────────────────────────────────────────────────
  if (!ttsEnabled) return null;
  if (fetchError && !gpuStatus) return null;
  if (!gpuStatus) return null;

  const isProvisioning =
    gpuStatus.status === "provisioning" || gpuStatus.status === "gpu_starting";
  const isRunning = gpuStatus.status === "running";
  const isRentedIdle =
    RENTED_IDLE_STATUSES.has(gpuStatus.status) && !!gpuStatus.instanceId;

  const shouldShowBadge =
    (isProvisioning || isRunning || isRentedIdle) && !dismissed;

  const priceLabel = formatPrice(gpuStatus.dphTotal);
  const storageLabel = formatPrice(gpuStatus.storageCostDph);
  const gpuLabel = gpuStatus.gpuName || null;

  // If nothing to render at all (no badge, no modals), bail
  if (!shouldShowBadge && !showReadyModal && !showDecommissionConfirm) {
    return null;
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

      {/* ── Floating status badge ────────────────────────────────── */}
      {shouldShowBadge && (
        <div
          className={cn(
            "fixed bottom-[5.5rem] left-3 z-50",
            "animate-in fade-in slide-in-from-bottom-2 duration-300",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 shadow-lg border backdrop-blur-md",
              isProvisioning &&
                "border-amber-500/40 bg-amber-950/80 text-amber-300",
              isRunning &&
                "border-emerald-500/40 bg-emerald-950/80 text-emerald-300",
              isRentedIdle &&
                "border-zinc-500/40 bg-zinc-900/80 text-zinc-400",
            )}
          >
            {/* Status icon */}
            {isProvisioning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : isRentedIdle ? (
              <Power className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Cpu className="h-3.5 w-3.5 shrink-0" />
            )}

            {/* Label + price sub-line */}
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-medium whitespace-nowrap">
                {isProvisioning &&
                  (gpuLabel
                    ? `${gpuLabel} provisioning...`
                    : "GPU provisioning...")}
                {isRunning &&
                  (gpuLabel ? `${gpuLabel} active` : "GPU active")}
                {isRentedIdle &&
                  (gpuLabel ? `${gpuLabel} idle` : "GPU idle (rented)")}
              </span>
              {(isRunning || isProvisioning) && priceLabel && (
                <span className="text-[10px] opacity-70">{priceLabel}</span>
              )}
              {isRentedIdle && storageLabel && (
                <span className="text-[10px] opacity-70">
                  Storage: {storageLabel}
                </span>
              )}
            </div>

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
            )}

            {/* Dismiss button */}
            <button
              onClick={() => setDismissed(true)}
              className={cn(
                "h-4 w-4 rounded-full inline-flex items-center justify-center shrink-0",
                "opacity-60 hover:opacity-100 transition-opacity",
              )}
              aria-label="Dismiss GPU status"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
