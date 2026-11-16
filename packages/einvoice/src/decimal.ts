// SPDX-License-Identifier: AGPL-3.0-only
// Decimal strings as exact integers (never JS numbers, AGENTS.md money rule): at most 8 fractional digits, as integers of 1e-8, so sums per rate are exact.
import { EInvoiceProviderError } from './port.ts';

// Decimal strings with at most 8 fractional digits as integers of 1e-8, so the per-rate sums of the sandbox's XML are exact.
export function toMinor(value: string): bigint {
  const match = /^(-?)(\d{1,16})(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) throw new EInvoiceProviderError('unavailable');
  const whole = BigInt(match[2] ?? '0') * 100_000_000n + BigInt((match[3] ?? '').padEnd(8, '0'));
  return match[1] === '-' ? -whole : whole;
}

export function fromMinor(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / 100_000_000n;
  const fraction = (abs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}
