/**
 * Approval queue for persona actions that require human sign-off.
 *
 * Stores pending approvals in the `persona_action_approvals` table.
 * Provides functions to request, approve, reject, list, and expire approvals.
 *
 * Key exports:
 * - `requestApproval()` — enqueue a new action for approval
 * - `approveAction()` — approve a pending action
 * - `rejectAction()` — reject a pending action
 * - `listPendingApprovals()` — list pending approvals for a persona
 * - `expireStaleApprovals()` — expire approvals past their deadline
 * - `getApprovalById()` — fetch a single approval by ID
 */

import { db } from '@/db';
import { personaActionApprovals } from '@/db/schema';
import { eq, and, lte, desc } from 'drizzle-orm';
import type { RiskLevel } from './policy-engine';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default approval expiry window: 24 hours. */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

const MAX_PENDING_LIST = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface RequestApprovalParams {
  personaId: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  riskLevel: RiskLevel;
  expiresInMs?: number;
}

export interface ResolveApprovalParams {
  approvalId: string;
  resolvedBy: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Enqueue a new action for approval. Returns the created approval record.
 */
export async function requestApproval(params: RequestApprovalParams) {
  const expiresAt = new Date(Date.now() + (params.expiresInMs ?? DEFAULT_EXPIRY_MS));

  const [record] = await db
    .insert(personaActionApprovals)
    .values({
      personaId: params.personaId,
      actionType: params.actionType,
      actionPayload: params.actionPayload,
      riskLevel: params.riskLevel,
      status: 'pending',
      expiresAt,
    })
    .returning();

  return record;
}

/**
 * Approve a pending action. Sets status to 'approved' and records resolver.
 * Returns the updated record, or null if the approval was not found/not pending.
 */
export async function approveAction(params: ResolveApprovalParams) {
  const [record] = await db
    .update(personaActionApprovals)
    .set({
      status: 'approved',
      resolvedAt: new Date(),
      resolvedBy: params.resolvedBy,
      resolutionNote: params.note ?? null,
    })
    .where(
      and(
        eq(personaActionApprovals.id, params.approvalId),
        eq(personaActionApprovals.status, 'pending'),
      ),
    )
    .returning();

  return record ?? null;
}

/**
 * Reject a pending action. Sets status to 'rejected' and records resolver.
 * Returns the updated record, or null if the approval was not found/not pending.
 */
export async function rejectAction(params: ResolveApprovalParams) {
  const [record] = await db
    .update(personaActionApprovals)
    .set({
      status: 'rejected',
      resolvedAt: new Date(),
      resolvedBy: params.resolvedBy,
      resolutionNote: params.note ?? null,
    })
    .where(
      and(
        eq(personaActionApprovals.id, params.approvalId),
        eq(personaActionApprovals.status, 'pending'),
      ),
    )
    .returning();

  return record ?? null;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * List pending approvals for a persona, ordered newest first.
 */
export async function listPendingApprovals(personaId: string, limit?: number) {
  return db
    .select()
    .from(personaActionApprovals)
    .where(
      and(
        eq(personaActionApprovals.personaId, personaId),
        eq(personaActionApprovals.status, 'pending'),
      ),
    )
    .orderBy(desc(personaActionApprovals.requestedAt))
    .limit(Math.min(limit ?? MAX_PENDING_LIST, MAX_PENDING_LIST));
}

/**
 * Fetch a single approval by ID.
 */
export async function getApprovalById(approvalId: string) {
  const [record] = await db
    .select()
    .from(personaActionApprovals)
    .where(eq(personaActionApprovals.id, approvalId))
    .limit(1);

  return record ?? null;
}

// ---------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------

/**
 * Expire all pending approvals whose `expires_at` is in the past.
 * Returns the number of expired records.
 */
export async function expireStaleApprovals(): Promise<number> {
  const now = new Date();

  const expired = await db
    .update(personaActionApprovals)
    .set({
      status: 'expired',
      resolvedAt: now,
    })
    .where(
      and(
        eq(personaActionApprovals.status, 'pending'),
        lte(personaActionApprovals.expiresAt, now),
      ),
    )
    .returning({ id: personaActionApprovals.id });

  return expired.length;
}
