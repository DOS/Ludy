// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { serverPolicy } from '../src/config.ts';
import {
  buildWebUrl,
  createIdempotencyKey,
  formatDateShort,
  formatDateTimeShort,
  formatMoney,
  isPositiveMoney,
  isSafeExternalWebUrl,
  isSafeRelativeWebPath,
  isZeroMoney,
  parseMoneyHintFromTitle,
} from '../src/screens/approvals/format.ts';
import { counterCrypto, nodeCrypto, SERVER } from './helpers.ts';

describe('approvals money formatting without JS float conversion', () => {
  it('formats VND, explicit currencies, and unknown-currency decimals without float conversion', () => {
    expect(formatMoney('1980000', 'VND', 'vi')).toBe('1.980.000 ₫');
    expect(formatMoney('1980000.0000', 'VND', 'vi')).toBe('1.980.000 ₫');
    expect(formatMoney('1980000', 'VND', 'en')).toBe('1,980,000 ₫');
    // When currency is unknown (e.g. inbox list before detail load), omit symbol rather than assuming VND.
    expect(formatMoney('1980000', null, 'vi')).toBe('1.980.000');
    expect(formatMoney('1250.5', undefined, 'en')).toBe('1,250.5');
    // Keeps ledger decimals when present and exact huge integers (> 2^53).
    expect(formatMoney('12500.2500', 'VND', 'vi')).toBe('12.500,25 ₫');
    expect(formatMoney('12500.1234', 'VND', 'vi')).toBe('12.500,1234 ₫');
    expect(formatMoney('9007199254740993123', 'VND', 'vi')).toBe('9.007.199.254.740.993.123 ₫');
    expect(formatMoney('-50000', 'VND', 'vi')).toBe('-50.000 ₫');
  });

  it('formats non-VND ISO currencies with at least 2 decimals', () => {
    expect(formatMoney('1250', 'USD', 'vi')).toBe('1.250 USD');
    expect(formatMoney('1250.5', 'USD', 'vi')).toBe('1.250,50 USD');
    expect(formatMoney('1250.5', 'USD', 'en')).toBe('1,250.50 USD');
    expect(formatMoney('99.1234', 'EUR', 'en')).toBe('99.1234 EUR');
  });

  it('handles empty or non-decimal values safely', () => {
    expect(formatMoney(null, 'VND', 'vi')).toBe('');
    expect(formatMoney('', 'VND', 'vi')).toBe('');
    expect(formatMoney('N/A', 'VND', 'vi')).toBe('N/A');
  });

  it('checks zero and positive decimal strings deterministically', () => {
    expect(isZeroMoney('0')).toBe(true);
    expect(isZeroMoney('000.0000')).toBe(true);
    expect(isZeroMoney(null)).toBe(true);
    expect(isZeroMoney('0.0001')).toBe(false);
    expect(isPositiveMoney('0')).toBe(false);
    expect(isPositiveMoney('-100')).toBe(false);
    expect(isPositiveMoney('150000')).toBe(true);
    expect(isPositiveMoney('0.01')).toBe(true);
  });

  it('extracts optional display amount hint from supplier payment titles', () => {
    expect(parseMoneyHintFromTitle('Chi 2500000 VND cho nhà cung cấp')).toEqual({
      amount: '2500000',
      currency: 'VND',
    });
    expect(parseMoneyHintFromTitle('Chi 120.50 USD cho vendor')).toEqual({
      amount: '120.50',
      currency: 'USD',
    });
    expect(parseMoneyHintFromTitle('Đề xuất chung')).toBeNull();
  });
});

describe('idempotency UUID and date formatting', () => {
  it('builds valid RFC 4122 v4 UUIDs from random bytes', () => {
    const id1 = createIdempotencyKey(counterCrypto());
    const id2 = createIdempotencyKey(nodeCrypto);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id1).not.toBe(id2);
  });

  it('formats YYYY-MM-DD and timestamps safely', () => {
    expect(formatDateShort('2026-11-25', 'vi')).toBe('25/11/2026');
    expect(formatDateShort('2026-11-25', 'en')).toBe('2026-11-25');
    expect(formatDateTimeShort('2026-11-25T10:05:00Z', 'vi')).toMatch(/\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}/);
    expect(formatDateShort('not-a-date', 'vi')).toBe('not-a-date');
  });
});

describe('safe web hand-off URL validation', () => {
  it('accepts safe app-relative paths and rejects protocol-relative or whitespace URLs', () => {
    expect(isSafeRelativeWebPath('/inbox/123')).toBe(true);
    expect(isSafeRelativeWebPath('/social/posts/abc?tab=review')).toBe(true);
    expect(isSafeRelativeWebPath('//evil.example/steal')).toBe(false);
    expect(isSafeRelativeWebPath('/\\evil.example')).toBe(false);
    expect(isSafeRelativeWebPath('https://evil.example/phish')).toBe(false);
    expect(isSafeRelativeWebPath('/inbox/1 2')).toBe(false);
  });

  it('builds org-scoped URLs under trusted policy and refuses untrusted servers or mismatched org slugs', () => {
    const policy = serverPolicy(SERVER, undefined);
    expect(buildWebUrl(SERVER, 'demo-co', '/inbox/p1', policy)).toBe(`${SERVER}/o/demo-co/inbox/p1`);
    expect(buildWebUrl(SERVER, 'demo-co', '/o/demo-co/hr/employees', policy)).toBe(`${SERVER}/o/demo-co/hr/employees`);
    expect(buildWebUrl(SERVER, 'demo-co', '/o/other-co/hr/employees', policy)).toBeNull();
    expect(buildWebUrl('https://evil.example', 'demo-co', '/inbox/p1', policy)).toBeNull();
    expect(buildWebUrl('http://api.example.test', 'demo-co', '/inbox/p1')).toBeNull();
    expect(buildWebUrl(SERVER, 'demo-co', '//evil.example/foo', policy)).toBeNull();
  });

  it('validates external web browser URLs strictly', () => {
    expect(isSafeExternalWebUrl(`${SERVER}/o/demo/inbox/1`, SERVER)).toBe(true);
    expect(isSafeExternalWebUrl('http://localhost:8080/o/demo', 'http://localhost:8080')).toBe(true);
    expect(isSafeExternalWebUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalWebUrl('https://user:pass@api.example.test/o/demo')).toBe(false);
    expect(isSafeExternalWebUrl('https://other.example/o/demo', SERVER)).toBe(false);
  });
});
