/**
 * GET /api/recovery/status
 *
 * Purpose:
 * Tell an authenticated client whether a recovery key is already registered
 * for their agent, and (if so) when it was created and last rotated. Used
 * by:
 *
 * - The signup flow, to skip the recovery-seed step for users who already
 *   set one up on a previous device.
 * - The Settings > Security card, to decide whether to show
 *   "Generate seed" vs "Reveal seed" + "Rotate seed".
 *
 * Does NOT return the public key or fingerprint to bystanders: only the
 * authenticated owner sees their own state.
 *
 * References:
 * - GitHub issue rivr-social/rivr-person#12, #13, #14.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import {
  INSTANCE_MODE_SOVEREIGN,
  getInstanceMode,
  type InstanceMode,
} from '@/lib/instance-mode';
import { STATUS_OK, STATUS_UNAUTHORIZED } from '@/lib/http-status';

export const dynamic = 'force-dynamic';

export interface RecoveryStatusResponse {
  instanceMode: InstanceMode;
  /** True iff a recovery public key is on file for the signed-in agent. */
  registered: boolean;
  /** Copy-safe base58 fingerprint (owner-only). */
  fingerprint: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  /** Convenience: true when UI should render seed components. */
  sovereignMode: boolean;
}

export async function GET(): Promise<NextResponse<RecoveryStatusResponse | { error: string }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: STATUS_UNAUTHORIZED });
  }

  const instanceMode = getInstanceMode();
  const sovereignMode = instanceMode === INSTANCE_MODE_SOVEREIGN;

  const [row] = await db
    .select({
      fingerprint: agents.recoveryKeyFingerprint,
      createdAt: agents.recoveryKeyCreatedAt,
      rotatedAt: agents.recoveryKeyRotatedAt,
      publicKey: agents.recoveryPublicKey,
    })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  const registered = !!(row?.publicKey && row?.fingerprint);

  return NextResponse.json(
    {
      instanceMode,
      sovereignMode,
      registered,
      fingerprint: row?.fingerprint ?? null,
      createdAt: row?.createdAt ? row.createdAt.toISOString() : null,
      rotatedAt: row?.rotatedAt ? row.rotatedAt.toISOString() : null,
    },
    { status: STATUS_OK },
  );
}
