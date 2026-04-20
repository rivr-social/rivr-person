/**
 * Accept-side credential temp-write HTTP surface.
 *
 * Purpose:
 * - Home endpoint that accepts a global-signed
 *   `credential.tempwrite.from-global` event and applies the new
 *   credential verifier to this instance's `agents` row. This is the
 *   home-side counterpart of the outgoing sync that landed in #15.
 *
 * Key exports:
 * - `POST`: verifies the signed event, applies it transactionally,
 *   records an audit row, and returns a structured JSON body.
 *
 * Dependencies:
 * - `@/lib/federation/accept-tempwrite` for validation + apply +
 *   audit-writing helpers.
 * - `@/lib/rate-limit` for per-IP throttling.
 * - `@/lib/http-status` for status constants.
 * - `@/lib/client-ip` for IP extraction from proxy headers.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#16.
 * - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — Cameron's
 *   Clarifications #4.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_CONFLICT,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
  STATUS_UNSUPPORTED_MEDIA_TYPE,
} from "@/lib/http-status";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  acceptCredentialTempwrite,
  validateTempwritePayload,
  writeAuditAccepted,
  writeAuditRejected,
  TempwriteRejectedError,
  type CredentialTempwritePayload,
} from "@/lib/federation/accept-tempwrite";

// ---------------------------------------------------------------------------
// Response shapes (stable contract)
// ---------------------------------------------------------------------------

/** Success body. Mirrors the lib's {@link AcceptTempwriteResult}. */
export interface AcceptTempwriteSuccessResponse {
  ok: true;
  agentId: string;
  credentialVersion: number;
  previousCredentialVersion: number;
  sessionVersion: number;
  appliedAt: string;
}

/** Failure body. Code matches the rejected-error `code`. */
export interface AcceptTempwriteFailureResponse {
  ok: false;
  error: string;
  message: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

/**
 * Accept a signed credential temp-write from global.
 *
 * Auth: none (the Ed25519 signature is the authentication).
 *
 * Rate limiting: per client IP (same tier as password-reset — global is
 * a trusted peer but the public endpoint must still be scripted-abuse
 * resistant). Per-agent spacing is enforced inside the lib.
 *
 * Audit: every attempt — accepted or rejected — appends exactly one
 * row to `credential_authority_audit` so users can see credential
 * authority transitions in their activity feed.
 *
 * Error surface:
 * - 400 malformed body / forbidden field / stale timestamp
 * - 403 wrong instance mode / signature failure / authority closed
 * - 404 unknown agent id
 * - 409 stale credential version / replayed nonce
 * - 415 content type not JSON
 * - 429 too many per-IP requests
 * - 500 unexpected infra failure (e.g. public key not configured)
 */
export async function POST(request: Request): Promise<NextResponse> {
  const headerList = await headers();
  const clientIp = safeIp(headerList);

  // -------------------------------------------------------------------------
  // Step 1: content-type guard (cheap).
  // -------------------------------------------------------------------------
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonFailure(
      STATUS_UNSUPPORTED_MEDIA_TYPE,
      "unsupported_media_type",
      "Content-Type must be application/json."
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: per-IP rate limit.
  // -------------------------------------------------------------------------
  const limiter = await rateLimit(
    `accept_credential_tempwrite:${clientIp}`,
    RATE_LIMITS.PASSWORD_RESET.limit,
    RATE_LIMITS.PASSWORD_RESET.windowMs
  );

  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return jsonFailure(
      STATUS_TOO_MANY_REQUESTS,
      "rate_limited",
      `Too many requests. Retry in ${retryAfterSec}s.`,
      { retryAfterSec }
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: parse + structural validation.
  // -------------------------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not parse request body as JSON.";
    return jsonFailure(STATUS_BAD_REQUEST, "malformed_json", message);
  }

  let signed;
  try {
    signed = validateTempwritePayload(rawBody);
  } catch (err) {
    return await handleRejection(err, /*payload*/ null, clientIp);
  }

  // -------------------------------------------------------------------------
  // Step 4: verify + apply (lib does the heavy lifting).
  // -------------------------------------------------------------------------
  try {
    const result = await acceptCredentialTempwrite(signed, {
      ipAddress: clientIp,
    });

    await writeAuditAccepted({
      agentId: result.agentId,
      credentialVersion: result.credentialVersion,
      nonce: signed.event.nonce,
      signingNodeSlug: signed.signingNodeSlug,
      ipAddress: clientIp,
      previousCredentialVersion: result.previousCredentialVersion,
      sessionVersion: result.sessionVersion,
    });

    const body: AcceptTempwriteSuccessResponse = {
      ok: true,
      agentId: result.agentId,
      credentialVersion: result.credentialVersion,
      previousCredentialVersion: result.previousCredentialVersion,
      sessionVersion: result.sessionVersion,
      appliedAt: result.appliedAt.toISOString(),
    };

    return NextResponse.json(body, { status: STATUS_OK });
  } catch (err) {
    return await handleRejection(err, signed.event, clientIp);
  }
}

// ---------------------------------------------------------------------------
// Shared rejection handler
// ---------------------------------------------------------------------------

async function handleRejection(
  err: unknown,
  payload: CredentialTempwritePayload | null,
  clientIp: string
): Promise<NextResponse> {
  if (err instanceof TempwriteRejectedError) {
    // Log for operator visibility without leaking to the body.
    console.warn(
      `[accept-tempwrite] rejected agentId=${payload?.agentId ?? "<unparsed>"} ` +
        `code=${err.code} detail=${JSON.stringify(err.detail)}`
    );

    // Audit — agentId is only known once we've at least parsed the envelope.
    // Malformed requests without an agent id intentionally do not produce
    // an audit row, since there is no FK target and no user to attribute.
    try {
      await writeAuditRejected({
        agentId: payload?.agentId ?? null,
        outcome: err.code,
        credentialVersion: payload?.credentialVersion ?? null,
        nonce: payload?.nonce ?? null,
        ipAddress: clientIp,
        detail: { ...err.detail, rejectMessage: err.message },
      });
    } catch (auditErr) {
      console.error("[accept-tempwrite] audit write failed:", auditErr);
    }

    return jsonFailure(err.status, err.code, err.message, err.detail);
  }

  // Non-deterministic failure path — log, record to audit if possible,
  // and surface a generic 500. The underlying Error message is still
  // echoed because these are deploy-time misconfigurations (missing env
  // var, DB down) and hiding them helps no one.
  console.error("[accept-tempwrite] unhandled error:", err);

  try {
    await writeAuditRejected({
      agentId: payload?.agentId ?? null,
      outcome: "internal_error",
      credentialVersion: payload?.credentialVersion ?? null,
      nonce: payload?.nonce ?? null,
      ipAddress: clientIp,
      detail: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } catch (auditErr) {
    console.error("[accept-tempwrite] audit write failed:", auditErr);
  }

  const message =
    err instanceof Error ? err.message : "Unexpected server error.";
  return jsonFailure(STATUS_INTERNAL_ERROR, "internal_error", message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonFailure(
  status: number,
  error: string,
  message: string,
  detail?: Record<string, unknown>
): NextResponse {
  const body: AcceptTempwriteFailureResponse = {
    ok: false,
    error,
    message,
    ...(detail ? { detail } : {}),
  };
  return NextResponse.json(body, { status });
}

function safeIp(headerList: Headers): string {
  try {
    return getClientIp(headerList);
  } catch {
    return "unknown";
  }
}

