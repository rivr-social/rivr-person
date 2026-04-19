/**
 * Credential sync helper — home → global push of `credential.updated` events.
 *
 * Purpose:
 * - After the home instance writes a new `passwordHash` / bumped
 *   `credentialVersion` locally, push the signed event to global so that
 *   global's credentialVerifier stays current.
 * - The push is best-effort: on any failure (network error, 5xx, 404
 *   while the receiver endpoint is still pending on global — see
 *   rivr-app #7 / #88) the event is queued in `credential_sync_queue`
 *   for retry. The caller's password reset must not fail when the push
 *   fails — drift is acceptable because the queue reconciles.
 * - Retries are drained by `drainCredentialSyncQueue()` (exposed via
 *   `/api/admin/federation/drain-credential-sync-queue` and reusable
 *   from cron).
 *
 * Key exports:
 * - {@link syncCredentialToGlobal} — primary sync entry point.
 * - {@link buildCredentialUpdatedEvent} — canonical event shape.
 * - {@link drainCredentialSyncQueue} — retry worker.
 * - {@link getCredentialSyncImportUrl} — URL resolution helper.
 *
 * Dependencies:
 * - `@/db` + `credential_sync_queue` table (migration 0038).
 * - `@/lib/federation-crypto` for Ed25519 signing.
 * - `@/lib/federation` for hosted local node (signing key) lookup.
 * - `@/lib/federation/global-url` for global base URL discovery.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#15.
 * - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — "Federation Auth /
 *   SSO Plan" step 3 and "Cameron's Clarifications" #1 + #4.
 */

import crypto from "crypto";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { credentialSyncQueue } from "@/db/schema";
import type { NewCredentialSyncQueueRecord } from "@/db/schema";
import { signPayload } from "@/lib/federation-crypto";
import { ensureLocalNode } from "@/lib/federation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event type discriminator stored in both the signed payload and the queue row. */
export const CREDENTIAL_UPDATED_EVENT_TYPE = "credential.updated";

/** Path on global that accepts federation event imports. */
export const GLOBAL_IMPORT_PATH = "/api/federation/events/import";

/** Hard upper bound on delivery attempts before a queue row dead-letters to `failed`. */
export const MAX_CREDENTIAL_SYNC_ATTEMPTS = 5;

/** Minimum time between retry attempts for a single pending row. */
export const CREDENTIAL_SYNC_RETRY_FLOOR_MS = 60_000;

/** Per-request timeout for the POST to global. Kept short so the user's password reset never waits on a sick peer. */
export const CREDENTIAL_SYNC_FETCH_TIMEOUT_MS = 5_000;

/** Retry-worker batch size. Keeps a single drain cycle bounded. */
export const CREDENTIAL_SYNC_DRAIN_BATCH_SIZE = 50;

/**
 * HTTP status codes that, when returned by global, should NOT be retried.
 *
 * 401/403 mean global rejected our signature; retrying with the same
 * payload will keep failing. Treat them as dead-letter immediately so an
 * operator can rotate keys or re-register the home node.
 * 409 means global already has this version or a newer one — treat as
 * effectively synced so we do not spin on stale rotations.
 */
const NON_RETRYABLE_STATUSES = new Set<number>([401, 403, 409]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Canonical shape of a signed `credential.updated` event.
 *
 * Fields are ordered to make RFC 8785 canonicalization reproducible; the
 * signature covers this entire object (without itself, which is added
 * after signing).
 */
export interface CredentialUpdatedEvent {
  /** Always `credential.updated`. Included so global can route by `eventType`. */
  type: typeof CREDENTIAL_UPDATED_EVENT_TYPE;
  /** Home instance's agent id whose credential changed. */
  agentId: string;
  /** Monotonic counter from `agents.credentialVersion`. Global enforces strict increase. */
  credentialVersion: number;
  /** ISO-8601 timestamp of the rotation on the home instance. */
  updatedAt: string;
  /** Replay-protection nonce. Global rejects duplicates. */
  nonce: string;
  /** Home node slug so global can look up the verifying public key. */
  signingNodeSlug: string;
}

/** Signed envelope pushed to global (event + base64 signature). */
export interface SignedCredentialEvent {
  event: CredentialUpdatedEvent;
  signature: string;
}

/** Return value from {@link syncCredentialToGlobal}. */
export interface CredentialSyncResult {
  /** True if global acknowledged the event; false if it was queued for retry. */
  synced: boolean;
  /** Human-readable detail when `synced` is false (HTTP status, network error message). */
  reason?: string;
  /** Queue row id when queued for retry. */
  queueId?: string;
}

/** Return value from {@link drainCredentialSyncQueue}. */
export interface CredentialSyncDrainResult {
  attempted: number;
  synced: number;
  stillPending: number;
  deadLettered: number;
}

// ---------------------------------------------------------------------------
// URL + signing helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the global instance's import URL.
 *
 * Resolution order (first non-empty wins):
 * 1. `GLOBAL_BASE_URL`                (explicit server-side override)
 * 2. `NEXT_PUBLIC_GLOBAL_URL`         (shared with client-safe helper)
 * 3. `REGISTRY_URL` / `NEXT_PUBLIC_REGISTRY_URL` (strip `/api/federation/registry`)
 *
 * @throws {Error} when no env override is set. The caller in the password
 *         reset path catches this and queues the event instead of hard-failing.
 */
export function getCredentialSyncImportUrl(): string {
  const base = resolveGlobalBaseUrl();
  if (!base) {
    throw new Error(
      "Cannot resolve global base URL: set GLOBAL_BASE_URL, NEXT_PUBLIC_GLOBAL_URL, or REGISTRY_URL"
    );
  }
  return `${base}${GLOBAL_IMPORT_PATH}`;
}

/**
 * Server-side mirror of `getGlobalBaseUrl()` that prefers the private
 * `GLOBAL_BASE_URL` env so deployments can point home → global over a
 * private network / internal DNS name distinct from the public-facing
 * `NEXT_PUBLIC_GLOBAL_URL`.
 */
function resolveGlobalBaseUrl(): string {
  const privateOverride = process.env.GLOBAL_BASE_URL?.trim();
  if (privateOverride) return stripTrailingSlashes(privateOverride);

  const publicOverride = process.env.NEXT_PUBLIC_GLOBAL_URL?.trim();
  if (publicOverride) return stripTrailingSlashes(publicOverride);

  const registryUrl =
    process.env.REGISTRY_URL?.trim() ||
    process.env.NEXT_PUBLIC_REGISTRY_URL?.trim();
  if (registryUrl) {
    const marker = "/api/federation/registry";
    const idx = registryUrl.indexOf(marker);
    if (idx !== -1) return stripTrailingSlashes(registryUrl.slice(0, idx));
    try {
      return new URL(registryUrl).origin;
    } catch {
      // fall through
    }
  }

  return "";
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Build the canonical, not-yet-signed `credential.updated` event.
 *
 * Separated from signing so callers (and tests) can inspect the exact
 * payload before it is hashed.
 */
export function buildCredentialUpdatedEvent(params: {
  agentId: string;
  credentialVersion: number;
  signingNodeSlug: string;
  updatedAt?: Date;
  nonce?: string;
}): CredentialUpdatedEvent {
  return {
    type: CREDENTIAL_UPDATED_EVENT_TYPE,
    agentId: params.agentId,
    credentialVersion: params.credentialVersion,
    updatedAt: (params.updatedAt ?? new Date()).toISOString(),
    nonce: params.nonce ?? crypto.randomUUID(),
    signingNodeSlug: params.signingNodeSlug,
  };
}

/**
 * Sign a `credential.updated` event using the hosted local node's private key.
 *
 * Uses `ensureLocalNode()` so that even legacy deployments without a
 * node-level keypair on disk get one backfilled on first call.
 */
export async function signCredentialUpdatedEvent(
  event: CredentialUpdatedEvent
): Promise<SignedCredentialEvent> {
  const localNode = await ensureLocalNode();
  if (!localNode.privateKey) {
    throw new Error(
      "Local node has no private key; cannot sign credential.updated event"
    );
  }
  // signPayload takes Record<string, unknown>; CredentialUpdatedEvent is
  // structurally compatible because every field is a primitive.
  const signature = signPayload(
    event as unknown as Record<string, unknown>,
    localNode.privateKey
  );
  return { event, signature };
}

// ---------------------------------------------------------------------------
// Core: push-or-queue
// ---------------------------------------------------------------------------

/**
 * Deliver a signed `credential.updated` event to global, or queue it for retry.
 *
 * Contract:
 * - Never throws for network / HTTP failures — those are caught and queued.
 * - Only throws for unrecoverable programmer errors (missing dependencies
 *   the caller has to fix; e.g. no signing key available).
 * - On 2xx: returns `{ synced: true }` and clears any prior pending rows
 *   for this agent whose `credentialVersion` is ≤ the one we just synced.
 * - On retryable failure: writes a new `credential_sync_queue` row with
 *   `status = pending`, `attempts = 1`, and returns `{ synced: false, queueId }`.
 * - On non-retryable failure (401/403/409): writes a row with
 *   `status = failed` immediately; returns `{ synced: false }`.
 *
 * @param agentId          Agent whose credential changed.
 * @param credentialVersion The post-increment version persisted on agents.
 * @param signedEvent      Pre-built + signed envelope. Caller owns the signature so tests can inject deterministic payloads.
 */
export async function syncCredentialToGlobal(
  agentId: string,
  credentialVersion: number,
  signedEvent: SignedCredentialEvent
): Promise<CredentialSyncResult> {
  let importUrl: string;
  try {
    importUrl = getCredentialSyncImportUrl();
  } catch (err) {
    // Missing GLOBAL_BASE_URL is a config drift, not a user-facing failure.
    // Queue the event and let the operator point the worker at global
    // once the env is fixed.
    const reason = err instanceof Error ? err.message : "global base URL not configured";
    const queueId = await enqueueForRetry({
      agentId,
      credentialVersion,
      signedEvent,
      lastError: reason,
      terminal: false,
    });
    console.warn(
      `[credential-sync] skipping live POST (${reason}); queued ${queueId} for retry`
    );
    return { synced: false, reason, queueId };
  }

  const attemptOutcome = await postCredentialEvent(importUrl, signedEvent);

  if (attemptOutcome.ok) {
    await clearSyncedAndOlderRows(agentId, credentialVersion);
    return { synced: true };
  }

  const terminal =
    attemptOutcome.status != null &&
    NON_RETRYABLE_STATUSES.has(attemptOutcome.status);

  const queueId = await enqueueForRetry({
    agentId,
    credentialVersion,
    signedEvent,
    lastError: attemptOutcome.reason,
    terminal,
  });

  console.warn(
    `[credential-sync] POST ${importUrl} failed (${attemptOutcome.reason}); queued ${queueId} (terminal=${terminal})`
  );

  return { synced: false, reason: attemptOutcome.reason, queueId };
}

interface PostAttemptOutcome {
  ok: boolean;
  status?: number;
  reason: string;
}

async function postCredentialEvent(
  url: string,
  signedEvent: SignedCredentialEvent
): Promise<PostAttemptOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rivr-Federation-Event": CREDENTIAL_UPDATED_EVENT_TYPE,
      },
      body: JSON.stringify({
        fromPeerSlug: signedEvent.event.signingNodeSlug,
        events: [
          {
            entityType: "credential",
            eventType: CREDENTIAL_UPDATED_EVENT_TYPE,
            visibility: "private",
            payload: signedEvent.event,
            signature: signedEvent.signature,
            nonce: signedEvent.event.nonce,
            createdAt: signedEvent.event.updatedAt,
          },
        ],
      }),
      signal: AbortSignal.timeout(CREDENTIAL_SYNC_FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, status: response.status, reason: "ok" };
    }

    // Non-2xx: classify retryable vs terminal for the caller.
    const bodySnippet = await safeSnippet(response);
    return {
      ok: false,
      status: response.status,
      reason: `HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`,
    };
  } catch (err) {
    const reason =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : "unknown network error";
    return { ok: false, reason };
  }
}

async function safeSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

async function enqueueForRetry(params: {
  agentId: string;
  credentialVersion: number;
  signedEvent: SignedCredentialEvent;
  lastError: string;
  terminal: boolean;
}): Promise<string> {
  const row: NewCredentialSyncQueueRecord = {
    agentId: params.agentId,
    eventPayload: {
      event: params.signedEvent.event,
      signature: params.signedEvent.signature,
      credentialVersion: params.credentialVersion,
    },
    attempts: 1,
    lastAttemptAt: new Date(),
    lastError: params.lastError,
    status: params.terminal ? "failed" : "pending",
  };
  const [inserted] = await db
    .insert(credentialSyncQueue)
    .values(row)
    .returning({ id: credentialSyncQueue.id });
  return inserted.id;
}

/**
 * After a successful sync at credentialVersion N, any still-pending rows
 * for this agent at version ≤ N are now stale — global already has a
 * newer verifier. Mark them `synced` so the drain worker does not waste
 * attempts on them.
 */
async function clearSyncedAndOlderRows(
  agentId: string,
  credentialVersion: number
): Promise<void> {
  await db
    .update(credentialSyncQueue)
    .set({ status: "synced", updatedAt: new Date() })
    .where(
      and(
        eq(credentialSyncQueue.agentId, agentId),
        eq(credentialSyncQueue.status, "pending"),
        // `eventPayload.credentialVersion` is stored as jsonb; cast to
        // int for the comparison. Drizzle's `sql` template is the
        // least-surprising way to express this without bespoke ops.
        sql`(${credentialSyncQueue.eventPayload} ->> 'credentialVersion')::int <= ${credentialVersion}`
      )
    );
}

// ---------------------------------------------------------------------------
// Retry worker
// ---------------------------------------------------------------------------

/**
 * Drain pending rows whose last attempt is older than the retry floor.
 *
 * Each row is re-POSTed using the exact signed event it was queued with.
 * On success the row is marked `synced`; on a retryable failure
 * `attempts` is incremented and (if it reaches `MAX_CREDENTIAL_SYNC_ATTEMPTS`)
 * the row dead-letters to `failed`. On a terminal HTTP status the row
 * dead-letters immediately regardless of attempt count.
 *
 * This function is safe to call from:
 * - the admin drain route (`/api/admin/federation/drain-credential-sync-queue`),
 * - a cron handler,
 * - a one-off operator script.
 */
export async function drainCredentialSyncQueue(
  options: { batchSize?: number; now?: Date } = {}
): Promise<CredentialSyncDrainResult> {
  const batchSize = options.batchSize ?? CREDENTIAL_SYNC_DRAIN_BATCH_SIZE;
  const now = options.now ?? new Date();
  const floor = new Date(now.getTime() - CREDENTIAL_SYNC_RETRY_FLOOR_MS);

  // Candidate rows: pending AND (never attempted OR attempted before the
  // retry floor). Ordered oldest-first so we do not starve long-waiting
  // rows behind recent churn.
  const rows = await db
    .select()
    .from(credentialSyncQueue)
    .where(
      and(
        eq(credentialSyncQueue.status, "pending"),
        or(
          isNull(credentialSyncQueue.lastAttemptAt),
          lte(credentialSyncQueue.lastAttemptAt, floor)
        )
      )
    )
    .orderBy(credentialSyncQueue.createdAt)
    .limit(batchSize);

  const result: CredentialSyncDrainResult = {
    attempted: rows.length,
    synced: 0,
    stillPending: 0,
    deadLettered: 0,
  };

  if (rows.length === 0) return result;

  let importUrl: string;
  try {
    importUrl = getCredentialSyncImportUrl();
  } catch (err) {
    // Mark every row's lastError so the operator sees why no progress
    // was made; leave them pending so a fixed env resumes delivery.
    const reason = err instanceof Error ? err.message : "global base URL not configured";
    await db
      .update(credentialSyncQueue)
      .set({ lastAttemptAt: now, lastError: reason, updatedAt: now })
      .where(
        inArray(
          credentialSyncQueue.id,
          rows.map((r) => r.id)
        )
      );
    result.stillPending = rows.length;
    return result;
  }

  for (const row of rows) {
    const signedEvent = parseQueuedSignedEvent(row.eventPayload);
    if (!signedEvent) {
      await markDeadLetter(row.id, "malformed queued payload", now);
      result.deadLettered += 1;
      continue;
    }

    const outcome = await postCredentialEvent(importUrl, signedEvent);
    const nextAttempts = (row.attempts ?? 0) + 1;

    if (outcome.ok) {
      await db
        .update(credentialSyncQueue)
        .set({
          status: "synced",
          attempts: nextAttempts,
          lastAttemptAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(credentialSyncQueue.id, row.id));
      result.synced += 1;
      continue;
    }

    const terminal =
      outcome.status != null && NON_RETRYABLE_STATUSES.has(outcome.status);

    if (terminal || nextAttempts >= MAX_CREDENTIAL_SYNC_ATTEMPTS) {
      await markDeadLetter(row.id, outcome.reason, now, nextAttempts);
      result.deadLettered += 1;
    } else {
      await db
        .update(credentialSyncQueue)
        .set({
          attempts: nextAttempts,
          lastAttemptAt: now,
          lastError: outcome.reason,
          updatedAt: now,
        })
        .where(eq(credentialSyncQueue.id, row.id));
      result.stillPending += 1;
    }
  }

  return result;
}

async function markDeadLetter(
  id: string,
  reason: string,
  now: Date,
  attempts?: number
): Promise<void> {
  await db
    .update(credentialSyncQueue)
    .set({
      status: "failed",
      attempts: attempts,
      lastAttemptAt: now,
      lastError: reason,
      updatedAt: now,
    })
    .where(eq(credentialSyncQueue.id, id));
}

function parseQueuedSignedEvent(
  payload: Record<string, unknown> | null
): SignedCredentialEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload.event as unknown;
  const signature = payload.signature;
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof signature !== "string"
  ) {
    return null;
  }
  const e = event as Record<string, unknown>;
  if (
    e.type !== CREDENTIAL_UPDATED_EVENT_TYPE ||
    typeof e.agentId !== "string" ||
    typeof e.credentialVersion !== "number" ||
    typeof e.updatedAt !== "string" ||
    typeof e.nonce !== "string" ||
    typeof e.signingNodeSlug !== "string"
  ) {
    return null;
  }
  return {
    event: {
      type: CREDENTIAL_UPDATED_EVENT_TYPE,
      agentId: e.agentId,
      credentialVersion: e.credentialVersion,
      updatedAt: e.updatedAt,
      nonce: e.nonce,
      signingNodeSlug: e.signingNodeSlug,
    },
    signature,
  };
}

// ---------------------------------------------------------------------------
// Debug / introspection
// ---------------------------------------------------------------------------

/**
 * List the most-recent queue rows for a specific agent. Useful from the
 * admin drain route to show operators what is actually waiting.
 */
export async function listRecentSyncRows(agentId: string, limit = 25) {
  return db
    .select()
    .from(credentialSyncQueue)
    .where(eq(credentialSyncQueue.agentId, agentId))
    .orderBy(desc(credentialSyncQueue.createdAt))
    .limit(limit);
}

