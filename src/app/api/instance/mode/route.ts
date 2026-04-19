/**
 * Instance-mode discovery API route.
 *
 * Purpose:
 * Expose this deployment's operating mode (sovereign vs hosted-federated)
 * so client-side UI can decide whether to render seed-phrase generation,
 * reveal, and rotation components.
 *
 * Key exports:
 * - `GET`: Returns `{ mode: "hosted-federated" | "sovereign" }`.
 *
 * Dependencies:
 * - Next.js response helper (`NextResponse`).
 * - Shared HTTP status constants (`@/lib/http-status`).
 * - Server-side instance-mode helper (`@/lib/instance-mode`).
 *
 * Related:
 * - GitHub issue rivr-social/rivr-person#18.
 * - `src/lib/instance-mode.ts`.
 * - HANDOFF 2026-04-19 Clarifications #3 (seed phrase sovereign-only)
 *   and #5 (two user classes).
 */
import { NextResponse } from 'next/server';
import { STATUS_OK, STATUS_INTERNAL_ERROR } from '@/lib/http-status';
import {
  getInstanceMode,
  InvalidInstanceModeError,
} from '@/lib/instance-mode';

/**
 * Stable response shape for this endpoint. Clients (Settings UI, signup
 * flow, builder) import-compatible with a simple fetch+JSON parse.
 */
export interface InstanceModeResponse {
  /** Operating mode for this deployment. */
  mode: Awaited<ReturnType<typeof getInstanceMode>>;
}

/**
 * Error response shape emitted only when the env var is misconfigured.
 * Callers should treat this as a deploy-time problem, not a transient.
 */
export interface InstanceModeErrorResponse {
  /** Machine-readable error code. */
  error: 'invalid_instance_mode' | 'instance_mode_unavailable';
  /** Human-readable message (no secrets; safe to display in dev tools). */
  message: string;
}

/**
 * Return the current instance operating mode.
 *
 * Operational notes:
 * - No authentication is required; the value is the same for every
 *   caller from a given deployment and is used by pre-login UI.
 * - No caching headers are set; Next.js route handlers default to
 *   per-request evaluation, which is fine because {@link getInstanceMode}
 *   is cached in-memory.
 *
 * Error handling pattern:
 * - {@link InvalidInstanceModeError} is surfaced as a 500 with a
 *   structured body so operators see the exact offending value without
 *   leaking secrets.
 * - Any other unexpected exception is caught and converted to a generic
 *   500 with the `instance_mode_unavailable` code.
 *
 * @param {Request} _request Incoming request (not used).
 * @returns {Promise<NextResponse>} JSON payload with the mode, or an
 *   error payload on misconfiguration.
 * @example
 * // GET /api/instance/mode
 * // -> 200 { "mode": "sovereign" }
 */
export async function GET(_request: Request): Promise<NextResponse> {
  try {
    const mode = getInstanceMode();
    const body: InstanceModeResponse = { mode };
    return NextResponse.json(body, { status: STATUS_OK });
  } catch (error) {
    if (error instanceof InvalidInstanceModeError) {
      const body: InstanceModeErrorResponse = {
        error: 'invalid_instance_mode',
        message: error.message,
      };
      return NextResponse.json(body, { status: STATUS_INTERNAL_ERROR });
    }

    const message =
      error instanceof Error
        ? error.message
        : 'Unknown failure resolving instance mode.';
    const body: InstanceModeErrorResponse = {
      error: 'instance_mode_unavailable',
      message,
    };
    return NextResponse.json(body, { status: STATUS_INTERNAL_ERROR });
  }
}
