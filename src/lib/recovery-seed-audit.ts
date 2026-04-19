/**
 * Recovery-seed audit-log writer.
 *
 * Purpose:
 * Provide a single, strongly-typed entry point for appending rows to the
 * `recovery_seed_audit_log` table. All recovery-flow routes (challenge,
 * verify, reveal, rotate) funnel through here so:
 *
 *   1. Callers cannot accidentally log the mnemonic by misordering args.
 *   2. A single place enforces the no-plaintext invariant.
 *   3. The UI audit view can trust that every transition is captured.
 *
 * Key exports:
 * - `RecoverySeedAuditEvent` : input contract for {@link appendRecoverySeedAudit}.
 * - `appendRecoverySeedAudit` : inserts one row and returns the stored record.
 * - `listRecentRecoverySeedAudit` : recent events for a given agent.
 * - `RECOVERY_AUDIT_FORBIDDEN_KEYS` : metadata keys that MUST NEVER appear.
 *
 * Dependencies:
 * - `@/db` + the Drizzle `recoverySeedAuditLog` table.
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import {
  recoverySeedAuditLog,
  type NewRecoverySeedAuditLogRecord,
  type RecoverySeedAuditLogRecord,
  type RecoverySeedEventKind,
  type RecoverySeedMethod,
} from '@/db/schema';

/**
 * Metadata keys that MUST NEVER appear on an audit row. Defence-in-depth
 * against future code paths accidentally logging sensitive material.
 */
export const RECOVERY_AUDIT_FORBIDDEN_KEYS: readonly string[] = [
  'mnemonic',
  'seedPhrase',
  'seed',
  'privateKey',
  'privateKeyHex',
  'passphrase',
  'password',
] as const;

/**
 * Maximum number of recent audit rows to surface in the Security settings
 * card. The table is append-only and can grow unboundedly over the agent's
 * lifetime; the UI only needs the most recent activity.
 */
export const RECOVERY_AUDIT_DEFAULT_LIMIT = 20;

/**
 * Thrown when a caller tries to write a forbidden metadata key. Signals a
 * programming bug (not a runtime/operator issue) so the process can log
 * loudly and fail closed.
 */
export class RecoveryAuditForbiddenMetadataError extends Error {
  public readonly keys: readonly string[];
  constructor(keys: readonly string[]) {
    super(
      `appendRecoverySeedAudit: refusing to log forbidden metadata keys: ${keys.join(
        ', ',
      )}. Plaintext seed material must never enter the audit log.`,
    );
    this.name = 'RecoveryAuditForbiddenMetadataError';
    this.keys = keys;
  }
}

/**
 * Structured input for {@link appendRecoverySeedAudit}. All fields except
 * `agentId` and `eventKind` are optional; callers should pass whichever
 * context is meaningful for the transition they are logging.
 */
export interface RecoverySeedAuditEvent {
  agentId: string;
  eventKind: RecoverySeedEventKind;
  method?: RecoverySeedMethod;
  outcome?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append a row to `recovery_seed_audit_log`.
 *
 * @param event Structured event. Metadata is sanity-checked against the
 *   forbidden-keys list before write.
 * @returns The inserted row (including server-generated `id` and
 *   `createdAt`).
 * @throws {RecoveryAuditForbiddenMetadataError} When metadata contains a
 *   forbidden key. Signals a programming bug — callers should not catch.
 */
export async function appendRecoverySeedAudit(
  event: RecoverySeedAuditEvent,
): Promise<RecoverySeedAuditLogRecord> {
  if (event.metadata) {
    const forbidden = Object.keys(event.metadata).filter((key) =>
      RECOVERY_AUDIT_FORBIDDEN_KEYS.includes(key),
    );
    if (forbidden.length > 0) {
      throw new RecoveryAuditForbiddenMetadataError(forbidden);
    }
  }

  const row: NewRecoverySeedAuditLogRecord = {
    agentId: event.agentId,
    eventKind: event.eventKind,
    method: event.method,
    outcome: event.outcome,
    ipAddress: event.ipAddress ?? undefined,
    userAgent: event.userAgent ?? undefined,
    metadata: event.metadata,
  };

  const [inserted] = await db
    .insert(recoverySeedAuditLog)
    .values(row)
    .returning();

  return inserted;
}

/**
 * Read the most recent audit rows for an agent, newest first.
 *
 * @param agentId Agent whose rows to return.
 * @param limit Maximum rows to return. Clamped to
 *   {@link RECOVERY_AUDIT_DEFAULT_LIMIT} x 10.
 * @returns Rows ordered `created_at DESC`. Empty list if none exist.
 */
export async function listRecentRecoverySeedAudit(
  agentId: string,
  limit: number = RECOVERY_AUDIT_DEFAULT_LIMIT,
): Promise<RecoverySeedAuditLogRecord[]> {
  const safeLimit = Math.max(
    1,
    Math.min(limit, RECOVERY_AUDIT_DEFAULT_LIMIT * 10),
  );
  return db
    .select()
    .from(recoverySeedAuditLog)
    .where(eq(recoverySeedAuditLog.agentId, agentId))
    .orderBy(desc(recoverySeedAuditLog.createdAt))
    .limit(safeLimit);
}
