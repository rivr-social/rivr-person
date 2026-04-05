/**
 * Audit log for persona actions.
 *
 * Records every persona action decision — auto-allowed, approved, rejected,
 * or expired — into the `persona_audit_log` table for observability and
 * compliance purposes.
 *
 * Key exports:
 * - `logAction()` — write a new audit log entry
 * - `getAuditLog()` — paginated query with optional filters
 */

import { db } from '@/db';
import { personaAuditLog } from '@/db/schema';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import type { RiskLevel } from './policy-engine';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditDecision = 'auto_allowed' | 'approved' | 'rejected' | 'expired';

export interface LogActionParams {
  personaId: string;
  actionType: string;
  riskLevel: RiskLevel;
  decision: AuditDecision;
  payload: Record<string, unknown>;
  actorId?: string | null;
  approvalId?: string | null;
}

export interface GetAuditLogFilters {
  actionType?: string;
  decision?: AuditDecision;
  riskLevel?: RiskLevel;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a new audit log entry. This must never throw — audit logging
 * should not break the primary request path.
 */
export async function logAction(params: LogActionParams): Promise<void> {
  try {
    await db.insert(personaAuditLog).values({
      personaId: params.personaId,
      actionType: params.actionType,
      riskLevel: params.riskLevel,
      decision: params.decision,
      payload: params.payload,
      actorId: params.actorId ?? null,
      approvalId: params.approvalId ?? null,
    });
  } catch (error) {
    console.error('[persona-audit-log] Failed to write audit entry:', error);
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Query the persona audit log with optional filters and pagination.
 */
export async function getAuditLog(personaId: string, filters: GetAuditLogFilters = {}) {
  const effectiveLimit = Math.min(
    filters.limit ?? DEFAULT_QUERY_LIMIT,
    MAX_QUERY_LIMIT,
  );
  const effectiveOffset = filters.offset ?? 0;

  const conditions = [eq(personaAuditLog.personaId, personaId)];

  if (filters.actionType) {
    conditions.push(eq(personaAuditLog.actionType, filters.actionType));
  }
  if (filters.decision) {
    conditions.push(eq(personaAuditLog.decision, filters.decision));
  }
  if (filters.riskLevel) {
    conditions.push(eq(personaAuditLog.riskLevel, filters.riskLevel));
  }
  if (filters.startDate) {
    conditions.push(gte(personaAuditLog.createdAt, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(personaAuditLog.createdAt, filters.endDate));
  }

  const entries = await db
    .select()
    .from(personaAuditLog)
    .where(and(...conditions))
    .orderBy(desc(personaAuditLog.createdAt))
    .limit(effectiveLimit)
    .offset(effectiveOffset);

  return {
    entries,
    count: entries.length,
    limit: effectiveLimit,
    offset: effectiveOffset,
  };
}
