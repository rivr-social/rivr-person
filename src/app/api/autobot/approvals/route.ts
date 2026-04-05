/**
 * GET /api/autobot/approvals — list pending approvals for a persona
 * POST /api/autobot/approvals — create an approval request (internal use)
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isPersonaOf } from '@/lib/persona';
import { listPendingApprovals, requestApproval } from '@/lib/autobot/approval-queue';
import { getActionRiskLevel } from '@/lib/autobot/policy-engine';
import type { RiskLevel } from '@/lib/autobot/policy-engine';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_RISK_LEVELS: readonly string[] = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// GET — list pending approvals
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const personaId = url.searchParams.get('personaId')?.trim();

  if (!personaId) {
    return NextResponse.json(
      { error: 'personaId query parameter is required' },
      { status: 400 },
    );
  }

  // Verify persona ownership
  const owned = await isPersonaOf(personaId, session.user.id).catch(() => false);
  if (!owned) {
    return NextResponse.json(
      { error: 'Persona not found or not owned by you' },
      { status: 403 },
    );
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 100) : 50;

  const approvals = await listPendingApprovals(personaId, limit);

  return NextResponse.json({
    success: true,
    approvals,
    count: approvals.length,
  });
}

// ---------------------------------------------------------------------------
// POST — create approval request
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const personaId = typeof body.personaId === 'string' ? body.personaId.trim() : '';
  const actionType = typeof body.actionType === 'string' ? body.actionType.trim() : '';
  const actionPayload =
    body.actionPayload && typeof body.actionPayload === 'object' && !Array.isArray(body.actionPayload)
      ? (body.actionPayload as Record<string, unknown>)
      : {};

  if (!personaId || !actionType) {
    return NextResponse.json(
      { error: 'personaId and actionType are required' },
      { status: 400 },
    );
  }

  // Verify persona ownership
  const owned = await isPersonaOf(personaId, session.user.id).catch(() => false);
  if (!owned) {
    return NextResponse.json(
      { error: 'Persona not found or not owned by you' },
      { status: 403 },
    );
  }

  const rawRiskLevel = typeof body.riskLevel === 'string' ? body.riskLevel : '';
  const riskLevel: RiskLevel = VALID_RISK_LEVELS.includes(rawRiskLevel)
    ? (rawRiskLevel as RiskLevel)
    : getActionRiskLevel(actionType);

  const approval = await requestApproval({
    personaId,
    actionType,
    actionPayload,
    riskLevel,
  });

  return NextResponse.json({ success: true, approval }, { status: 201 });
}
