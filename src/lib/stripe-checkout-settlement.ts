import type Stripe from 'stripe';

import { assertAmountReconciled } from '@/lib/stripe-reconcile';

export interface CheckoutSettlementAmounts {
  preTaxCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Reconciles local pre-tax checkout metadata against Stripe's authoritative
 * subtotal and total details. Discounts and shipping are included in the
 * collected pre-tax amount, so unsupported Checkout modifications fail closed
 * instead of over-crediting local wallets.
 */
export function reconcileCheckoutSettlement(
  session: Stripe.Checkout.Session,
  expectedPreTaxCents: number,
  label: string,
): CheckoutSettlementAmounts {
  if (session.amount_subtotal == null || session.amount_total == null) {
    throw new Error(`${label}: Stripe Checkout amounts are incomplete`);
  }

  const discountCents = session.total_details?.amount_discount ?? 0;
  const shippingCents = session.total_details?.amount_shipping ?? 0;
  const taxCents = session.total_details?.amount_tax ?? 0;
  const preTaxCents = session.amount_subtotal - discountCents + shippingCents;

  assertAmountReconciled(preTaxCents, expectedPreTaxCents, `${label}:pre-tax`);
  assertAmountReconciled(
    session.amount_total,
    preTaxCents + taxCents,
    `${label}:tax-inclusive-total`,
  );

  return {
    preTaxCents,
    taxCents,
    totalCents: session.amount_total,
  };
}
