// SPDX-License-Identifier: AGPL-3.0-only
// The request body, written (#3854). MISA's examples send every amount as a JSON number, and an amount of Ludy is a decimal string, so it is written into the text as an unquoted number literal exactly as it is,
// never through a JS number (which would round above 2^53 and drop trailing digits). A JS number that is not a safe integer is refused here, so an amount cannot slip through that way.
import { AmisError } from './errors.ts';

export class AmisNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

// An optional minus, an integer part without leading zeros (up to 20 digits), and up to 8 decimals.
const DECIMAL = /^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,8})?$/;

/** A decimal string as an exact JSON number. Anything else (an exponent, a separator, a space, an empty string) is refused. */
export function amisNumber(value: string): AmisNumber {
  if (!DECIMAL.test(value)) throw new AmisError('invalid_request', { reason: 'bad_amount' });
  return new AmisNumber(value);
}

// Only plain objects: a Decimal, a Date, a Map or a class instance would be written as an object of its fields, which MISA would read as garbage.
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const MAX_DEPTH = 32;

export function toJsonText(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new AmisError('invalid_request', { reason: 'bad_value' });
  if (value instanceof AmisNumber) {
    // Checked again here: the constructor takes any string and `text` is only read-only to the compiler, so the factory is not the only way in. Read ONCE: a getter or a Proxy could answer one text to
    // the check and another to the write.
    const text: unknown = value.text;
    if (typeof text !== 'string' || !DECIMAL.test(text)) throw new AmisError('invalid_request', { reason: 'bad_amount' });
    return text;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new AmisError('invalid_request', { reason: 'bad_value' });
      items.push(toJsonText(value[i], depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (isPlain(value)) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${toJsonText(v, depth + 1)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new AmisError('invalid_request', { reason: 'bad_amount' });
    return String(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  throw new AmisError('invalid_request', { reason: 'bad_value' });
}
