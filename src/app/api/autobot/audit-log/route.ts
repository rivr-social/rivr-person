/**
 * GET /api/autobot/audit-log — paginated persona audit log with filters
 *
 * Query params:
 *   personaId (required)
 *   actionType, decision, riskLevel — optional filters
 *   startDate, endDate — ISO date strings
 *   limit, offset — pagination
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isPersonaOf } from '@/lib/persona';
import { getAuditLog, type AuditDecision, type GetAuditLogFilters } from '@/lib/autobot/audit-log';
import type { RiskLevel } from '@/lib/autobot/policy-engine';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_DECISIONS: readonly string[] = ['auto_allowed', 'approved', 'rejected', 'expired'];
const VALID_RISK_LEVELS: readonly string[] = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// GET handler
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

  const filters: GetAuditLogFilters = {};

  const actionType = url.searchParams.get('actionType')?.trim();
  if (actionType) filters.actionType = actionType;

  const decision = url.searchParams.get('decision')?.trim();
  if (decision && VALID_DECISIONS.includes(decision)) {
    filters.decision = decision as AuditDecision;
  }

  const riskLevel = url.searchParams.get('riskLevel')?.trim();
  if (riskLevel && VALID_RISK_LEVELS.includes(riskLevel)) {
    filters.riskLevel = riskLevel as RiskLevel;
  }

  const startDate = url.searchParams.get('startDate')?.trim();
  if (startDate) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) filters.startDate = parsed;
  }

  const endDate = url.searchParams.get('endDate')?.trim();
  if (endDate) {
    const parsed = new Date(endDate);
    if (!isNaN(parsed.getTime())) filters.endDate = parsed;
  }

  const limitParam = url.searchParams.get('limit');
  if (limitParam) filters.limit = parseInt(limitParam, 10) || undefined;

  const offsetParam = url.searchParams.get('offset');
  if (offsetParam) filters.offset = parseInt(offsetParam, 10) || undefined;

  const result = await getAuditLog(personaId, filters);

  return NextResponse.json({ success: true, ...result });
}
