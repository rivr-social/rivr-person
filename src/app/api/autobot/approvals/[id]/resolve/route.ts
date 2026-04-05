/**
 * POST /api/autobot/approvals/[id]/resolve — approve or reject a pending action
 *
 * Body: { action: 'approve' | 'reject', note?: string }
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isPersonaOf } from '@/lib/persona';
import {
  getApprovalById,
  approveAction,
  rejectAction,
} from '@/lib/autobot/approval-queue';
import { logAction, type AuditDecision } from '@/lib/autobot/audit-log';
import type { RiskLevel } from '@/lib/autobot/policy-engine';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ACTIONS = ['approve', 'reject'] as const;
type ResolveAction = (typeof VALID_ACTIONS)[number];

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: approvalId } = await params;

  if (!approvalId) {
    return NextResponse.json({ error: 'Approval ID is required' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!VALID_ACTIONS.includes(action as ResolveAction)) {
    return NextResponse.json(
      { error: 'action must be "approve" or "reject"' },
      { status: 400 },
    );
  }

  const note = typeof body.note === 'string' ? body.note.trim() : undefined;

  // Fetch the approval and verify ownership
  const existing = await getApprovalById(approvalId);
  if (!existing) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  }

  if (existing.status !== 'pending') {
    return NextResponse.json(
      { error: `Approval is already ${existing.status}` },
      { status: 409 },
    );
  }

  // Verify persona ownership
  const owned = await isPersonaOf(existing.personaId, session.user.id).catch(() => false);
  if (!owned) {
    return NextResponse.json(
      { error: 'Persona not found or not owned by you' },
      { status: 403 },
    );
  }

  const resolveParams = {
    approvalId,
    resolvedBy: session.user.id,
    note,
  };

  const record =
    action === 'approve'
      ? await approveAction(resolveParams)
      : await rejectAction(resolveParams);

  if (!record) {
    return NextResponse.json(
      { error: 'Approval could not be resolved — it may have already been processed' },
      { status: 409 },
    );
  }

  // Write audit log entry
  const decision: AuditDecision = action === 'approve' ? 'approved' : 'rejected';
  logAction({
    personaId: existing.personaId,
    actionType: existing.actionType,
    riskLevel: existing.riskLevel as RiskLevel,
    decision,
    payload: (existing.actionPayload ?? {}) as Record<string, unknown>,
    actorId: session.user.id,
    approvalId,
  }).catch(() => {});

  return NextResponse.json({ success: true, approval: record });
}
