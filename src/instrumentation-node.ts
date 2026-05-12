/**
 * Node-only side of the instrumentation hook. Runs at server start in the
 * Node.js runtime ONLY — never compiled for Edge runtime because instrumentation.ts
 * only imports this file inside a `NEXT_RUNTIME === "nodejs"` guard.
 *
 * Side-effect import: kicks off env validation + background matrix reconcile.
 */
import { validateEnv } from "@/lib/env";
import { triggerStartupReconcileGroupMatrixRooms } from "@/lib/matrix-startup";

validateEnv();

try {
  triggerStartupReconcileGroupMatrixRooms();
} catch (err) {
  console.error("[instrumentation] failed to schedule matrix reconcile:", err);
}
