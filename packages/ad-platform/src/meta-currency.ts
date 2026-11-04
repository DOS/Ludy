// SPDX-License-Identifier: AGPL-3.0-only
// Meta's budgets are whole numbers of the currency's smallest unit, and each currency has its own offset (Marketing API, "Currencies": the number a
// budget in the currency's own units is multiplied by: 100 for the dollar, 1 for the dong). A wrong offset is a wrong amount of real money (a hundred
// times too much or too little), so the conversion is exact string arithmetic on the decimal the ledger holds, never a number, a currency Ludy has no
// verified offset for is refused instead of guessed, and an amount that has more places than the offset can carry is refused instead of rounded. [U] The
// table is written from Meta's documentation; the live check (docs/runbooks/ads-live-check.md, W2-5) confirms it on the owner's own account before any
// other currency joins it.
import { AdPlatformError } from './index.ts';

// The currencies a launch can run in, with Meta's offset for each: the number of decimal places between the currency's own unit and Meta's.
const OFFSET_PLACES: Readonly<Record<string, 0 | 2>> = {
  VND: 0,
  JPY: 0,
  KRW: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  THB: 2,
};

export const META_BUDGET_CURRENCIES: readonly string[] = Object.freeze(Object.keys(OFFSET_PLACES));

// A budget as the ledger holds it (a decimal string: digits, at most two places) in Meta's minor unit, as a decimal string of digits. Refuses a currency with no
// verified offset (`CURRENCY_UNSUPPORTED`), an amount that is not a plain decimal or is zero (`BUDGET_INVALID`), and a fraction the currency's offset cannot
// carry (`BUDGET_FRACTION`: 50000.5 dong).
export function metaMinorUnits(amount: string, currency: string): string {
  const places = Object.hasOwn(OFFSET_PLACES, currency) ? OFFSET_PLACES[currency] : undefined;
  if (places === undefined) throw new AdPlatformError('bad_request', 'CURRENCY_UNSUPPORTED');
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new AdPlatformError('bad_request', 'BUDGET_INVALID');
  const whole = match[1] as string;
  const fraction = match[2] ?? '';
  // The places the offset carries: none for the dong (a fraction of a dong is refused, a "50000.00" is 50000), two for the dollar.
  const kept = fraction.slice(0, places);
  const dropped = fraction.slice(places);
  if (/[1-9]/.test(dropped)) throw new AdPlatformError('bad_request', 'BUDGET_FRACTION');
  const minor = (whole + kept.padEnd(places, '0')).replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(minor)) throw new AdPlatformError('bad_request', 'BUDGET_INVALID');
  return minor;
}
