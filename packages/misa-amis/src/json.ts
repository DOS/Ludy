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

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof AmisNumber);

export function toJsonText(value: unknown): string {
  if (value instanceof AmisNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map(toJsonText).join(',')}]`;
  if (isPlain(value)) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${toJsonText(v)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new AmisError('invalid_request', { reason: 'bad_amount' });
    return String(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  throw new AmisError('invalid_request', { reason: 'bad_value' });
}
