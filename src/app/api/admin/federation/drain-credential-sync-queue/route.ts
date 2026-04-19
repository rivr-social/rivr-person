/**
 * Admin-only drain endpoint for the credential sync queue (#15).
 *
 * Purpose:
 * - Give operators a manual trigger that re-attempts every pending
 *   credential.updated event whose last attempt is older than the
 *   retry floor. Safe to call from a cron, a deploy hook, or an
 *   operator-on-call during an incident.
 * - Wraps `drainCredentialSyncQueue()` so the same logic is available
 *   to server actions and scripts.
 *
 * Auth model:
 * - Primary: authenticated session whose agent carries
 *   `metadata.siteRole === "admin"` (matches the convention used by
 *   `src/app/actions/admin.ts`).
 * - Secondary: shared-secret Bearer token via
 *   `CREDENTIAL_SYNC_DRAIN_SECRET`. Lets cron / deploy hooks call
 *   without a user session. If the env var is unset, bearer auth is
 *   disabled.
 *
 * Both paths are mutually exclusive; a request succeeds when either
 * passes. The function returns 401 only when both paths fail.
 *
 * Error handling:
 * - Malformed JSON bodies → 400.
 * - Unauthenticated / non-admin → 401.
 * - Drain execution errors → 500 with the error message surfaced so
 *   operators can diagnose from curl output.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  drainCredentialSyncQueue,
  CREDENTIAL_SYNC_DRAIN_BATCH_SIZE,
} from "@/lib/federation/credential-sync";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";

// ---------------------------------------------------------------------------
// Env + constants
// ---------------------------------------------------------------------------

/** Environment variable carrying the shared secret for unattended callers. */
const DRAIN_SECRET_ENV = "CREDENTIAL_SYNC_DRAIN_SECRET";

/** Hard cap on a single drain invocation to keep worst-case latency bounded. */
const MAX_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Check for a Bearer token matching the configured drain secret.
 * Returns `true` only when the env var is set AND the header matches.
 */
function hasValidBearer(request: NextRequest): boolean {
  const configured = process.env[DRAIN_SECRET_ENV]?.trim();
  if (!configured) return false;

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;

  const provided = header.slice("Bearer ".length).trim();
  return provided === configured;
}

/**
 * Check whether the session user is an admin.
 * Matches the convention used by `src/app/actions/admin.ts`:
 * `metadata.siteRole === "admin"` on the authenticated agent row.
 */
async function sessionIsAdmin(): Promise<boolean> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return false;

  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);
  if (!agent) return false;

  const metadata =
    agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  return metadata.siteRole === "admin";
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface DrainBody {
  /** Override `CREDENTIAL_SYNC_DRAIN_BATCH_SIZE` for a single drain. Capped at `MAX_BATCH_SIZE`. */
  batchSize?: number;
}

/**
 * POST /api/admin/federation/drain-credential-sync-queue
 *
 * Auth: admin session OR Bearer `$CREDENTIAL_SYNC_DRAIN_SECRET`.
 * Body: optional `{ batchSize?: number }`.
 * Returns: `{ success: true, attempted, synced, stillPending, deadLettered }`.
 */
export async function POST(request: NextRequest) {
  if (!hasValidBearer(request) && !(await sessionIsAdmin())) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  let body: DrainBody = {};
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 0) {
    try {
      body = (await request.json()) as DrainBody;
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: STATUS_BAD_REQUEST }
      );
    }
  }

  const requestedBatch = body.batchSize ?? CREDENTIAL_SYNC_DRAIN_BATCH_SIZE;
  if (!Number.isInteger(requestedBatch) || requestedBatch < 1) {
    return NextResponse.json(
      { success: false, error: "batchSize must be a positive integer" },
      { status: STATUS_BAD_REQUEST }
    );
  }
  const batchSize = Math.min(requestedBatch, MAX_BATCH_SIZE);

  try {
    const result = await drainCredentialSyncQueue({ batchSize });
    return NextResponse.json(
      { success: true, ...result },
      { status: STATUS_OK }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Drain failed";
    console.error("[credential-sync-drain] unexpected error:", err);
    return NextResponse.json(
      { success: false, error: message },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
