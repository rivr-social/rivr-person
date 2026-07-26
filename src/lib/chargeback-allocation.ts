type ChargebackCredit = {
  id: string;
  amountCents: number;
};

export function allocateChargebackCents(
  credits: readonly ChargebackCredit[],
  affectedChargeCents: number,
  chargeAmountCents: number,
): Map<string, number> {
  const allocations = new Map<string, number>();
  if (credits.length === 0 || affectedChargeCents <= 0 || chargeAmountCents <= 0) {
    return allocations;
  }

  const boundedAffected = Math.min(affectedChargeCents, chargeAmountCents);
  const totalCredits = credits.reduce((sum, credit) => sum + credit.amountCents, 0);
  const targetTotal =
    boundedAffected === chargeAmountCents
      ? totalCredits
      : Math.floor((totalCredits * boundedAffected) / chargeAmountCents);

  let allocated = 0;
  credits.forEach((credit, index) => {
    const amount =
      index === credits.length - 1
        ? targetTotal - allocated
        : Math.floor((credit.amountCents * boundedAffected) / chargeAmountCents);
    allocations.set(credit.id, Math.max(0, amount));
    allocated += amount;
  });

  return allocations;
}
