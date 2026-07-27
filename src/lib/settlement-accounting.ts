/**
 * @module lib/settlement-accounting
 *
 * The settlement accounting primitives that were trapped inside
 * `app/api/stripe/webhook/route.ts` (Next.js route files may only export
 * request handlers, so nothing else could import them). Extracted VERBATIM —
 * every function body here is byte-identical to the route's previous private
 * copy — so both the Stripe webhook and the federated settlement receiver
 * credit the ledger through ONE path.
 *
 * Keep in lockstep with the group repo's `lib/settlement-accounting.ts` where
 * the functions overlap (they are hash-identical across the fleet today).
 */
import { db } from '@/db';
import { resources } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getStripe } from '@/lib/billing';
import { consumeBookingSlot, isBookingSlotAvailable } from '@/lib/booking-slots';

/** The Drizzle transaction handle type used by every settlement primitive. */
export type SettlementTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function getInventoryState(metadata: Record<string, unknown>): {
  quantityAvailable: number | null;
  quantitySold: number;
  quantityRemaining: number | null;
} {
  const quantityAvailable =
    typeof metadata.quantityAvailable === 'number' && Number.isFinite(metadata.quantityAvailable)
      ? metadata.quantityAvailable
      : null;
  const quantitySold =
    typeof metadata.quantitySold === 'number' && Number.isFinite(metadata.quantitySold)
      ? metadata.quantitySold
      : 0;
  const quantityRemaining =
    typeof metadata.quantityRemaining === 'number' && Number.isFinite(metadata.quantityRemaining)
      ? metadata.quantityRemaining
      : quantityAvailable != null
        ? Math.max(quantityAvailable - quantitySold, 0)
        : null;

  return { quantityAvailable, quantitySold, quantityRemaining };
}

export function sortedUniqueWalletIds(walletIds: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      walletIds.filter(
        (walletId): walletId is string => typeof walletId === 'string' && walletId.length > 0,
      ),
    ),
  ).sort();
}

export async function lockWallets(
  tx: SettlementTx,
  walletIds: Array<string | null | undefined>,
): Promise<void> {
  for (const walletId of sortedUniqueWalletIds(walletIds)) {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
  }
}

export async function incrementListingInventory(
  tx: SettlementTx,
  resourceId: string,
  requestedQuantity: number,
  bookingSelection?: { date: string; slot: string } | null,
): Promise<void> {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) return;

  // Lock the row to prevent concurrent webhooks from reading stale inventory
  const [resource] = await tx.execute(
    sql`SELECT metadata FROM resources WHERE id = ${resourceId} LIMIT 1 FOR UPDATE`
  ) as unknown as { metadata: Record<string, unknown> }[];

  const metadata = (resource?.metadata ?? {}) as Record<string, unknown>;
  if (!isBookingSlotAvailable(metadata, bookingSelection)) {
    throw new Error(`Booking slot unavailable for resource ${resourceId}`);
  }
  const { quantityAvailable, quantitySold, quantityRemaining } = getInventoryState(metadata);
  if (quantityAvailable == null && !bookingSelection) return;

  if (quantityAvailable != null && requestedQuantity > (quantityRemaining ?? 0)) {
    throw new Error(`Inventory exceeded for resource ${resourceId}`);
  }

  const nextQuantitySold = quantitySold + requestedQuantity;
  const nextQuantityRemaining =
    quantityAvailable != null ? Math.max(quantityAvailable - nextQuantitySold, 0) : null;
  const nextMetadata = consumeBookingSlot(metadata, bookingSelection);

  await tx
    .update(resources)
    .set({
      metadata: {
        ...nextMetadata,
        ...(quantityAvailable != null
          ? {
              quantityAvailable,
              quantitySold: nextQuantitySold,
              quantityRemaining: nextQuantityRemaining,
              ...(nextQuantityRemaining === 0 ? { status: 'sold_out' } : {}),
            }
          : {}),
      },
    })
    .where(eq(resources.id, resourceId));
}

export async function getPaymentIntentPayoutEligibleAt(paymentIntentId: string): Promise<string | null> {
  try {
    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });

    const latestCharge =
      paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== 'string'
        ? paymentIntent.latest_charge
        : null;
    const balanceTransaction =
      latestCharge?.balance_transaction &&
      typeof latestCharge.balance_transaction !== 'string'
        ? latestCharge.balance_transaction
        : null;

    if (!balanceTransaction?.available_on) {
      return null;
    }

    return new Date(balanceTransaction.available_on * 1000).toISOString();
  } catch (error) {
    console.error('Failed to fetch payment intent payout eligibility:', paymentIntentId, error);
    return null;
  }
}
