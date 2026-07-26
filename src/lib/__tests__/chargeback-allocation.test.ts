import { describe, expect, it } from 'vitest';

import { allocateChargebackCents } from '@/lib/chargeback-allocation';

const CREDITS = [
  { id: 'seller', amountCents: 1000 },
  { id: 'organization', amountCents: 200 },
];

describe('allocateChargebackCents', () => {
  it('allocates a full charge across every credited split', () => {
    expect(allocateChargebackCents(CREDITS, 1200, 1200)).toEqual(
      new Map([
        ['seller', 1000],
        ['organization', 200],
      ]),
    );
  });

  it('allocates a partial charge proportionally', () => {
    expect(allocateChargebackCents(CREDITS, 600, 1200)).toEqual(
      new Map([
        ['seller', 500],
        ['organization', 100],
      ]),
    );
  });

  it('bounds an excessive affected amount to the original charge', () => {
    expect(allocateChargebackCents(CREDITS, 1800, 1200)).toEqual(
      new Map([
        ['seller', 1000],
        ['organization', 200],
      ]),
    );
  });

  it('assigns the rounding remainder to the final split', () => {
    const allocations = allocateChargebackCents(
      [
        { id: 'first', amountCents: 333 },
        { id: 'last', amountCents: 667 },
      ],
      333,
      1000,
    );

    expect(allocations).toEqual(
      new Map([
        ['first', 110],
        ['last', 223],
      ]),
    );
    expect(Array.from(allocations.values()).reduce((sum, amount) => sum + amount, 0)).toBe(333);
  });
});
