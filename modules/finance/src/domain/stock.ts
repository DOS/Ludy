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
