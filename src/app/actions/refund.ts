'use server';

import { getSession } from '@/lib/auth/get-session';
import { db } from '@/db';
import { resources, ledger, type NewLedgerEntry } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { submitGlobalRefund } from '@/lib/global-refund';
import { headers } from 'next/headers';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Requests a refund for a receipt. The buyer must own the receipt.
 * Creates a Stripe refund and updates the receipt status.
 */
export async function requestRefundAction(receiptId: string): Promise<{ success: boolean; error?: string }> {
  // Unified session so a federated remote-viewer can refund their own purchase
  // (person keys receipts on the raw verified actor id = session.user.id here);
  // plain `auth()` still worked for locals but not remote-viewers.
  const session = await getSession();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const limiter = await rateLimit(
    `refund:${clientIp}:${session.user.id}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return { success: false, error: 'Too many refund requests. Please try again later.' };
  }

  const [receipt] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, receiptId), eq(resources.type, 'receipt')))
    .limit(1);

  if (!receipt) return { success: false, error: 'Receipt not found' };
  if (receipt.ownerId !== session.user.id) return { success: false, error: 'Not authorized' };

  const meta = (receipt.metadata ?? {}) as Record<string, unknown>;

  if (meta.status === 'refund_requested' || meta.status === 'refunded') {
    return { success: false, error: 'Refund already requested' };
  }

  const paymentIntentId = meta.stripePaymentIntentId as string | undefined;
  if (!paymentIntentId) return { success: false, error: 'No payment intent found' };

  try {
    // Global is the primary instance and the only Stripe platform, so the
    // refund is submitted to it as an obligation rather than created here.
    // Global re-derives origin, owner, amount, and payment intent from its own
    // projection of this receipt before any money moves.
    const refund = await submitGlobalRefund({
      receiptId,
      buyerAgentId: session.user.id,
    });

    if (refund.status === 'disabled') {
      return { success: false, error: 'Refunds are not enabled yet. Please contact the seller.' };
    }
    if (refund.status === 'not-authorized') {
      console.error('[refund] Global rejected the obligation:', refund.detail);
      return { success: false, error: 'Not authorized' };
    }
    if (refund.status === 'not-refundable') {
      return { success: false, error: 'Payment is not in a refundable state' };
    }
    if (refund.status === 'error') {
      // Ambiguous: Global may or may not have executed. Global's idempotency
      // key makes a retry safe, so record nothing rather than look settled.
      console.error('[refund] Global refund failed:', refund.detail);
      return { success: false, error: 'Refund failed. Please try again later.' };
    }

    await db
      .update(resources)
      .set({
        metadata: { ...meta, status: 'refund_requested', refundRequestedAt: new Date().toISOString() },
      })
      .where(eq(resources.id, receiptId));

    await db.insert(ledger).values({
      verb: 'refund',
      subjectId: session.user.id,
      objectId: meta.sellerAgentId as string,
      objectType: 'agent',
      resourceId: receiptId,
      metadata: {
        kind: 'refund-request',
        originalListingId: meta.originalListingId,
        paymentIntentId,
        priceCents: meta.priceCents,
      },
    } as NewLedgerEntry);

    return { success: true };
  } catch (err: unknown) {
    console.error('requestRefundAction failed:', err);
    return { success: false, error: 'Refund failed. Please try again later.' };
  }
}
