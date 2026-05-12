/**
 * Startup hook for matrix room reconciliation. Lives in its own module so
 * the canonical `matrix-groups.ts` can stay marked `"use server"` (which
 * forbids non-async function exports).
 */
import { reconcileGroupMatrixRooms, reconcileDmRooms } from "./matrix-groups";

let startupReconcileTriggered = false;

/**
 * Non-blocking reconcile fired once per cold start. Idempotent: subsequent
 * calls within the same process are no-ops.
 */
export function triggerStartupReconcileGroupMatrixRooms(): void {
  if (startupReconcileTriggered) return;
  startupReconcileTriggered = true;

  setImmediate(() => {
    void (async () => {
      try {
        const groups = await reconcileGroupMatrixRooms();
        if (groups.softDeleted > 0 || groups.errors.length > 0) {
          console.log(
            `[matrix] startup reconcile (groups): ${groups.total} rows, ${groups.alive} alive, ${groups.softDeleted} soft-deleted, ${groups.errors.length} errors`,
          );
        }
      } catch (err) {
        console.error("[matrix] startup reconcileGroupMatrixRooms crashed:", err);
      }

      try {
        const dms = await reconcileDmRooms();
        if (dms.softDeleted > 0 || dms.errors.length > 0) {
          console.log(
            `[matrix] startup reconcile (dms): ${dms.total} rows, ${dms.alive} alive, ${dms.softDeleted} soft-deleted, ${dms.errors.length} errors`,
          );
        }
      } catch (err) {
        console.error("[matrix] startup reconcileDmRooms crashed:", err);
      }
    })();
  });
}
