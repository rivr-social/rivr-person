/**
 * POST /api/recovery/register
 *
 * Purpose:
 * Record the public half of the recovery keypair the user just generated
 * client-side at signup. The server MUST NEVER see the mnemonic or private
 * key — this route accepts only `publicKeyHex` and `fingerprint`.
 *
 * Gate:
 * - Caller must be authenticated (session cookie).
 * - Instance must be running in sovereign mode (`RIVR_INSTANCE_MODE=sovereign`).
 *   Hosted-federated deployments do not issue recovery seeds.
 *
 * Behaviour:
 * - Refuses to overwrite an existing recovery key unless explicitly
 *   rotating (see `/api/recovery/rotate`). Clients that need to change the
 *   key must use the rotate flow so the old key is archived correctly.
 * - Validates that `fingerprint` matches `sha256(publicKey).slice(0,8)` in
 *   base58btc so a malicious client cannot register a fingerprint that
 *   does not correspond to its public key.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#12.
 * - HANDOFF 2026-04-19 "Recovery Plan" section 1.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import {
  INSTANCE_MODE_SOVEREIGN,
  getInstanceMode,
} from '@/lib/instance-mode';
import { fingerprintFromPublicKeySync } from '@/lib/recovery-seed';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';

export const dynamic = 'force-dynamic';

/**
 * Maximum length of a hex-encoded Ed25519 public key. Exactly 32 bytes →
 * 64 hex chars. Defensive upper bound to stop payload-size abuse.
 */
const MAX_PUBLIC_KEY_HEX_LENGTH = 64;

/**
 * Expected length of an Ed25519 public key in hex characters (64 = 32
 * bytes). Declared as a constant so tests can depend on it rather than a
 * magic number.
 */
const ED25519_PUBLIC_KEY_HEX_LENGTH = 64;

export interface RecoveryRegisterRequest {
  publicKeyHex: string;
  fingerprint: string;
  /**
   * Optional algorithm label. Accepts only `ed25519` today; anything else
   * is rejected so future algorithms must land with a deliberate schema
   * change rather than silently switching curves.
   */
  algorithm?: 'ed25519';
}

export interface RecoveryRegisterResponse {
  ok: true;
  fingerprint: string;
  createdAt: string;
}

export interface RecoveryRegisterErrorResponse {
  ok: false;
  error:
    | 'unauthorized'
    | 'not_sovereign'
    | 'invalid_body'
    | 'invalid_public_key'
    | 'fingerprint_mismatch'
    | 'already_registered'
    | 'server_error';
  message: string;
}

function errorResponse(
  error: RecoveryRegisterErrorResponse['error'],
  message: string,
  status: number,
): NextResponse<RecoveryRegisterErrorResponse> {
  return NextResponse.json({ ok: false, error, message }, { status });
}

export async function POST(
  request: Request,
): Promise<NextResponse<RecoveryRegisterResponse | RecoveryRegisterErrorResponse>> {
  // 1) AuthN.
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse('unauthorized', 'Sign in to register a recovery key.', STATUS_UNAUTHORIZED);
  }

  // 2) Instance-mode gate. Hosted-federated deployments do not issue seeds.
  if (getInstanceMode() !== INSTANCE_MODE_SOVEREIGN) {
    return errorResponse(
      'not_sovereign',
      'This deployment is hosted-federated; recovery seeds are not issued here.',
      STATUS_FORBIDDEN,
    );
  }

  // 3) Body parse + schema validation (intentionally hand-rolled — no Zod
  //    dependency needed for 3 fields, and the validation is security-critical
  //    so every branch is explicit).
  let body: RecoveryRegisterRequest;
  try {
    body = (await request.json()) as RecoveryRegisterRequest;
  } catch {
    return errorResponse('invalid_body', 'Request body must be valid JSON.', STATUS_BAD_REQUEST);
  }

  const publicKeyHex = typeof body.publicKeyHex === 'string' ? body.publicKeyHex.trim() : '';
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
  const algorithm = body.algorithm ?? 'ed25519';

  if (algorithm !== 'ed25519') {
    return errorResponse(
      'invalid_public_key',
      `Unsupported algorithm "${algorithm}". Only "ed25519" is accepted today.`,
      STATUS_BAD_REQUEST,
    );
  }

  if (!publicKeyHex || publicKeyHex.length > MAX_PUBLIC_KEY_HEX_LENGTH) {
    return errorResponse('invalid_public_key', 'publicKeyHex is required.', STATUS_BAD_REQUEST);
  }
  if (publicKeyHex.length !== ED25519_PUBLIC_KEY_HEX_LENGTH) {
    return errorResponse(
      'invalid_public_key',
      `publicKeyHex must be ${ED25519_PUBLIC_KEY_HEX_LENGTH} hex characters (32 bytes).`,
      STATUS_BAD_REQUEST,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(publicKeyHex)) {
    return errorResponse(
      'invalid_public_key',
      'publicKeyHex contains non-hex characters.',
      STATUS_BAD_REQUEST,
    );
  }
  if (!fingerprint) {
    return errorResponse('invalid_public_key', 'fingerprint is required.', STATUS_BAD_REQUEST);
  }

  // 4) Verify fingerprint matches the claimed public key. Prevents a
  //    client from sending a fingerprint unrelated to the public key.
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

  // 5) Refuse to overwrite an existing registration. Rotation has its
  //    own dedicated route that archives the old key first.
  const agentId = session.user.id;
  const [existing] = await db
    .select({
      recoveryPublicKey: agents.recoveryPublicKey,
      recoveryKeyFingerprint: agents.recoveryKeyFingerprint,
      recoveryKeyCreatedAt: agents.recoveryKeyCreatedAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!existing) {
    return errorResponse('server_error', 'Signed-in agent not found.', STATUS_INTERNAL_ERROR);
  }
  if (existing.recoveryPublicKey || existing.recoveryKeyFingerprint) {
    return errorResponse(
      'already_registered',
      'A recovery key is already registered for this account. Use rotate instead.',
      STATUS_BAD_REQUEST,
    );
  }

  // 6) Persist. Only the public half and its fingerprint reach the DB.
  const now = new Date();
  try {
    await db
      .update(agents)
      .set({
        recoveryPublicKey: publicKeyHex,
        recoveryKeyFingerprint: fingerprint,
        recoveryKeyCreatedAt: now,
        // Ensure the agent row is marked sovereign. Signup of a sovereign
        // user without instance_mode set means the row predates classification.
        instanceMode: INSTANCE_MODE_SOVEREIGN,
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));
  } catch (err) {
    console.error('[recovery/register] Persistence failed:', err);
    return errorResponse(
      'server_error',
      'Failed to persist recovery public key.',
      STATUS_INTERNAL_ERROR,
    );
  }

  return NextResponse.json(
    { ok: true, fingerprint, createdAt: now.toISOString() },
    { status: STATUS_OK },
  );
}
