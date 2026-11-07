// SPDX-License-Identifier: AGPL-3.0-only
// The pure side of the finance coworker on stock (#2514, plan stock-and-marketplaces.md section 8.6): when an item is running low and how much to ask for, the fixed words of a reorder
// message, and which items are offered to the model for a line. No clock and no database here: the query reads the figures and calls these.
// Quantities are decimal strings and the arithmetic is decimal.js through the money helpers, never numbers.
import { money } from '@crove/l10n-vn';
import { plainQuantity } from './stock.ts';

// The pace of sales is read over the last eight weeks, or over the days since the item's first move when that is younger, but never over fewer than seven days: one sale on the
// first day must not read as a pace of a sale a day.
export const LOW_WINDOW_DAYS = 56;
export const LOW_MIN_DAYS = 7;

const DAY_MS = 86_400_000;

// The days the pace is averaged over: the days since the first move up to today (both counted), within [LOW_MIN_DAYS, LOW_WINDOW_DAYS].
export function observedDays(today: string, firstMove: string | null): number {
  if (firstMove === null) return LOW_MIN_DAYS;
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${firstMove}T00:00:00Z`)) / DAY_MS) + 1;
  if (!Number.isFinite(days)) return LOW_MIN_DAYS;
  return Math.max(LOW_MIN_DAYS, Math.min(LOW_WINDOW_DAYS, days));
}

export interface LowFigures {
  // Average units out per day, three decimals at most.
  dailyOut: string;
  // Whole days the stock on hand lasts at that pace; 0 when nothing is on hand.
  coverDays: number;
  // To whole units: two lead times of sales less what is on hand, at least one.
  suggestedQuantity: string;
}

/** The figures of an item that is running low, or null when it is not: nothing sold in the window, or the stock on hand lasts the lead days or longer. `sold` is the net units out of
 * the window (a negative net is no sales); a negative stock on hand counts as none. */
export function lowFigures(input: { onHand: string; sold: string; days: number; leadDays: number }): LowFigures | null {
  const sold = money(input.sold);
  if (!sold.greaterThan(0) || input.days < 1 || input.leadDays < 1) return null;
  const have = money(input.onHand).greaterThan(0) ? money(input.onHand) : money(0);
  // Products before quotients, so an exact answer (30 sold in 7 days, two 14-day lead times: 120) is not made inexact by a division that comes first.
  if (have.times(input.days).greaterThanOrEqualTo(sold.times(input.leadDays))) return null;
  const need = sold.times(2 * input.leadDays).dividedBy(input.days).minus(have).ceil();
  return {
    dailyOut: plainQuantity(sold.dividedBy(input.days).toDecimalPlaces(3).toFixed()),
    coverDays: have.times(input.days).dividedBy(sold).floor().toNumber(),
    suggestedQuantity: plainQuantity((need.greaterThan(1) ? need : money(1)).toFixed()),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The reorder message's fixed words
// ---------------------------------------------------------------------------------------------------------------------

export interface ReorderLine {
  name: string;
  // A decimal string, above zero.
  quantity: string;
  unit: string;
}

/** The message a person gets when the coworker is off or its text was refused: a greeting, a line per item with its quantity and unit, a request to confirm and the business's name. It
 * names no price, date or address, so it asks for exactly what the lines say. */
export function reorderTemplate(input: { language: 'vi' | 'en'; orgName: string; supplierName: string | null; items: readonly ReorderLine[] }): string {
  const lines = input.items.map((i) => `- ${i.name}: ${plainQuantity(i.quantity)} ${i.unit}`.trimEnd()).join('\n');
  if (input.language === 'en') {
    return `Hello ${input.supplierName ?? 'Supplier'},\n\n${input.orgName} would like to reorder the items below. Please confirm what you can deliver:\n${lines}\n\nThank you,\n${input.orgName}`;
  }
  return `Chào ${input.supplierName ?? 'nhà cung cấp'},\n\n${input.orgName} muốn đặt thêm các mặt hàng dưới đây. Xin anh chị xác nhận số lượng có thể giao:\n${lines}\n\nXin cảm ơn.\n${input.orgName}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The items offered to the model for a line
// ---------------------------------------------------------------------------------------------------------------------

// Lower case with the diacritics taken off, so "Áo thun" and "ao thun" share their words.
const words = (text: string): Set<string> =>
  new Set(
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      // Both cases of đ: it has no decomposition, and lower-casing "Đ" first would leave a letter the split below drops ("Đen" is "den").
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2),
  );

/** At most `max` of the items, those that share the most words with the lines' descriptions first (then by code), so an entity with hundreds of items still offers the model the
 * ones that can be the answer. With `max` items or fewer, all of them in the order given. */
export function pickCandidates<T extends { code: string; name: string }>(descriptions: readonly string[], items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const wanted = new Set(descriptions.flatMap((d) => [...words(d)]));
  const scored = items.map((item) => ({ item, score: [...words(`${item.code} ${item.name}`)].filter((w) => wanted.has(w)).length }));
  scored.sort((a, b) => b.score - a.score || a.item.code.localeCompare(b.item.code));
  return scored.slice(0, max).map((s) => s.item);
}
