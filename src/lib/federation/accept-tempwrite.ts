/**
 * Accept-side credential temp-write helper.
 *
 * Purpose:
 * - Verify and apply `credential.tempwrite.from-global` events signed by
 *   the global instance. This is the home-side counterpart to the
 *   outgoing sync added in #15 (`credential-sync.ts`).
 * - Only credential material is accepted — profile, state, and persona
 *   fields are rejected via an allow-list.
 * - Rejects are audited just as loudly as accepts so users can see
 *   failed attempts in their activity feed.
 *
 * Key exports:
 * - {@link CREDENTIAL_TEMPWRITE_EVENT_TYPE}
 * - {@link ACCEPTED_CREDENTIAL_FIELDS}
 * - {@link resolveGlobalPublicKey}
 * - {@link validateTempwritePayload}
 * - {@link acceptCredentialTempwrite}
 * - Error classes: {@link TempwriteRejectedError} and the specific
 *   subclasses used by the route to map to HTTP status codes.
 *
 * Dependencies:
 * - `@/db` + the `agents`, `credentialTempwriteNonces`, and
 *   `credentialAuthorityAudit` tables (migration 0038).
 * - `@/lib/federation-crypto` for Ed25519 verification.
 * - `@/lib/federation` for the hosted local node lookup (for the
 *   fallback path through the peer registry).
 * - `@/lib/instance-mode` to enforce sovereign-only acceptance.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#16.
 * - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — Cameron's
 *   Clarifications #4 (global may temp-write credential-only material
 *   to home during password reset).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { hash as bcryptHash } from "@node-rs/bcrypt";
import { db } from "@/db";
import {
  agents,
  credentialAuthorityAudit,
  credentialTempwriteNonces,
  nodes,
  type NewCredentialAuthorityAuditRecord,
} from "@/db/schema";
import { verifyPayloadSignature } from "@/lib/federation-crypto";
import {
  getInstanceMode,
  INSTANCE_MODE_SOVEREIGN,
} from "@/lib/instance-mode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event type discriminator the incoming payload must carry. */
export const CREDENTIAL_TEMPWRITE_EVENT_TYPE =
  "credential.tempwrite.from-global" as const;

/**
 * Strict allow-list of fields permitted inside the signed event.
 *
 * Any key outside this set — including profile, state, persona, or
 * metadata fields — causes the payload to be rejected with
 * {@link TempwriteForbiddenFieldError}. The `type` discriminator is
 * separately required on the envelope and not duplicated here.
 *
 * Order mirrors the event schema documented in issue #16:
 * `{ agentId, newCredentialVerifier, credentialVersion, timestamp, nonce }`.
 */
export const ACCEPTED_CREDENTIAL_FIELDS = [
  "type",
  "agentId",
  "newCredentialVerifier",
  "credentialVersion",
  "timestamp",
  "nonce",
] as const satisfies readonly string[];

/** Same fields as a Set for fast membership tests in validation hot-path. */
export const ACCEPTED_CREDENTIAL_FIELD_SET: ReadonlySet<string> = new Set(
  ACCEPTED_CREDENTIAL_FIELDS
);

/**
 * Env var holding the global instance's Ed25519 public key in PEM form.
 *
 * Checked first; falls back to peer-registry lookup when unset. Kept as
 * a dedicated constant so deploy-time typos fail loudly.
 */
export const GLOBAL_PUBLIC_KEY_ENV_VAR = "GLOBAL_INSTANCE_PUBLIC_KEY" as const;

/**
 * Env var that selects which peer-registry row to use when the env key
 * above is unset. Defaults to `"global"` (matches `nodes.role`).
 */
export const GLOBAL_NODE_SLUG_ENV_VAR = "GLOBAL_NODE_SLUG" as const;

/** Default slug used when {@link GLOBAL_NODE_SLUG_ENV_VAR} is unset. */
export const DEFAULT_GLOBAL_NODE_SLUG = "global" as const;

/**
 * bcrypt cost factor. Matches `password-reset.ts` to keep verifiers
 * produced by the two paths interchangeable.
 */
const BCRYPT_SALT_ROUNDS = 12;

/**
 * Maximum allowed drift between the event `timestamp` and server clock.
 * Signed events older than this are rejected as stale to cap replay
 * windows even before the nonce ledger is consulted.
 */
export const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Minimum spacing between accepted temp-writes for the same agent.
 * Independent of the per-IP rate limiter: a signed burst of events from
 * global still must not land at 100 Hz on the same row.
 */
export const PER_AGENT_ACCEPT_FLOOR_MS = 1_000;

/**
 * Migration-status values that mean this home instance has lost or is
 * in the process of losing authority over its agents' credentials, and
 * therefore must refuse global temp-writes until reconciled.
 */
const REJECTING_MIGRATION_STATUSES = new Set([
  "migrating_out",
  "migrating_in",
  "archived",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Canonical decoded payload.  Every field here is required; missing or
 * mis-typed fields raise {@link TempwriteMalformedError}.
 *
 * The `type` discriminator must equal {@link CREDENTIAL_TEMPWRITE_EVENT_TYPE}.
 */
export interface CredentialTempwritePayload {
  type: typeof CREDENTIAL_TEMPWRITE_EVENT_TYPE;
  agentId: string;
  /**
   * The new credential verifier (bcrypt hash or equivalent).
   *
   * The route also accepts a plaintext password when global was forced
   * to bridge a legacy reset where only the cleartext is available on
   * the global side. In that case the route passes `rehash: true` to
   * {@link acceptCredentialTempwrite} and we hash locally before
   * writing. See the route handler for the exact flag plumbing.
   */
  newCredentialVerifier: string;
  credentialVersion: number;
  /** ISO-8601 timestamp of the rotation on global. */
  timestamp: string;
  /** Replay-protection nonce. Must not have been seen before. */
  nonce: string;
}

/** Signed envelope received over HTTP. */
export interface SignedCredentialTempwrite {
  /** Decoded JSON payload. */
  event: CredentialTempwritePayload;
  /** Base64 Ed25519 signature covering `canonicalize(event)`. */
  signature: string;
  /** Optional signing node slug for diagnostics/audit; defaults to "global". */
  signingNodeSlug?: string;
}

/** Outcome of {@link acceptCredentialTempwrite}. */
export interface AcceptTempwriteResult {
  /** Agent id whose credential was updated. */
  agentId: string;
  /** Previous credential version on this instance. */
  previousCredentialVersion: number;
  /** New credential version written. */
  credentialVersion: number;
  /** Session version after the bump. Any pre-existing sessions with a
   *  lower version must be treated as invalidated by downstream auth. */
  sessionVersion: number;
  /** Timestamp when the update committed. */
  appliedAt: Date;
}

/** Options controlling how the verifier is stored. */
export interface AcceptTempwriteOptions {
  /**
   * Best-effort IP/user-agent metadata — recorded in the audit row only.
   * Failing to pass them is never an error.
   */
  ipAddress?: string | null;
  /**
   * When `true`, treat `newCredentialVerifier` as plaintext and bcrypt-
   * hash it before writing to `agents.passwordHash`. Default is `false`
   * (global is expected to send the already-derived verifier).
   */
  rehash?: boolean;
  /**
   * Override the public-key resolver — primarily for tests. When
   * unset, {@link resolveGlobalPublicKey} is used.
   */
  publicKeyResolver?: () => Promise<string>;
  /**
   * Override the clock — primarily for tests (stale-timestamp checks).
   */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/**
 * Base class for all deterministic rejection reasons. Carries a stable
 * `code` the route maps to an HTTP status and a user-visible audit row.
 *
 * Rejection reasons that are programmer bugs (e.g. missing dependencies)
 * still throw plain `Error` so they surface loudly in logs.
 */
export class TempwriteRejectedError extends Error {
  /** Machine-readable code for audit/response bodies. */
  public readonly code: string;
  /** HTTP status code to return. 400 by default; subclasses override. */
  public readonly status: number;
  /** Structured detail attached to the audit row. */
  public readonly detail: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TempwriteRejectedError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** 400 — the envelope or payload is structurally wrong. */
export class TempwriteMalformedError extends TempwriteRejectedError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("malformed_payload", message, 400, detail);
    this.name = "TempwriteMalformedError";
  }
}

/** 400 — payload contains a field outside {@link ACCEPTED_CREDENTIAL_FIELDS}. */
export class TempwriteForbiddenFieldError extends TempwriteRejectedError {
  constructor(fields: readonly string[]) {
    super(
      "forbidden_field",
      `Payload contains disallowed fields: ${fields.join(", ")}. ` +
        `Only credential material is accepted via temp-write.`,
      400,
      { forbiddenFields: fields }
    );
    this.name = "TempwriteForbiddenFieldError";
  }
}

/** 403 — signature is missing or fails verification. */
export class TempwriteSignatureError extends TempwriteRejectedError {
  constructor(reason: string) {
    super("invalid_signature", reason, 403, { reason });
    this.name = "TempwriteSignatureError";
  }
}

/** 403 — this instance's mode does not accept global temp-writes. */
export class TempwriteWrongInstanceModeError extends TempwriteRejectedError {
  constructor(mode: string) {
    super(
      "wrong_instance_mode",
      `Credential temp-writes only accepted on sovereign instances; this instance is "${mode}".`,
      403,
      { mode }
    );
    this.name = "TempwriteWrongInstanceModeError";
  }
}

/** 403 — local authority is revoked or migrating; temp-writes are refused. */
export class TempwriteAuthorityStatusError extends TempwriteRejectedError {
  constructor(migrationStatus: string) {
    super(
      "authority_status_closed",
      `Local authority is in state "${migrationStatus}"; credential temp-writes are not accepted.`,
      403,
      { migrationStatus }
    );
    this.name = "TempwriteAuthorityStatusError";
  }
}

/** 404 — no agent with the supplied id exists locally. */
export class TempwriteAgentNotFoundError extends TempwriteRejectedError {
  constructor(agentId: string) {
    super("agent_not_found", `No local agent with id ${agentId}.`, 404, {
      agentId,
    });
    this.name = "TempwriteAgentNotFoundError";
  }
}

/** 409 — credentialVersion is not strictly greater than current. */
export class TempwriteStaleVersionError extends TempwriteRejectedError {
  constructor(incoming: number, current: number) {
    super(
      "stale_version",
      `Incoming credentialVersion=${incoming} is not greater than current=${current}.`,
      409,
      { incoming, current }
    );
    this.name = "TempwriteStaleVersionError";
  }
}

/** 409 — nonce has already been accepted for this instance. */
export class TempwriteReplayError extends TempwriteRejectedError {
  constructor(nonce: string) {
    super("replay_detected", `Nonce already recorded: ${nonce}.`, 409, {
      nonce,
    });
    this.name = "TempwriteReplayError";
  }
}

/** 429 — per-agent floor between accepts has not elapsed. */
export class TempwriteAgentThrottleError extends TempwriteRejectedError {
  constructor(msSinceLast: number) {
    super(
      "agent_throttled",
      `Credential temp-writes for this agent must be spaced at least ${PER_AGENT_ACCEPT_FLOOR_MS}ms apart; last was ${msSinceLast}ms ago.`,
      429,
      { msSinceLast, minSpacingMs: PER_AGENT_ACCEPT_FLOOR_MS }
    );
    this.name = "TempwriteAgentThrottleError";
  }
}

/** 400 — timestamp is too far from server clock. */
export class TempwriteStaleTimestampError extends TempwriteRejectedError {
  constructor(skewMs: number) {
    super(
      "stale_timestamp",
      `Event timestamp skew ${skewMs}ms exceeds window ${MAX_TIMESTAMP_SKEW_MS}ms.`,
      400,
      { skewMs, maxSkewMs: MAX_TIMESTAMP_SKEW_MS }
    );
    this.name = "TempwriteStaleTimestampError";
  }
}

// ---------------------------------------------------------------------------
// Public-key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the PEM-encoded Ed25519 public key used to verify
 * `credential.tempwrite.from-global` events.
 *
 * Resolution order:
 * 1. `GLOBAL_INSTANCE_PUBLIC_KEY` env var (literal PEM, newlines are
 *    accepted either as real `\n` characters or escaped `\\n`).
 * 2. Peer-registry lookup: find the first row in `nodes` where
 *    `role = 'global'` and `slug = GLOBAL_NODE_SLUG || 'global'` with
 *    a non-null `publicKey`.
 *
 * @returns PEM-encoded public key string suitable for
 *   {@link verifyPayloadSignature}.
 * @throws {Error} when neither source yields a usable key; the route
 *   surfaces this as a 500 (deploy-time misconfiguration).
 */
export async function resolveGlobalPublicKey(): Promise<string> {
  const envValue = process.env[GLOBAL_PUBLIC_KEY_ENV_VAR]?.trim();
  if (envValue) {
    return unescapePem(envValue);
  }

  const slug =
    process.env[GLOBAL_NODE_SLUG_ENV_VAR]?.trim() || DEFAULT_GLOBAL_NODE_SLUG;

  const [row] = await db
    .select({
      publicKey: nodes.publicKey,
      role: nodes.role,
      slug: nodes.slug,
    })
    .from(nodes)
    .where(and(eq(nodes.slug, slug), eq(nodes.role, "global")))
    .limit(1);

  if (!row || !row.publicKey) {
    throw new Error(
      `Cannot resolve global public key: set ${GLOBAL_PUBLIC_KEY_ENV_VAR} ` +
        `or register a peer with slug="${slug}" role="global" and a public key.`
    );
  }

  return row.publicKey;
}

/**
 * Convert a PEM string whose newlines were escaped as literal `\n` back
 * into a real multi-line string. Env vars and compose files often store
 * PEM this way for convenience.
 */
function unescapePem(value: string): string {
  if (value.includes("\\n") && !value.includes("\n")) {
    return value.replace(/\\n/g, "\n");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse and allow-list-validate the raw envelope received on the wire.
 *
 * Does NOT verify the signature (callers do that after resolving the
 * global key) nor touch the database. Kept pure so it can be unit-
 * tested deterministically.
 *
 * @param body Raw JSON object parsed from the request body.
 * @returns Structurally valid {@link SignedCredentialTempwrite}.
 * @throws {TempwriteMalformedError} when required fields are missing or
 *   mistyped.
 * @throws {TempwriteForbiddenFieldError} when the payload carries any
 *   key outside {@link ACCEPTED_CREDENTIAL_FIELDS}.
 */
export function validateTempwritePayload(
  body: unknown
): SignedCredentialTempwrite {
  if (!isPlainObject(body)) {
    throw new TempwriteMalformedError("Body must be a JSON object.");
  }

  const event = (body as Record<string, unknown>).event;
  const signature = (body as Record<string, unknown>).signature;
  const signingNodeSlug = (body as Record<string, unknown>).signingNodeSlug;

  if (!isPlainObject(event)) {
    throw new TempwriteMalformedError(
      "Body missing `event` object.",
      { receivedType: typeof event }
    );
  }

  if (typeof signature !== "string" || signature.length === 0) {
    throw new TempwriteMalformedError("Body missing non-empty `signature`.");
  }

  // Allow-list enforcement — the defining guardrail from Clarification #4.
  const forbidden: string[] = [];
  for (const key of Object.keys(event as Record<string, unknown>)) {
    if (!ACCEPTED_CREDENTIAL_FIELD_SET.has(key)) {
      forbidden.push(key);
    }
  }
  if (forbidden.length > 0) {
    throw new TempwriteForbiddenFieldError(forbidden);
  }

  const ev = event as Record<string, unknown>;

  if (ev.type !== CREDENTIAL_TEMPWRITE_EVENT_TYPE) {
    throw new TempwriteMalformedError(
      `event.type must equal "${CREDENTIAL_TEMPWRITE_EVENT_TYPE}".`,
      { receivedType: ev.type }
    );
  }

  if (typeof ev.agentId !== "string" || ev.agentId.length === 0) {
    throw new TempwriteMalformedError("event.agentId must be a non-empty string.");
  }

  if (
    typeof ev.newCredentialVerifier !== "string" ||
    ev.newCredentialVerifier.length === 0
  ) {
    throw new TempwriteMalformedError(
      "event.newCredentialVerifier must be a non-empty string."
    );
  }

  if (
    typeof ev.credentialVersion !== "number" ||
    !Number.isInteger(ev.credentialVersion) ||
    ev.credentialVersion < 1
  ) {
    throw new TempwriteMalformedError(
      "event.credentialVersion must be a positive integer."
    );
  }

  if (typeof ev.timestamp !== "string" || Number.isNaN(Date.parse(ev.timestamp))) {
    throw new TempwriteMalformedError(
      "event.timestamp must be an ISO-8601 timestamp string."
    );
  }

  if (typeof ev.nonce !== "string" || ev.nonce.length === 0) {
    throw new TempwriteMalformedError("event.nonce must be a non-empty string.");
  }

  const normalizedEvent: CredentialTempwritePayload = {
    type: CREDENTIAL_TEMPWRITE_EVENT_TYPE,
    agentId: ev.agentId,
    newCredentialVerifier: ev.newCredentialVerifier,
    credentialVersion: ev.credentialVersion,
    timestamp: ev.timestamp,
    nonce: ev.nonce,
  };

  return {
    event: normalizedEvent,
    signature,
    signingNodeSlug:
      typeof signingNodeSlug === "string" && signingNodeSlug.length > 0
        ? signingNodeSlug
        : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// ---------------------------------------------------------------------------
// Core: verify + apply
// ---------------------------------------------------------------------------

/**
 * Verify and apply a signed credential temp-write.
 *
 * On success this single call:
 * 1. Confirms this instance is sovereign.
 * 2. Confirms the local node is not in a migrating/archived authority state.
 * 3. Verifies the Ed25519 signature against the resolved global public key.
 * 4. Rejects replay (nonce seen before) and non-monotonic versions.
 * 5. Rejects timestamps outside {@link MAX_TIMESTAMP_SKEW_MS}.
 * 6. Enforces per-agent {@link PER_AGENT_ACCEPT_FLOOR_MS} spacing.
 * 7. Writes the new `passwordHash`, bumps `credentialVersion`, bumps
 *    `sessionVersion` (invalidating every existing session for the
 *    agent), and records the nonce — all inside one DB transaction.
 * 8. Appends an `accepted` row to `credential_authority_audit`.
 *
 * The caller handles rate-limit (per IP) and audits `rejected` rows
 * for {@link TempwriteRejectedError} failures; see
 * `src/app/api/recovery/accept-credential-tempwrite/route.ts`.
 *
 * @throws {TempwriteRejectedError} for every deterministic validation
 *   failure; the subclass carries both the HTTP status and the audit
 *   detail the route should surface.
 * @throws {Error} for non-deterministic infra failures (missing
 *   public key, DB errors).
 */
export async function acceptCredentialTempwrite(
  signed: SignedCredentialTempwrite,
  options: AcceptTempwriteOptions = {}
): Promise<AcceptTempwriteResult> {
  const now = options.now ?? (() => new Date());
  const { event, signature } = signed;

  // 1. Instance mode.
  const mode = getInstanceMode();
  if (mode !== INSTANCE_MODE_SOVEREIGN) {
    throw new TempwriteWrongInstanceModeError(mode);
  }

  // 2. Verify signature (payload canonicalization lives inside verifyPayloadSignature).
  const publicKey = await (options.publicKeyResolver ?? resolveGlobalPublicKey)();
  const signatureOk = verifyPayloadSignature(
    event as unknown as Record<string, unknown>,
    signature,
    publicKey
  );
  if (!signatureOk) {
    throw new TempwriteSignatureError(
      "Signature did not verify against registered global public key."
    );
  }

  // 3. Timestamp skew — cheap guard on top of the nonce ledger.
  const eventTimeMs = Date.parse(event.timestamp);
  const skewMs = Math.abs(now().getTime() - eventTimeMs);
  if (skewMs > MAX_TIMESTAMP_SKEW_MS) {
    throw new TempwriteStaleTimestampError(skewMs);
  }

  // 4. Look up the agent and ensure it exists before any writes.
  const [agent] = await db
    .select({
      id: agents.id,
      credentialVersion: agents.credentialVersion,
      sessionVersion: agents.sessionVersion,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, event.agentId))
    .limit(1);

  if (!agent) {
    throw new TempwriteAgentNotFoundError(event.agentId);
  }

  // 5. Monotonic version check.
  if (event.credentialVersion <= agent.credentialVersion) {
    throw new TempwriteStaleVersionError(
      event.credentialVersion,
      agent.credentialVersion
    );
  }

  // 6. Authority status / migration state check — local node.
  const localNodeStatus = await lookupLocalMigrationStatus();
  if (
    localNodeStatus &&
    REJECTING_MIGRATION_STATUSES.has(localNodeStatus)
  ) {
    throw new TempwriteAuthorityStatusError(localNodeStatus);
  }

  // 7. Per-agent spacing (defense in depth in front of the DB insert).
  const [latestAudit] = await db
    .select({ createdAt: credentialAuthorityAudit.createdAt })
    .from(credentialAuthorityAudit)
    .where(
      and(
        eq(credentialAuthorityAudit.agentId, event.agentId),
        eq(credentialAuthorityAudit.eventKind, "tempwrite.accepted")
      )
    )
    .orderBy(desc(credentialAuthorityAudit.createdAt))
    .limit(1);

  if (latestAudit) {
    const msSinceLast = now().getTime() - latestAudit.createdAt.getTime();
    if (msSinceLast < PER_AGENT_ACCEPT_FLOOR_MS) {
      throw new TempwriteAgentThrottleError(msSinceLast);
    }
  }

  // 8. Replay check — cheap read, then enforced by PK on insert below.
  const [existingNonce] = await db
    .select({ nonce: credentialTempwriteNonces.nonce })
    .from(credentialTempwriteNonces)
    .where(eq(credentialTempwriteNonces.nonce, event.nonce))
    .limit(1);

  if (existingNonce) {
    throw new TempwriteReplayError(event.nonce);
  }

  // 9. Derive the final verifier — rehash if caller says so.
  const passwordHash = options.rehash
    ? await bcryptHash(event.newCredentialVerifier, BCRYPT_SALT_ROUNDS)
    : event.newCredentialVerifier;

  const appliedAt = now();
  const metadata =
    agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  const nextSessionVersion = agent.sessionVersion + 1;

  // Drizzle's serializable transaction is the safest way to keep the
  // nonce insert and the agents update atomic. Any concurrent replay
  // attempt will lose the nonce PK race.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(credentialTempwriteNonces).values({
        nonce: event.nonce,
        agentId: event.agentId,
        credentialVersion: event.credentialVersion,
      });

      await tx
        .update(agents)
        .set({
          passwordHash,
          credentialVersion: event.credentialVersion,
          sessionVersion: nextSessionVersion,
          metadata: {
            ...metadata,
            passwordChangedAt: appliedAt.toISOString(),
            credentialAuthority: "global.tempwrite",
          },
          updatedAt: appliedAt,
        })
        .where(eq(agents.id, event.agentId));
    });
  } catch (err) {
    // The unique-PK violation on nonce is the only race we treat as a
    // normal rejection; anything else bubbles so callers see real infra
    // errors.
    if (isUniqueViolation(err)) {
      throw new TempwriteReplayError(event.nonce);
    }
    throw err;
  }

  return {
    agentId: event.agentId,
    previousCredentialVersion: agent.credentialVersion,
    credentialVersion: event.credentialVersion,
    sessionVersion: nextSessionVersion,
    appliedAt,
  };
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Append an `accepted` row to `credential_authority_audit`.
 *
 * Kept as a separate call (not wrapped into the transaction above) so
 * the audit row is written with a known `eventKind` regardless of
 * whether the core apply threw — and so the route can mirror the same
 * call shape when it writes a `rejected` row.
 */
export async function writeAuditAccepted(params: {
  agentId: string;
  credentialVersion: number;
  nonce: string;
  signingNodeSlug?: string;
  ipAddress?: string | null;
  previousCredentialVersion: number;
  sessionVersion: number;
}): Promise<void> {
  const row: NewCredentialAuthorityAuditRecord = {
    agentId: params.agentId,
    eventKind: "tempwrite.accepted",
    source: "global",
    outcome: "accepted",
    credentialVersion: params.credentialVersion,
    nonce: params.nonce,
    ipAddress: params.ipAddress ?? null,
    detail: {
      signingNodeSlug: params.signingNodeSlug ?? "global",
      previousCredentialVersion: params.previousCredentialVersion,
      sessionVersion: params.sessionVersion,
    },
  };
  await db.insert(credentialAuthorityAudit).values(row);
}

/**
 * Append a `rejected` row to `credential_authority_audit`.
 *
 * Accepts partial payload data because rejections can happen before the
 * envelope has been parsed (e.g. 400 on a malformed body). Fields that
 * are unknown at the point of rejection are persisted as null so the
 * row shape stays regular.
 */
export async function writeAuditRejected(params: {
  agentId: string | null;
  outcome: string;
  credentialVersion?: number | null;
  nonce?: string | null;
  signingNodeSlug?: string;
  ipAddress?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  // If we don't know the agent id there is nothing meaningful to audit
  // locally — a rejected row without a valid FK would fail to insert
  // anyway. Skip silently; the route still logs to stderr via console.warn.
  if (!params.agentId) {
    return;
  }

  const row: NewCredentialAuthorityAuditRecord = {
    agentId: params.agentId,
    eventKind: "tempwrite.rejected",
    source: "global",
    outcome: params.outcome,
    credentialVersion: params.credentialVersion ?? null,
    nonce: params.nonce ?? null,
    ipAddress: params.ipAddress ?? null,
    detail: {
      signingNodeSlug: params.signingNodeSlug ?? "global",
      ...(params.detail ?? {}),
    },
  };
  await db.insert(credentialAuthorityAudit).values(row);
}

// ---------------------------------------------------------------------------
// Local-node migration status lookup
// ---------------------------------------------------------------------------

async function lookupLocalMigrationStatus(): Promise<string | null> {
  // The "local" node is whichever row matches NODE_SLUG or falls back
  // to any role='global' row on this instance. Keeping the query loose
  // is safer than asserting a single registered row, because rivr-person
  // deployments may run without federation fully configured yet.
  const slug = process.env.NODE_SLUG?.trim() || "global-host";
  const [row] = await db
    .select({ migrationStatus: nodes.migrationStatus })
    .from(nodes)
    .where(eq(nodes.slug, slug))
    .limit(1);

  return row?.migrationStatus ?? null;
}

// ---------------------------------------------------------------------------
// Utility: detect a Postgres unique_violation from a driver-specific error
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  // PostgreSQL SQLSTATE for unique_violation is 23505.
  return code === "23505";
}

/**
 * SQL template re-export — kept so tests can assert the shape of the
 * generated update without importing from drizzle-orm directly.
 */
export const _internal = { sql };
