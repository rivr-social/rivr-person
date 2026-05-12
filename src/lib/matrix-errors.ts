/**
 * Error types for Matrix admin API operations. Lives in its own module so
 * the canonical `matrix-admin.ts` can stay marked `"use server"` (which
 * forbids non-async exports like classes).
 */

/**
 * Typed error for Matrix provisioning failures so callers can distinguish
 * "Synapse rejected us" from "we got back a malformed login result" from
 * generic network errors.
 */
export class MatrixProvisioningError extends Error {
  public readonly stage:
    | "user_create"
    | "user_login"
    | "missing_token"
    | "network";
  public readonly cause?: unknown;
  constructor(stage: MatrixProvisioningError["stage"], message: string, cause?: unknown) {
    super(`Matrix provisioning failed (${stage}): ${message}`);
    this.name = "MatrixProvisioningError";
    this.stage = stage;
    this.cause = cause;
  }
}
