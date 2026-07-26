import { describe, expect, it } from 'vitest';

import { reconcileCheckoutSettlement } from '@/lib/stripe-checkout-settlement';

describe('reconcileCheckoutSettlement', () => {
  it('separates Stripe Tax from the pre-tax amount', () => {
    const result = reconcileCheckoutSettlement(
      {
        id: 'cs_taxed',
        amount_subtotal: 10_00,
        amount_total: 10_83,
        total_details: {
          amount_discount: 0,
          amount_shipping: 0,
          amount_tax: 83,
        },
      } as never,
      10_00,
      'checkout',
    );

    expect(result).toEqual({
      preTaxCents: 10_00,
      taxCents: 83,
      totalCents: 10_83,
    });
  });

  it('fails closed when discounts change the collected pre-tax amount', () => {
    expect(() =>
      reconcileCheckoutSettlement(
        {
          id: 'cs_discounted',
          amount_subtotal: 10_00,
          amount_total: 9_83,
          total_details: {
            amount_discount: 100,
            amount_shipping: 0,
            amount_tax: 83,
          },
        } as never,
        10_00,
        'checkout',
      ),
    ).toThrow();
  });

  it('fails closed when Stripe omits authoritative amounts', () => {
    expect(() =>
      reconcileCheckoutSettlement(
        {
          id: 'cs_incomplete',
          amount_subtotal: null,
          amount_total: null,
        } as never,
        10_00,
        'checkout',
      ),
    ).toThrow('amounts are incomplete');
  });
});
