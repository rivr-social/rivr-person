/**
 * POST /api/recovery/challenge
 *
 * Purpose:
 * Issue a single-use MFA code for the authenticated user, delivered via
 * email or (stubbed) SMS. Gates the reveal and rotate flows by requiring a
 * *fresh* verification, not long-lived session trust.
 *
 * Behaviour:
 * - Requires an authenticated session.
 * - Requires sovereign instance mode (hosted-federated never sees seeds).
 * - Rate-limits aggressively: 5 challenge requests per 15 minutes per IP+user.
 * - Invalidates any previously-unspent challenges for the same user so
 *   only one code is ever live at a time.
 * - Audits `challenge_issued` regardless of success; failures also audit.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#13.
 * - HANDOFF 2026-04-19 Cameron's Clarifications #2 ("fresh MFA, not session trust").
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { INSTANCE_MODE_SOVEREIGN, getInstanceMode } from '@/lib/instance-mode';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import {
  RECOVERY_MFA_CODE_TTL_MS,
  RecoveryMfaNotConfiguredError,
  issueRecoveryMfaChallenge,
} from '@/lib/recovery-seed-mfa';
import { appendRecoverySeedAudit } from '@/lib/recovery-seed-audit';

export const dynamic = 'force-dynamic';

/** Max challenges per (ip + user) per window. Keeps SMS/email bills bounded. */
const CHALLENGE_RATE_LIMIT = 5;
/** Rate-limit window: 15 minutes. */
const CHALLENGE_WINDOW_MS = 15 * 60 * 1000;

export interface RecoveryChallengeRequest {
  method: 'email' | 'sms';
}

export interface RecoveryChallengeResponse {
  ok: true;
  challengeId: string;
  method: 'email' | 'sms';
  expiresAt: string;
  codeTtlMs: number;
}

export interface RecoveryChallengeErrorResponse {
  ok: false;
  error:
    | 'unauthorized'
    | 'not_sovereign'
    | 'invalid_body'
    | 'no_recovery_key'
    | 'missing_delivery_address'
    | 'channel_unavailable'
    | 'rate_limited'
    | 'server_error';
  message: string;
  retryAfterMs?: number;
}

function errorResponse(
  error: RecoveryChallengeErrorResponse['error'],
  message: string,
  status: number,
  extras: Partial<RecoveryChallengeErrorResponse> = {},
): NextResponse<RecoveryChallengeErrorResponse> {
  return NextResponse.json({ ok: false, error, message, ...extras }, { status });
}

export async function POST(
  request: Request,
): Promise<NextResponse<RecoveryChallengeResponse | RecoveryChallengeErrorResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('unauthorized', 'Sign in to request a challenge.', STATUS_UNAUTHORIZED);
  }

  if (getInstanceMode() !== INSTANCE_MODE_SOVEREIGN) {
    return errorResponse(
      'not_sovereign',
      'This deployment is hosted-federated; recovery seeds are not issued here.',
      STATUS_FORBIDDEN,
    );
  }

  let body: RecoveryChallengeRequest;
  try {
    body = (await request.json()) as RecoveryChallengeRequest;
  } catch {
    return errorResponse('invalid_body', 'Request body must be valid JSON.', STATUS_BAD_REQUEST);
  }
  if (body.method !== 'email' && body.method !== 'sms') {
    return errorResponse(
      'invalid_body',
      'method must be "email" or "sms".',
      STATUS_BAD_REQUEST,
    );
  }

  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const userAgent = headersList.get('user-agent') ?? null;
  const agentId = session.user.id;

  // Rate limit per IP+user so a compromised session cannot spam codes.
  const limiter = await rateLimit(
    `recovery_challenge:${clientIp}:${agentId}`,
    CHALLENGE_RATE_LIMIT,
    CHALLENGE_WINDOW_MS,
  );
  if (!limiter.success) {
    await appendRecoverySeedAudit({
      agentId,
      eventKind: 'challenge_failed',
      method: body.method,
      outcome: 'rate_limited',
      ipAddress: clientIp,
      userAgent,
    });
    return errorResponse(
      'rate_limited',
      'Too many challenge requests. Try again shortly.',
      STATUS_TOO_MANY_REQUESTS,
      { retryAfterMs: limiter.resetMs },
    );
  }

  const [agent] = await db
    .select({
      id: agents.id,
      email: agents.email,
      phoneNumber: agents.phoneNumber,
      recoveryPublicKey: agents.recoveryPublicKey,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) {
    return errorResponse('server_error', 'Agent row missing.', STATUS_INTERNAL_ERROR);
  }
  if (!agent.recoveryPublicKey) {
    return errorResponse(
      'no_recovery_key',
      'No recovery key is registered yet. Complete signup first.',
      STATUS_BAD_REQUEST,
    );
  }

  const recipient = body.method === 'email' ? agent.email : agent.phoneNumber;
  if (!recipient) {
    return errorResponse(
      'missing_delivery_address',
      body.method === 'email'
        ? 'No email address on file.'
        : 'No phone number on file.',
      STATUS_BAD_REQUEST,
    );
  }

  try {
    const issued = await issueRecoveryMfaChallenge({
      agentId,
      method: body.method,
      recipient,
    });

    await appendRecoverySeedAudit({
      agentId,
      eventKind: 'challenge_issued',
      method: body.method,
      outcome: 'sent',
      ipAddress: clientIp,
      userAgent,
      metadata: { challengeId: issued.challengeId },
    });

    return NextResponse.json(
      {
        ok: true,
        challengeId: issued.challengeId,
        method: issued.method,
        expiresAt: issued.expiresAt,
        codeTtlMs: RECOVERY_MFA_CODE_TTL_MS,
      },
      { status: STATUS_OK },
    );
  } catch (err) {
    const isUnconfigured = err instanceof RecoveryMfaNotConfiguredError;
    await appendRecoverySeedAudit({
      agentId,
      eventKind: 'challenge_failed',
      method: body.method,
      outcome: isUnconfigured ? 'channel_unavailable' : 'delivery_error',
      ipAddress: clientIp,
      userAgent,
    });
    if (isUnconfigured) {
      return errorResponse(
        'channel_unavailable',
        err.message,
        STATUS_BAD_REQUEST,
      );
    }
    console.error('[recovery/challenge] delivery failed:', err);
    return errorResponse(
      'server_error',
      'Failed to issue challenge.',
      STATUS_INTERNAL_ERROR,
    );
  }
}
