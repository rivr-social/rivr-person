/**
 * Payout-country catalog for the "Set up payouts" onboarding picker.
 * Pure + client-safe (no Stripe/db imports) so the dialog can render it
 * and label the rail a seller will land on. The authoritative
 * country→rail decision still happens server-side
 * (stripe-connect.ts CROSS_BORDER_PAYOUT_COUNTRIES); this mirrors it for
 * display + a friendly "how you'll get paid" note.
 */

export type PayoutRail = "domestic" | "connect_cross_border" | "global_payouts";

/** Connect-region countries (US platform can hold full connected accounts). */
const CONNECT_REGION = new Set([
  "US", "GB", "CA", "CH",
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL",
  "PT", "RO", "SK", "SI", "ES", "SE",
]);

export function railForCountry(country: string): PayoutRail {
  const code = country.toUpperCase();
  if (code === "US") return "domestic";
  if (CONNECT_REGION.has(code)) return "connect_cross_border";
  return "global_payouts";
}

export function payoutRailNote(rail: PayoutRail): string {
  switch (rail) {
    case "domestic":
      return "You'll onboard a Stripe account and get paid to your US bank.";
    case "connect_cross_border":
      return "You'll onboard a Stripe account; RIVR pays out across the border to your local bank (a small corridor fee is covered by buyers, not you).";
    case "global_payouts":
      return "Your country uses RIVR's Global Payouts lane — you'll add your bank details and get paid in your local currency (corridor + conversion fees are covered by buyers, not you).";
  }
}

/**
 * A curated, alphabetized country list for the picker. US first (default),
 * then a broad set spanning all three rails. Not exhaustive — the server
 * accepts any valid ISO-2 and routes it; this is the friendly shortlist.
 */
export const PAYOUT_COUNTRY_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "BR", name: "Brazil" },
  { code: "CA", name: "Canada" },
  { code: "CR", name: "Costa Rica" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IN", name: "India" },
  { code: "IE", name: "Ireland" },
  { code: "IT", name: "Italy" },
  { code: "MX", name: "Mexico" },
  { code: "NL", name: "Netherlands" },
  { code: "NO", name: "Norway" },
  { code: "PT", name: "Portugal" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "GB", name: "United Kingdom" },
];
