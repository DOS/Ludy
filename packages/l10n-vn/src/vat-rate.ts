import { money } from './money.ts';

type Decimal = ReturnType<typeof money>;

/**
 * An invoice VAT rate read from text (TSuat of Decree 123 e-invoices, or what extraction read).
 * - `exempt`: "KCT" or "KKKNT", no VAT (0%).
 * - `other`: "KHAC" with an optional ratio ("KHAC:5.26%"); `percent` is null without a usable ratio (0 < r <= 100).
 * - `percent`: a plain rate, 0 to 100, with or without the percent sign.
 * - `unknown`: anything else, including a rate above 100.
 */
export type ParsedVatRate =
  | { kind: 'exempt'; code: 'KCT' | 'KKKNT'; percent: Decimal }
  | { kind: 'other'; percent: Decimal | null }
  | { kind: 'percent'; percent: Decimal }
  | { kind: 'unknown' };

const OTHER = /^KHAC(?::(\d{1,3}(?:\.\d+)?)%?)?$/;
const PLAIN = /^(\d{1,3}(?:\.\d+)?)%?$/;

/** The one VAT-rate parser (case and spaces ignored); the MISA export and the 1331/1332 split both use it. */
export function parseVatRate(rate: string | null | undefined): ParsedVatRate {
  const text = (rate ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (text === 'KCT' || text === 'KKKNT') return { kind: 'exempt', code: text, percent: money(0) };
  const other = OTHER.exec(text);
  if (other) {
    const ratio = other[1] === undefined ? null : money(other[1]);
    return { kind: 'other', percent: ratio && ratio.greaterThan(0) && ratio.lessThanOrEqualTo(100) ? ratio : null };
  }
  const plain = PLAIN.exec(text);
  if (plain?.[1] !== undefined) {
    const percent = money(plain[1]);
    if (percent.lessThanOrEqualTo(100)) return { kind: 'percent', percent };
  }
  return { kind: 'unknown' };
}

/** Periods when the 8% reduced rate applied (both dates included), with their sources. Data, so a correction is a change here and not to the code. */
export const REDUCED_RATE_PERIODS: ReadonlyArray<{ from: string; to: string; source: string }> = [
  { from: '2022-02-01', to: '2022-12-31', source: 'Resolution 43/2022/QH15, Decree 15/2022/ND-CP' },
  { from: '2023-07-01', to: '2023-12-31', source: 'Resolution 101/2023/QH15, Decree 44/2023/ND-CP' },
  { from: '2024-01-01', to: '2024-06-30', source: 'Resolution 110/2023/QH15, Decree 94/2023/ND-CP' },
  { from: '2024-07-01', to: '2024-12-31', source: 'Resolution 142/2024/QH15, Decree 72/2024/ND-CP' },
  { from: '2025-01-01', to: '2025-06-30', source: 'Resolution 174/2024/QH15, Decree 180/2024/ND-CP' },
  { from: '2025-07-01', to: '2026-12-31', source: 'Resolution 204/2025/QH15, Decree 174/2025/ND-CP' },
];

export function reducedRateApplies(date: string): boolean {
  return REDUCED_RATE_PERIODS.some((p) => date >= p.from && date <= p.to);
}

/**
 * The VAT rates a sales invoice line may carry on a date, as they are written on the invoice: 0, 5 and 10 percent, not subject to tax (KCT) and not declared (KKKNT), and 8% only
 * in a period when the reduced rate applied (REDUCED_RATE_PERIODS). "Another rate" (KHAC) is a person's choice, never a rate to propose.
 */
export function salesVatRatesOn(date: string): string[] {
  return ['0%', '5%', ...(reducedRateApplies(date) ? ['8%'] : []), '10%', 'KCT', 'KKKNT'];
}

/** A rate as written on the invoice ("10%", "KCT") from text such as "10", "10 %", "kct", or null when it is not a plain rate or an exemption (KHAC and unreadable text give null). */
export function writtenVatRate(rate: string | null | undefined): string | null {
  const parsed = parseVatRate(rate);
  if (parsed.kind === 'exempt') return parsed.code;
  if (parsed.kind === 'percent') return `${parsed.percent.toFixed()}%`;
  return null;
}
