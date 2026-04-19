/**
 * POST /api/recovery/audit-reveal
 *
 * Purpose:
 * Record `reveal_succeeded` in the recovery-seed audit log once the client
 * has displayed the mnemonic to the user. The mnemonic itself is never
 * transmitted — only the reveal token (so the server knows which verified
 * challenge authorized the reveal).
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
} from '@/lib/http-status';
import { getClientIp } from '@/lib/client-ip';
import { consumeRecoveryRevealToken } from '@/lib/recovery-seed-mfa';
import { appendRecoverySeedAudit } from '@/lib/recovery-seed-audit';

export const dynamic = 'force-dynamic';

export interface RecoveryAuditRevealRequest {
  revealToken: string;
  /** What the client did with the mnemonic: 'displayed' | 'local_decrypted'. */
  source: 'displayed' | 'local_decrypted';
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: STATUS_UNAUTHORIZED });
  }
  if (getInstanceMode() !== INSTANCE_MODE_SOVEREIGN) {
    return NextResponse.json(
      { error: 'Recovery audit is sovereign-only.' },
      { status: STATUS_FORBIDDEN },
    );
  }

  let body: RecoveryAuditRevealRequest;
  try {
    body = (await request.json()) as RecoveryAuditRevealRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: STATUS_BAD_REQUEST });
  }

  if (!body.revealToken || (body.source !== 'displayed' && body.source !== 'local_decrypted')) {
    return NextResponse.json(
      { error: 'revealToken and source are required.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const agentId = session.user.id;
  const headersList = await headers();

  // peek:true means the reveal token can still be redeemed by rotate; we
  // only need to know it's valid in order to log an authentic reveal.
  const consumed = await consumeRecoveryRevealToken({
    agentId,
    revealToken: body.revealToken,
    peek: true,
  });
  if (!consumed.ok) {
    return NextResponse.json(
      { error: `Reveal token invalid: ${consumed.reason}` },
      { status: STATUS_BAD_REQUEST },
    );
  }

  await appendRecoverySeedAudit({
    agentId,
    eventKind: 'reveal_succeeded',
    method: consumed.method,
    outcome: body.source,
    ipAddress: getClientIp(headersList),
    userAgent: headersList.get('user-agent'),
  });

  return NextResponse.json({ ok: true }, { status: STATUS_OK });
}
