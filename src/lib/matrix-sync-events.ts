/**
 * Browser-side event bus for Matrix sync-repair status.
 *
 * Purpose:
 * - Surface Matrix sync-time repair failures (notably `setAccountData(m.direct)`
 *   failures during `startSync()`) so UI layers can show toasts or banners.
 * - Provide a typed, dependency-free pub/sub that works in client components
 *   without dragging in node `events` or a global emitter library.
 *
 * Event types:
 * - `m_direct_repair_failed`  — every failed attempt during a retry cycle.
 * - `m_direct_repair_succeeded` — emitted once when the repair finally lands.
 * - `m_direct_repair_exhausted` — emitted when all retries fail; the UI should
 *   warn the user that DM tracking may be stale until they refresh.
 *
 * Dependencies: none — intentionally pure so this can be imported from
 *   client components without pulling SSR-only modules.
 */

/** Event names emitted by the sync-repair bus. */
export const MATRIX_SYNC_REPAIR_FAILED = "m_direct_repair_failed" as const;
export const MATRIX_SYNC_REPAIR_SUCCEEDED = "m_direct_repair_succeeded" as const;
export const MATRIX_SYNC_REPAIR_EXHAUSTED = "m_direct_repair_exhausted" as const;

/** Discriminated union of sync-repair events. */
export type MatrixSyncRepairEvent =
  | {
      type: typeof MATRIX_SYNC_REPAIR_FAILED;
      /** 1-indexed attempt number that failed. */
      attempt: number;
      /** Total attempts that will be made before giving up. */
      maxAttempts: number;
      /** Delay (ms) before the next retry, or null on final attempt. */
      nextRetryMs: number | null;
      /** Human-readable error message captured from the underlying failure. */
      message: string;
    }
  | {
      type: typeof MATRIX_SYNC_REPAIR_SUCCEEDED;
      /** 1-indexed attempt that succeeded. */
      attempt: number;
    }
  | {
      type: typeof MATRIX_SYNC_REPAIR_EXHAUSTED;
      /** Total attempts made before giving up. */
      attempts: number;
      /** Human-readable error message captured from the final failure. */
      message: string;
    };

/** Listener signature for sync-repair subscribers. */
export type MatrixSyncRepairListener = (event: MatrixSyncRepairEvent) => void;

const listeners = new Set<MatrixSyncRepairListener>();

/**
 * Subscribe to Matrix sync-repair events.
 *
 * @param listener Callback invoked synchronously for every emitted event.
 * @returns An unsubscribe function. Always call it during cleanup to avoid leaks.
 * @example
 * ```ts
 * const off = onMatrixSyncRepair((evt) => { if (evt.type === MATRIX_SYNC_REPAIR_EXHAUSTED) toast.error(evt.message); });
 * // ...later
 * off();
 * ```
 */
export function onMatrixSyncRepair(listener: MatrixSyncRepairListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Emit a sync-repair event to all subscribers. Internal use by matrix-client.
 *
 * @param event The event payload to broadcast.
 */
export function emitMatrixSyncRepair(event: MatrixSyncRepairEvent): void {
  // Iterate over a snapshot so listeners that unsubscribe during dispatch
  // don't disturb the iteration order.
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (err) {
      // A faulty listener must not break the dispatch loop or downstream UI.
      console.error("[matrix-sync-events] Listener threw:", err);
    }
  }
}

/**
 * Remove all listeners. Test-only helper; production code should always
 * use the unsubscribe function returned by `onMatrixSyncRepair`.
 */
export function clearMatrixSyncRepairListenersForTesting(): void {
  listeners.clear();
}
