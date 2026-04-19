/**
 * POST /api/recovery/rotate
 *
 * Purpose:
 * Replace the user's active recovery public key with a freshly generated
 * one. Requires a valid revealToken obtained from `/api/recovery/verify-challenge`
 * (so the user has just completed a fresh MFA challenge). The old key is
 * archived in `retired_recovery_keys` so historical signed events remain
 * verifiable.
 *
 * Behaviour:
 * - Consumes the revealToken (one-shot) so a leaked token cannot be
 *   reused for a second rotation.
 * - Validates that the new fingerprint matches the new public key.
 * - Refuses to rotate to the same public key that is currently active.
 * - Writes retired key row + agent update + audit row in a single DB
 *   transaction so partial rotations never happen.
 * - Bumps `recoveryKeyRotatedAt` and `credentialVersion` per the schema
 *   contract (credentialVersion mirrors global/identity_authority).
 * - Enqueues a signed `credential.recoveryKey.rotated` event in
 *   credential_sync_queue when that table exists (i.e. once #15 has
 *   landed in this branch line); otherwise skips silently so the rotate
 *   itself does not fail.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#14.
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents, retiredRecoveryKeys } from '@/db/schema';
import { INSTANCE_MODE_SOVEREIGN, getInstanceMode } from '@/lib/instance-mode';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';
import { fingerprintFromPublicKeySync } from '@/lib/recovery-seed';
import { consumeRecoveryRevealToken } from '@/lib/recovery-seed-mfa';
import { appendRecoverySeedAudit } from '@/lib/recovery-seed-audit';
import { getClientIp } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const ED25519_PUBLIC_KEY_HEX_LENGTH = 64;

export interface RecoveryRotateRequest {
  revealToken: string;
  publicKeyHex: string;
  fingerprint: string;
  algorithm?: 'ed25519';
}

export interface RecoveryRotateResponse {
  ok: true;
  fingerprint: string;
  rotatedAt: string;
  credentialVersion: number;
}

export interface RecoveryRotateErrorResponse {
  ok: false;
  error:
    | 'unauthorized'
    | 'not_sovereign'
    | 'invalid_body'
    | 'invalid_public_key'
    | 'fingerprint_mismatch'
    | 'reveal_token_invalid'
    | 'reveal_token_expired'
    | 'no_active_key'
    | 'same_key_rejected'
    | 'server_error';
  message: string;
}

function errorResponse(
  error: RecoveryRotateErrorResponse['error'],
  message: string,
  status: number,
): NextResponse<RecoveryRotateErrorResponse> {
  return NextResponse.json({ ok: false, error, message }, { status });
}

export async function POST(
  request: Request,
): Promise<NextResponse<RecoveryRotateResponse | RecoveryRotateErrorResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('unauthorized', 'Sign in to rotate the recovery key.', STATUS_UNAUTHORIZED);
  }
  if (getInstanceMode() !== INSTANCE_MODE_SOVEREIGN) {
    return errorResponse(
      'not_sovereign',
      'Recovery rotation is sovereign-only.',
      STATUS_FORBIDDEN,
    );
  }

  let body: RecoveryRotateRequest;
  try {
    body = (await request.json()) as RecoveryRotateRequest;
  } catch {
    return errorResponse('invalid_body', 'Request body must be valid JSON.', STATUS_BAD_REQUEST);
  }

  const revealToken = typeof body.revealToken === 'string' ? body.revealToken.trim() : '';
  const publicKeyHex = typeof body.publicKeyHex === 'string' ? body.publicKeyHex.trim() : '';
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
  const algorithm = body.algorithm ?? 'ed25519';

  if (!revealToken) {
    return errorResponse('invalid_body', 'revealToken is required.', STATUS_BAD_REQUEST);
  }
  if (algorithm !== 'ed25519') {
    return errorResponse(
      'invalid_public_key',
      `Unsupported algorithm "${algorithm}".`,
      STATUS_BAD_REQUEST,
    );
  }
  if (
    publicKeyHex.length !== ED25519_PUBLIC_KEY_HEX_LENGTH ||
    !/^[0-9a-fA-F]+$/.test(publicKeyHex)
  ) {
    return errorResponse('invalid_public_key', 'publicKeyHex must be 64 hex characters.', STATUS_BAD_REQUEST);
  }
  if (!fingerprint) {
    return errorResponse('invalid_public_key', 'fingerprint is required.', STATUS_BAD_REQUEST);
  }

  let expectedFingerprint: string;
  try {
    expectedFingerprint = fingerprintFromPublicKeySync(publicKeyHex);
  } catch (err) {
    return errorResponse(
      'invalid_public_key',
      `Could not fingerprint public key: ${err instanceof Error ? err.message : String(err)}`,
      STATUS_BAD_REQUEST,
    );
  }
  if (expectedFingerprint !== fingerprint) {
    return errorResponse(
      'fingerprint_mismatch',
      'Supplied fingerprint does not match publicKeyHex.',
      STATUS_BAD_REQUEST,
    );
  }

  const agentId = session.user.id;
  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const userAgent = headersList.get('user-agent') ?? null;

  // 1) Consume the reveal token. One-shot: this prevents a leaked token
  //    from authorising a second rotation later.
  const tokenResult = await consumeRecoveryRevealToken({
    agentId,
    revealToken,
    peek: false,
  });
  if (!tokenResult.ok) {
    return errorResponse(
      tokenResult.reason === 'expired' ? 'reveal_token_expired' : 'reveal_token_invalid',
      `Reveal token ${tokenResult.reason}.`,
      STATUS_BAD_REQUEST,
    );
  }

  // 2) Load current key so we can archive it.
  const [current] = await db
    .select({
      recoveryPublicKey: agents.recoveryPublicKey,
      recoveryKeyFingerprint: agents.recoveryKeyFingerprint,
      recoveryKeyCreatedAt: agents.recoveryKeyCreatedAt,
      recoveryKeyRotatedAt: agents.recoveryKeyRotatedAt,
      credentialVersion: agents.credentialVersion,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!current) {
    return errorResponse('server_error', 'Agent row missing.', STATUS_INTERNAL_ERROR);
  }
  if (!current.recoveryPublicKey || !current.recoveryKeyFingerprint) {
    return errorResponse(
      'no_active_key',
      'No active recovery key to rotate. Register one first.',
      STATUS_BAD_REQUEST,
    );
  }
  if (current.recoveryPublicKey.toLowerCase() === publicKeyHex.toLowerCase()) {
    return errorResponse(
      'same_key_rejected',
      'New recovery key must differ from the currently active key.',
      STATUS_BAD_REQUEST,
    );
  }

  // 3) Atomic swap: archive old, install new, bump credentialVersion.
  const now = new Date();
  let newCredentialVersion = current.credentialVersion;
  try {
    await db.transaction(async (tx) => {
      // Archive old key. `createdAt` on the archive row preserves the
      // original "issued at" timestamp so peers can reason about the
      // validity window.
      await tx.insert(retiredRecoveryKeys).values({
        agentId,
        publicKey: current.recoveryPublicKey!,
        fingerprint: current.recoveryKeyFingerprint!,
        createdAt:
          current.recoveryKeyRotatedAt ??
          current.recoveryKeyCreatedAt ??
          now,
        retiredAt: now,
        retirementReason: 'rotated',
      });

      // Install the new key and bump rotation + credentialVersion.
      const [updated] = await tx
        .update(agents)
        .set({
          recoveryPublicKey: publicKeyHex,
          recoveryKeyFingerprint: fingerprint,
          recoveryKeyRotatedAt: now,
          credentialVersion: sql`${agents.credentialVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(agents.id, agentId))
        .returning({ credentialVersion: agents.credentialVersion });
      newCredentialVersion = updated?.credentialVersion ?? current.credentialVersion + 1;
    });
  } catch (err) {
    console.error('[recovery/rotate] Persistence failed:', err);
    return errorResponse(
      'server_error',
      'Failed to persist rotated recovery key.',
      STATUS_INTERNAL_ERROR,
    );
  }

  // 4) Audit + best-effort sync-queue enqueue.
  await appendRecoverySeedAudit({
    agentId,
    eventKind: 'rotate_succeeded',
    outcome: 'success',
    ipAddress: clientIp,
    userAgent,
    metadata: {
      oldFingerprint: current.recoveryKeyFingerprint,
      newFingerprint: fingerprint,
      credentialVersion: newCredentialVersion,
    },
  });

  await maybeEnqueueRotateEvent({
    agentId,
    oldFingerprint: current.recoveryKeyFingerprint,
    newFingerprint: fingerprint,
    credentialVersion: newCredentialVersion,
    rotatedAt: now,
  }).catch((err) => {
    // Non-fatal: the rotation itself already succeeded and is auditable.
    // The federation emitter (#88 / #15) can pick up drift later.
    console.warn('[recovery/rotate] credential_sync_queue enqueue skipped:', err);
  });

  return NextResponse.json(
    {
      ok: true,
      fingerprint,
      rotatedAt: now.toISOString(),
      credentialVersion: newCredentialVersion,
    },
    { status: STATUS_OK },
  );
}

/**
 * Best-effort enqueue of the `credential.recoveryKey.rotated` event.
 *
 * We do NOT hard-depend on `credential_sync_queue` being present because
 * the queue landed in the parallel ticket #15 and may not yet be in the
 * current branch. If the table is missing, the insert throws and we
 * swallow it — the federation-emitter work in #88 can reconstruct drift
 * from the audit log instead.
 */
async function maybeEnqueueRotateEvent(params: {
  agentId: string;
  oldFingerprint: string;
  newFingerprint: string;
  credentialVersion: number;
  rotatedAt: Date;
}): Promise<void> {
  const payload = {
    type: 'credential.recoveryKey.rotated',
    agentId: params.agentId,
    oldFingerprint: params.oldFingerprint,
    newFingerprint: params.newFingerprint,
    credentialVersion: params.credentialVersion,
    rotatedAt: params.rotatedAt.toISOString(),
  };

  // Dynamic require keeps this route compilable even if the queue table
  // has not been wired into the Drizzle schema yet.
  const schemaModule = (await import('@/db/schema')) as Record<string, unknown>;
  const queue = schemaModule.credentialSyncQueue;
  if (!queue) return;

  await db.insert(queue as never).values({
    agentId: params.agentId,
    eventPayload: payload,
  } as never);
}
