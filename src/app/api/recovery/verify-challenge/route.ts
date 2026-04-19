/**
 * POST /api/recovery/verify-challenge
 *
 * Purpose:
 * Verify a code the user was sent by `/api/recovery/challenge` and, on
 * success, hand back a short-lived `revealToken` that `/api/recovery/rotate`
 * (and client-side reveal) require.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#13.
 */

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { INSTANCE_MODE_SOVEREIGN, getInstanceMode } from '@/lib/instance-mode';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_TOO_MANY_REQUESTS,
} from '@/lib/http-status';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import {
  RECOVERY_MFA_MAX_VERIFY_ATTEMPTS,
  RECOVERY_MFA_REVEAL_WINDOW_MS,
  verifyRecoveryMfaChallenge,
} from '@/lib/recovery-seed-mfa';
import { appendRecoverySeedAudit } from '@/lib/recovery-seed-audit';

export const dynamic = 'force-dynamic';

/** Verify attempts per (ip + user) per 15-min window across ALL challenges. */
const VERIFY_RATE_LIMIT = 15;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export interface RecoveryVerifyChallengeRequest {
  challengeId: string;
  code: string;
}

export interface RecoveryVerifyChallengeSuccess {
  ok: true;
  revealToken: string;
  revealTokenExpiresAt: string;
  revealWindowMs: number;
  method: 'email' | 'sms';
}

export interface RecoveryVerifyChallengeFailure {
  ok: false;
  error:
    | 'unauthorized'
    | 'not_sovereign'
    | 'invalid_body'
    | 'rate_limited'
    | 'incorrect_code'
    | 'attempts_exhausted'
    | 'expired'
    | 'already_used'
    | 'not_found';
  message: string;
  attemptsRemaining?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
}

function errorResponse(
  error: RecoveryVerifyChallengeFailure['error'],
  message: string,
  status: number,
  extras: Partial<RecoveryVerifyChallengeFailure> = {},
): NextResponse<RecoveryVerifyChallengeFailure> {
  return NextResponse.json({ ok: false, error, message, ...extras }, { status });
}

export async function POST(
  request: Request,
): Promise<NextResponse<RecoveryVerifyChallengeSuccess | RecoveryVerifyChallengeFailure>> {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('unauthorized', 'Sign in to verify a challenge.', STATUS_UNAUTHORIZED);
  }
  if (getInstanceMode() !== INSTANCE_MODE_SOVEREIGN) {
    return errorResponse('not_sovereign', 'Recovery verification is sovereign-only.', STATUS_FORBIDDEN);
  }

  let body: RecoveryVerifyChallengeRequest;
  try {
    body = (await request.json()) as RecoveryVerifyChallengeRequest;
  } catch {
    return errorResponse('invalid_body', 'Request body must be valid JSON.', STATUS_BAD_REQUEST);
  }
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!challengeId || !code) {
    return errorResponse('invalid_body', 'challengeId and code are required.', STATUS_BAD_REQUEST);
  }

  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const userAgent = headersList.get('user-agent') ?? null;
  const agentId = session.user.id;

  const limiter = await rateLimit(
    `recovery_verify:${clientIp}:${agentId}`,
    VERIFY_RATE_LIMIT,
    VERIFY_WINDOW_MS,
  );
  if (!limiter.success) {
    await appendRecoverySeedAudit({
      agentId,
      eventKind: 'challenge_failed',
      outcome: 'rate_limited',
      ipAddress: clientIp,
      userAgent,
    });
    return errorResponse(
      'rate_limited',
      'Too many verification attempts. Try again later.',
      STATUS_TOO_MANY_REQUESTS,
      { retryAfterMs: limiter.resetMs },
    );
  }

  const result = await verifyRecoveryMfaChallenge({ agentId, challengeId, code });
  if (result.ok) {
    await appendRecoverySeedAudit({
      agentId,
      eventKind: 'challenge_verified',
      method: result.method,
      outcome: 'success',
      ipAddress: clientIp,
      userAgent,
      metadata: { challengeId },
    });
    return NextResponse.json(
      {
        ok: true,
        revealToken: result.revealToken,
        revealTokenExpiresAt: result.revealTokenExpiresAt,
        revealWindowMs: RECOVERY_MFA_REVEAL_WINDOW_MS,
        method: result.method,
      },
      { status: STATUS_OK },
    );
  }

  await appendRecoverySeedAudit({
    agentId,
    eventKind: 'challenge_failed',
    outcome: result.reason,
    ipAddress: clientIp,
    userAgent,
    metadata: {
      challengeId,
      attemptsRemaining: result.attemptsRemaining,
    },
  });

  const messages: Record<typeof result.reason, string> = {
    not_found: 'Challenge not found or already used.',
    expired: 'Challenge has expired — request a new code.',
    already_used: 'Challenge has already been used.',
    incorrect_code: 'Incorrect code.',
    attempts_exhausted: 'Too many incorrect attempts. Request a new code.',
  };

  return errorResponse(result.reason, messages[result.reason], STATUS_BAD_REQUEST, {
    attemptsRemaining: result.attemptsRemaining,
    maxAttempts: RECOVERY_MFA_MAX_VERIFY_ATTEMPTS,
  });
}
