import { and, eq, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { capitalEntries, wallets, walletTransactions } from '@/db/schema';
import { allocateChargebackCents } from '@/lib/chargeback-allocation';
import { estimateStripeProcessingFeeCents } from '@/lib/checkout-fees';

export const STRIPE_DISPUTE_FEE_CENTS = 1500;

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CreditedSplit = {
  id: string;
  toWalletId: string | null;
  amountCents: number;
  type: string;
  metadata: Record<string, unknown> | null;
};

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMetadata(value: unknown): Record<string, unknown> | null {
  return isMetadataRecord(value) ? value : null;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0);
}

function isPrimarySellerCredit(credit: CreditedSplit): boolean {
  const metadata = credit.metadata ?? {};
  return (
    credit.type === 'marketplace_payout' &&
    ('sellerAgentId' in metadata || 'sellerId' in metadata || 'organizerAgentId' in metadata)
  );
}

async function loadCreditedSplits(tx: DbTx, paymentIntentId: string): Promise<CreditedSplit[]> {
  const rows = await tx
    .select({
      id: walletTransactions.id,
      toWalletId: walletTransactions.toWalletId,
      amountCents: walletTransactions.amountCents,
      type: walletTransactions.type,
      metadata: walletTransactions.metadata,
    })
    .from(walletTransactions)
    .where(
      and(
        or(
          eq(walletTransactions.type, 'marketplace_payout'),
          eq(walletTransactions.type, 'service_fee'),
        ),
        sql`${walletTransactions.metadata}->>'paymentIntentId' = ${paymentIntentId}`,
      ),
    )
    .orderBy(walletTransactions.createdAt);

  return rows.map((row) => ({ ...row, metadata: readMetadata(row.metadata) }));
}

async function lockWallets(tx: DbTx, credits: CreditedSplit[]): Promise<void> {
  const walletIds = Array.from(
    new Set(
      credits
        .map((credit) => credit.toWalletId)
        .filter((walletId): walletId is string => typeof walletId === 'string'),
    ),
  ).sort();
  for (const walletId of walletIds) {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
  }
}

async function debitCredit(
  tx: DbTx,
  credit: CreditedSplit,
  principalCents: number,
  feeCents: number,
  metadata: Record<string, unknown>,
  description: string,
): Promise<void> {
  if (!credit.toWalletId || principalCents + feeCents <= 0) return;

  await tx
    .update(wallets)
    .set({
      balanceCents: sql`${wallets.balanceCents} - ${principalCents + feeCents}`,
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, credit.toWalletId));

  if (principalCents > 0) {
    await tx
      .update(capitalEntries)
      .set({
        remainingCents: sql`GREATEST(0, ${capitalEntries.remainingCents} - ${principalCents})`,
        updatedAt: new Date(),
      })
      .where(eq(capitalEntries.sourceTransactionId, credit.id));
  }

  await tx.insert(walletTransactions).values({
    type: 'refund',
    fromWalletId: credit.toWalletId,
    amountCents: principalCents + feeCents,
    feeCents,
    currency: 'usd',
    description,
    status: 'completed',
    metadata: {
      ...metadata,
      sourceTransactionId: credit.id,
      reversedPrincipalCents: principalCents,
      feeCents,
    },
  });
}

export async function clawbackRefund(params: {
  paymentIntentId: string;
  chargeAmountCents: number;
  totalRefundedCents: number;
}): Promise<{ recovered: boolean; debitedCents?: number; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'refund:' + params.paymentIntentId}, 0))`,
    );

    const credits = await loadCreditedSplits(tx, params.paymentIntentId);
    if (credits.length === 0) return { recovered: false, reason: 'no-internal-credit' };

    const priorRows = (
      await tx
      .select({
        amountCents: walletTransactions.amountCents,
        feeCents: walletTransactions.feeCents,
        metadata: walletTransactions.metadata,
      })
      .from(walletTransactions)
      .where(
        and(
          sql`${walletTransactions.metadata}->>'source' = 'refund_clawback'`,
          sql`${walletTransactions.metadata}->>'paymentIntentId' = ${params.paymentIntentId}`,
        ),
      )
    ).map((row) => ({ ...row, metadata: readMetadata(row.metadata) }));

    const priorRefundedChargeCents = priorRows.reduce(
      (max, row) =>
        Math.max(max, metadataNumber(row.metadata, 'refundedChargeTotalCents')),
      0,
    );
    if (params.totalRefundedCents <= priorRefundedChargeCents) {
      return { recovered: false, reason: 'already-processed' };
    }

    const targetAllocations = allocateChargebackCents(
      credits,
      params.totalRefundedCents,
      params.chargeAmountCents,
    );
    const priorBySource = new Map<string, number>();
    for (const row of priorRows) {
      const sourceTransactionId = row.metadata?.sourceTransactionId;
      if (typeof sourceTransactionId !== 'string') continue;
      priorBySource.set(
        sourceTransactionId,
        (priorBySource.get(sourceTransactionId) ?? 0) +
          metadataNumber(row.metadata, 'reversedPrincipalCents'),
      );
    }

    const priorFeeCents = priorRows.reduce((sum, row) => sum + row.feeCents, 0);
    const targetFeeCents = estimateStripeProcessingFeeCents(
      Math.min(params.totalRefundedCents, params.chargeAmountCents),
    );
    let remainingFeeCents = Math.max(0, targetFeeCents - priorFeeCents);
    const orderedCredits = [...credits].sort(
      (left, right) => Number(isPrimarySellerCredit(right)) - Number(isPrimarySellerCredit(left)),
    );

    await lockWallets(tx, orderedCredits);
    let debitedCents = 0;
    for (const credit of orderedCredits) {
      const principalCents = Math.max(
        0,
        (targetAllocations.get(credit.id) ?? 0) - (priorBySource.get(credit.id) ?? 0),
      );
      const feeCents = isPrimarySellerCredit(credit) ? remainingFeeCents : 0;
      remainingFeeCents -= feeCents;
      if (principalCents + feeCents <= 0) continue;

      await debitCredit(
        tx,
        credit,
        principalCents,
        feeCents,
        {
          source: 'refund_clawback',
          paymentIntentId: params.paymentIntentId,
          refundedChargeTotalCents: params.totalRefundedCents,
          chargeAmountCents: params.chargeAmountCents,
        },
        'Refund clawback',
      );
      debitedCents += principalCents + feeCents;
    }

    return debitedCents > 0
      ? { recovered: true, debitedCents }
      : { recovered: false, reason: 'already-processed' };
  });
}

export async function clawbackChargeback(params: {
  paymentIntentId: string;
  disputeId: string;
  disputeAmountCents: number;
  disputeFeeCents?: number;
}): Promise<{ recovered: boolean; debitedCents?: number; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'dispute:' + params.disputeId}, 0))`,
    );

    const [existing] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(
        and(
          sql`${walletTransactions.metadata}->>'source' = 'chargeback'`,
          sql`${walletTransactions.metadata}->>'disputeId' = ${params.disputeId}`,
        ),
      )
      .limit(1);
    if (existing) return { recovered: false, reason: 'already-processed' };

    const credits = await loadCreditedSplits(tx, params.paymentIntentId);
    if (credits.length === 0) return { recovered: false, reason: 'no-internal-credit' };

    const [purchase] = await tx
      .select({ amountCents: walletTransactions.amountCents })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, params.paymentIntentId))
      .limit(1);
    if (!purchase || purchase.amountCents <= 0) {
      throw new Error(`Chargeback ${params.disputeId} has no authoritative local purchase`);
    }

    const allocations = allocateChargebackCents(
      credits,
      params.disputeAmountCents,
      purchase.amountCents,
    );
    const orderedCredits = [...credits].sort(
      (left, right) => Number(isPrimarySellerCredit(right)) - Number(isPrimarySellerCredit(left)),
    );
    await lockWallets(tx, orderedCredits);

    let remainingFeeCents = params.disputeFeeCents ?? STRIPE_DISPUTE_FEE_CENTS;
    let debitedCents = 0;
    for (const credit of orderedCredits) {
      const principalCents = allocations.get(credit.id) ?? 0;
      const feeCents = isPrimarySellerCredit(credit) ? remainingFeeCents : 0;
      remainingFeeCents -= feeCents;
      if (principalCents + feeCents <= 0) continue;

      await debitCredit(
        tx,
        credit,
        principalCents,
        feeCents,
        {
          source: 'chargeback',
          disputeId: params.disputeId,
          paymentIntentId: params.paymentIntentId,
          disputeAmountCents: params.disputeAmountCents,
          chargeAmountCents: purchase.amountCents,
        },
        'Chargeback clawback',
      );
      debitedCents += principalCents + feeCents;
    }

    return { recovered: true, debitedCents };
  });
}

export async function reverseChargebackClawback(params: {
  disputeId: string;
}): Promise<{ reversed: boolean; creditedCents?: number; reason?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'dispute:' + params.disputeId}, 0))`,
    );

    const clawbacks = (
      await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          sql`${walletTransactions.metadata}->>'source' = 'chargeback'`,
          sql`${walletTransactions.metadata}->>'disputeId' = ${params.disputeId}`,
        ),
      )
    ).map((row) => ({ ...row, metadata: readMetadata(row.metadata) }));
    const pending = clawbacks.filter((row) => !row.metadata?.reversedAt);
    if (pending.length === 0) {
      return {
        reversed: false,
        reason: clawbacks.length === 0 ? 'clawback-not-found' : 'already-reversed',
      };
    }

    const walletIds = Array.from(
      new Set(
        pending
          .map((row) => row.fromWalletId)
          .filter((walletId): walletId is string => typeof walletId === 'string'),
      ),
    ).sort();
    for (const walletId of walletIds) {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
    }

    let creditedCents = 0;
    for (const clawback of pending) {
      if (!clawback.fromWalletId) continue;
      const metadata = clawback.metadata ?? {};
      const principalCents = metadataNumber(metadata, 'reversedPrincipalCents');
      const sourceTransactionId = metadata.sourceTransactionId;

      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${clawback.amountCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, clawback.fromWalletId));

      if (principalCents > 0 && typeof sourceTransactionId === 'string') {
        await tx
          .update(capitalEntries)
          .set({
            remainingCents: sql`LEAST(${capitalEntries.amountCents}, ${capitalEntries.remainingCents} + ${principalCents})`,
            updatedAt: new Date(),
          })
          .where(eq(capitalEntries.sourceTransactionId, sourceTransactionId));
      }

      await tx
        .update(walletTransactions)
        .set({ metadata: { ...metadata, reversedAt: new Date().toISOString() } })
        .where(eq(walletTransactions.id, clawback.id));
      await tx.insert(walletTransactions).values({
        type: 'refund',
        toWalletId: clawback.fromWalletId,
        amountCents: clawback.amountCents,
        feeCents: 0,
        currency: clawback.currency,
        description: 'Chargeback reversed after funds reinstatement',
        status: 'completed',
        metadata: {
          source: 'chargeback_reversal',
          disputeId: params.disputeId,
          clawbackTransactionId: clawback.id,
          sourceTransactionId,
          restoredPrincipalCents: principalCents,
        },
      });
      creditedCents += clawback.amountCents;
    }

    return { reversed: true, creditedCents };
  });
}
