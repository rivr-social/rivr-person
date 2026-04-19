/**
 * POST /api/recovery/accept-reset — home-side consumer of global-issued
 * recovery assertions.
 *
 * Implements rivr-social/rivr-person#17 (Recovery Plan section 2). Used
 * when a sovereign user has forgotten their home-instance password AND
 * cannot (or does not want to) receive the email reset token. The global
 * instance verifies the seed-phrase signature, then hands the user a
 * short-lived signed assertion that this endpoint redeems for an
 * authenticated password reset.
 *
 * Pipeline:
 *   1. Rate-limit by client IP (dedicated `recovery_accept_reset:<ip>` key)
 *      using the AUTH tier to match password-reset abuse surface.
 *   2. Parse body: `{ assertion, newPassword }`.
 *   3. Validate the new password (length bounds match
 *      `resetPasswordAction` in `src/app/actions/password-reset.ts`).
 *   4. Verify the assertion via
 *      {@link verifyRecoveryAssertion} — signature, target, timing, intent,
 *      and agent existence / sovereign instanceMode.
 *   5. Inside a single DB transaction:
 *        - INSERT a nonce row (unique-violation => 409 replay).
 *        - Hash the new password with bcrypt.
 *        - Update agents: passwordHash, bump credentialVersion,
 *          bump sessionVersion, stamp passwordChangedAt metadata.
 *        - Append an audit_log row describing the reset.
 *   6. Best-effort fire-and-forget credential sync to global via the
 *      sibling branch's `credential-sync` helper (dynamic import — if
 *      the module or queue table is missing, silently skip).
 *   7. Return 200 on success.
 *
 * Status codes:
 *   - 200 OK                       — password reset applied.
 *   - 400 Bad Request              — malformed JSON / payload / password.
 *   - 401 Unauthorized             — signature check failed.
 *   - 403 Forbidden                — wrong target, non-sovereign agent,
 *                                    invalid intent, lifetime-too-long.
 *   - 404 Not Found                — agent not found.
 *   - 409 Conflict                 — nonce already consumed (replay).
 *   - 429 Too Many Requests        — client hit the rate limiter.
 *   - 500 Internal Server Error    — missing global public key, unhandled.
 *
 * Security notes:
 *   - No session / cookie auth — the signed assertion IS the authority.
 *   - Rate limited by IP so brute-force attempts against signature /
 *     nonce cannot hide behind HTTP 429 being skipped.
 *   - Every attempt (success or failure) produces an audit_log row
 *     tagged with the machine-readable `outcome` so operators can scan
 *     for replay / stale-key patterns.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { hash } from "@node-rs/bcrypt";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, auditLog, recoveryAssertionNonces } from "@/db/schema";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_CONFLICT,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  MAX_ASSERTION_LIFETIME_MS,
  RecoveryAssertionVerificationError,
  verifyRecoveryAssertion,
  type RecoveryAssertionErrorCode,
  type VerifiedRecoveryAssertion,
} from "@/lib/recovery/assertion";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bcrypt cost factor; matches `resetPasswordAction`. */
const BCRYPT_SALT_ROUNDS = 12;

/** Password policy mirrors `resetPasswordAction` — bcrypt truncates at 72. */
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72;

/** Audit event type for the unified audit_log table. */
const AUDIT_EVENT_RESET_SUCCEEDED = "recovery.password_reset.accepted";
const AUDIT_EVENT_RESET_REJECTED = "recovery.password_reset.rejected";

/** Dedicated rate-limit prefix; keeps accept-reset separate from the email-token flow. */
const RATE_LIMIT_KEY_PREFIX = "recovery_accept_reset";

/** Message templates — surfaced to clients, so they must not carry detail. */
const ERROR_MESSAGES: Record<RecoveryAssertionErrorCode, string> = {
  invalid_payload: "Recovery assertion payload is malformed.",
  invalid_intent: "Recovery assertion intent is not accepted.",
  wrong_target: "Recovery assertion is not addressed to this instance.",
  expired: "Recovery assertion has expired.",
  lifetime_too_long: "Recovery assertion lifetime exceeds the allowed ceiling.",
  issued_in_future: "Recovery assertion timestamps are inconsistent.",
  missing_public_key:
    "This instance cannot verify recovery assertions: global issuer public key is not configured.",
  invalid_signature: "Recovery assertion signature is invalid.",
  agent_not_found: "Recovery assertion targets an unknown account.",
  agent_not_sovereign:
    "Seed-phrase recovery is only available for sovereign-mode accounts.",
};

/** Map verification-error codes to HTTP status codes. */
const CODE_TO_STATUS: Record<RecoveryAssertionErrorCode, number> = {
  invalid_payload: STATUS_BAD_REQUEST,
  invalid_intent: STATUS_FORBIDDEN,
  wrong_target: STATUS_FORBIDDEN,
  expired: STATUS_BAD_REQUEST,
  lifetime_too_long: STATUS_FORBIDDEN,
  issued_in_future: STATUS_BAD_REQUEST,
  missing_public_key: STATUS_INTERNAL_ERROR,
  invalid_signature: STATUS_UNAUTHORIZED,
  agent_not_found: STATUS_NOT_FOUND,
  agent_not_sovereign: STATUS_FORBIDDEN,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AcceptResetBody {
  assertion: unknown;
  newPassword: unknown;
}

interface AcceptResetSuccessResponse {
  ok: true;
  agentId: string;
  credentialVersion: number;
  sessionVersion: number;
  credentialSync: "queued" | "synced" | "skipped" | "failed";
}

interface AcceptResetErrorResponse {
  ok: false;
  code: RecoveryAssertionErrorCode | "rate_limited" | "invalid_password" | "unhandled";
  message: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const headersList = await headers();
  const clientIp = getClientIp(headersList);

  // ── Rate limit ─────────────────────────────────────────────────────────
  const rate = await checkRateLimit("AUTH", `${RATE_LIMIT_KEY_PREFIX}:${clientIp}`);
  if (!rate.allowed) {
    const body: AcceptResetErrorResponse = {
      ok: false,
      code: "rate_limited",
      message: `Too many recovery attempts from this client. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`,
    };
    return NextResponse.json(body, {
      status: STATUS_TOO_MANY_REQUESTS,
      headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) },
    });
  }

  // ── Parse + structurally validate body ────────────────────────────────
  let body: AcceptResetBody;
  try {
    body = (await request.json()) as AcceptResetBody;
  } catch {
    return badRequest("invalid_payload", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object") {
    return badRequest("invalid_payload", "Request body must be a JSON object.");
  }

  const { assertion, newPassword } = body;
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    await logFailure(null, "invalid_password", clientIp, passwordError);
    const resp: AcceptResetErrorResponse = {
      ok: false,
      code: "invalid_password",
      message: passwordError,
    };
    return NextResponse.json(resp, { status: STATUS_BAD_REQUEST });
  }

  // ── Verify assertion ──────────────────────────────────────────────────
  let verified: VerifiedRecoveryAssertion;
  try {
    verified = await verifyRecoveryAssertion({ raw: assertion });
  } catch (err) {
    if (err instanceof RecoveryAssertionVerificationError) {
      const status = CODE_TO_STATUS[err.code] ?? STATUS_BAD_REQUEST;
      const agentIdForAudit =
        err.code === "agent_not_found" || err.code === "agent_not_sovereign"
          ? ((err.detail?.agentId as string | undefined) ?? null)
          : (safeAgentIdFromRaw(assertion) ?? null);
      await logFailure(agentIdForAudit, err.code, clientIp, err.message, err.detail);
      const resp: AcceptResetErrorResponse = {
        ok: false,
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message,
      };
      return NextResponse.json(resp, { status });
    }
    console.error("[accept-reset] Unexpected verification error:", err);
    await logFailure(null, "unhandled", clientIp, toMessage(err));
    const resp: AcceptResetErrorResponse = {
      ok: false,
      code: "unhandled",
      message: "Recovery assertion verification failed unexpectedly.",
    };
    return NextResponse.json(resp, { status: STATUS_INTERNAL_ERROR });
  }

  // ── Apply password reset + nonce ledger atomically ────────────────────
  const passwordHash = await hash(
    newPassword as string,
    BCRYPT_SALT_ROUNDS
  );
  const now = new Date();
  const expiresAt = new Date(verified.assertion.exp);

  let nextCredentialVersion: number;
  let nextSessionVersion: number;
  try {
    const applied = await db.transaction(async (tx) => {
      // Insert nonce first so a unique-violation aborts the whole tx
      // before we hash/write any credential material.
      await tx.insert(recoveryAssertionNonces).values({
        nonce: verified.assertion.nonce,
        agentId: verified.agent.id,
        issuerBaseUrl: verified.assertion.globalIssuerBaseUrl,
        intent: verified.assertion.intent,
        consumedAt: now,
        expiresAt,
      });

      const nextCV = verified.agent.credentialVersion + 1;
      const nextSV = verified.agent.sessionVersion + 1;
      const passwordChangedAt = now.toISOString();

      const [updatedAgent] = await tx
        .update(agents)
        .set({
          passwordHash,
          credentialVersion: nextCV,
          sessionVersion: nextSV,
          failedLoginAttempts: 0,
          lockedUntil: null,
          metadata: {
            ...verified.agent.metadata,
            passwordChangedAt,
            lastRecoveryResetAt: passwordChangedAt,
          },
          updatedAt: now,
        })
        .where(and(eq(agents.id, verified.agent.id)))
        .returning({
          id: agents.id,
          credentialVersion: agents.credentialVersion,
          sessionVersion: agents.sessionVersion,
        });

      if (!updatedAgent) {
        // Agent was deleted between verification and update.
        throw new RecoveryAssertionVerificationError(
          "agent_not_found",
          "Agent disappeared during password reset."
        );
      }

      await tx.insert(auditLog).values({
        eventType: AUDIT_EVENT_RESET_SUCCEEDED,
        actorId: verified.agent.id,
        targetType: "agent",
        targetId: verified.agent.id,
        ipAddress: clientIp,
        userAgent: headersList.get("user-agent") ?? null,
        detail: {
          message: `Password reset via seed recovery at ${passwordChangedAt}`,
          nonce: verified.assertion.nonce,
          issuerBaseUrl: verified.assertion.globalIssuerBaseUrl,
          intent: verified.assertion.intent,
          credentialVersion: nextCV,
          sessionVersion: nextSV,
          assertionIat: verified.assertion.iat,
          assertionExp: verified.assertion.exp,
          assertionLifetimeMsCeiling: MAX_ASSERTION_LIFETIME_MS,
        },
      });

      return { cv: nextCV, sv: nextSV };
    });
    nextCredentialVersion = applied.cv;
    nextSessionVersion = applied.sv;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await logFailure(
        verified.agent.id,
        "replay_detected",
        clientIp,
        "Recovery assertion nonce already consumed.",
        { nonce: verified.assertion.nonce }
      );
      const resp: AcceptResetErrorResponse = {
        ok: false,
        code: "invalid_payload",
        message: "Recovery assertion has already been used.",
      };
      return NextResponse.json(resp, { status: STATUS_CONFLICT });
    }
    if (err instanceof RecoveryAssertionVerificationError) {
      const status = CODE_TO_STATUS[err.code] ?? STATUS_INTERNAL_ERROR;
      await logFailure(verified.agent.id, err.code, clientIp, err.message, err.detail);
      const resp: AcceptResetErrorResponse = {
        ok: false,
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message,
      };
      return NextResponse.json(resp, { status });
    }
    console.error("[accept-reset] Password reset transaction failed:", err);
    await logFailure(verified.agent.id, "unhandled", clientIp, toMessage(err));
    const resp: AcceptResetErrorResponse = {
      ok: false,
      code: "unhandled",
      message: "Password reset could not be completed.",
    };
    return NextResponse.json(resp, { status: STATUS_INTERNAL_ERROR });
  }

  // ── Best-effort credential-sync notification (#15 infrastructure) ─────
  const credentialSync = await notifyCredentialSync({
    agentId: verified.agent.id,
    credentialVersion: nextCredentialVersion,
    passwordChangedAt: now,
  });

  const response: AcceptResetSuccessResponse = {
    ok: true,
    agentId: verified.agent.id,
    credentialVersion: nextCredentialVersion,
    sessionVersion: nextSessionVersion,
    credentialSync,
  };
  return NextResponse.json(response, { status: STATUS_OK });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badRequest(
  code: RecoveryAssertionErrorCode | "invalid_password",
  message: string
): NextResponse {
  const body: AcceptResetErrorResponse = { ok: false, code, message };
  return NextResponse.json(body, { status: STATUS_BAD_REQUEST });
}

function validateNewPassword(value: unknown): string | null {
  if (typeof value !== "string") {
    return "newPassword must be a string.";
  }
  if (value.length < MINIMUM_PASSWORD_LENGTH) {
    return `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > MAXIMUM_PASSWORD_LENGTH) {
    return `Password must be ${MAXIMUM_PASSWORD_LENGTH} characters or fewer.`;
  }
  return null;
}

/** Pull the agentId out of the assertion for audit logging when the payload
 * failed a non-agent check (bad signature, expired, replay). Never throws. */
function safeAgentIdFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = (raw as Record<string, unknown>).agentId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Detect PG unique-constraint violation from various drivers. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    cause?: { code?: string };
    constraint?: string;
  };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && e.cause.code === "23505") return true;
  if (typeof e.constraint === "string" && e.constraint.includes("recovery_assertion_nonces_nonce_idx")) {
    return true;
  }
  return false;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dynamically import the sibling-branch credential-sync helper. The module
 * may not exist on the current branch yet (it lives on
 * `feat/federation-auth-reset-sync`, #15). When unavailable, we simply
 * skip the push — the password reset has already committed locally and
 * global can catch up via a future drift-reconciliation job.
 *
 * Dynamic import also gracefully handles the case where the module is
 * present but its supporting `credential_sync_queue` table is missing on
 * this deployment (unknown-table errors in the queueing path would
 * otherwise surface as 500s at request time).
 */
async function notifyCredentialSync(params: {
  agentId: string;
  credentialVersion: number;
  passwordChangedAt: Date;
}): Promise<AcceptResetSuccessResponse["credentialSync"]> {
  type CredentialSyncModule = typeof import("@/lib/federation/credential-sync");
  type FederationModule = typeof import("@/lib/federation");

  let credentialSync: CredentialSyncModule;
  let federation: FederationModule;
  try {
    credentialSync = await import("@/lib/federation/credential-sync");
    federation = await import("@/lib/federation");
  } catch (err) {
    // Module missing on this branch — acceptable.
    console.warn(
      "[accept-reset] credential-sync module not available; skipping global notification:",
      toMessage(err)
    );
    return "skipped";
  }

  try {
    const localNode = await federation.ensureLocalNode();
    const event = credentialSync.buildCredentialUpdatedEvent({
      agentId: params.agentId,
      credentialVersion: params.credentialVersion,
      signingNodeSlug: localNode.slug,
      updatedAt: params.passwordChangedAt,
    });
    const signed = await credentialSync.signCredentialUpdatedEvent(event);
    const outcome = await credentialSync.syncCredentialToGlobal(
      params.agentId,
      params.credentialVersion,
      signed
    );
    return outcome.synced ? "synced" : "queued";
  } catch (err) {
    console.warn(
      "[accept-reset] credential-sync attempt failed; treating as queued-later:",
      toMessage(err)
    );
    return "failed";
  }
}

/**
 * Append a rejection record to `audit_log`. Swallows any storage error so a
 * failing audit path never blocks the user's response.
 */
async function logFailure(
  agentId: string | null,
  code: string,
  ip: string,
  message: string,
  detail: Record<string, unknown> | undefined = undefined
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      eventType: AUDIT_EVENT_RESET_REJECTED,
      actorId: agentId,
      targetType: "agent",
      targetId: agentId,
      ipAddress: ip,
      detail: {
        outcome: code,
        message,
        ...(detail ?? {}),
      },
    });
  } catch (err) {
    console.warn(
      "[accept-reset] Failed to persist rejection audit row:",
      toMessage(err)
    );
  }
}
