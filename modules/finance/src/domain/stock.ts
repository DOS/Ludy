// SPDX-License-Identifier: AGPL-3.0-only
// The pure side of stock (#2512, ADR-0045): how a name is normalized into an alias key, and how a quantity is written. Quantities are decimal strings and the arithmetic is
// made with decimal.js through the money helpers, never with numbers; an item's on hand is summed in SQL as a numeric.
import { money } from '@crove/l10n-vn';

// The longest alias key the table holds.
export const ALIAS_KEY_MAX = 300;

// A name as a source writes it, reduced to what two spellings of one product share: Unicode composed, lower case, every run of whitespace one space, trimmed. The
// result is empty when there is nothing to match on, and is cut at the table's limit.
export function normalizeAlias(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, ALIAS_KEY_MAX);
}

// A decimal as the API writes it: no exponent, no trailing zeros ('5.500000' is '5.5', '-0.000000' is '0').
export const plainQuantity = (value: string): string => {
  const plain = money(value).toFixed();
  return plain === '-0' ? '0' : plain;
};

// A reversal of a move is the move with its quantity negated, exactly.
export const oppositeQuantity = (value: string): string => plainQuantity(money(value).negated().toFixed());

// The account a line is booked to when it is goods: 156 on a purchase (a stock-in), 5111 on a sale (a stock-out), or a sub-account of either.
export const STOCK_GOODS_ACCOUNT = { purchase: '156', sale: '5111' } as const;

// The account a sale line is proposed to when nobody picked a sub-account: its text may still be an item's code or a taught name, but it is not listed as unassigned (most lines
// there are services).
export const STOCK_SALE_DEFAULT_ACCOUNT = '511';

// The table holds six decimals and fourteen integer digits.
const MOVE_LIMIT = money('100000000000000');

// What a line says it moved, as a positive decimal string, or null when there is nothing to move (no quantity, zero, negative, or not a decimal).
export function movableQuantity(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? '';
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const quantity = money(text);
  return quantity.greaterThan(0) ? quantity.toFixed() : null;
}

// The quantity of the move a line makes: the line's quantity times the factor to the item's unit, to the six decimals the table holds, negative for a sale. Null when it
// rounds to nothing or is too large to hold, so a posting never fails on a figure the stock cannot take.
export function moveQuantity(direction: 'purchase' | 'sale', quantity: string, factor: string): string | null {
  const scaled = money(quantity).times(money(factor)).toDecimalPlaces(6);
  if (scaled.isZero() || scaled.abs().greaterThanOrEqualTo(MOVE_LIMIT)) return null;
  return plainQuantity((direction === 'sale' ? scaled.negated() : scaled).toFixed());
}

// Two spellings of one unit ('Cái' and 'cái ').
export const sameUnit = (a: string | null | undefined, b: string | null | undefined): boolean => normalizeAlias(a ?? '') === normalizeAlias(b ?? '');
