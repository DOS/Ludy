// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyedHashError, keyedHash } from '../src/keyed-hash.ts';

const root = randomBytes(32);
const org = randomUUID();

describe('keyedHash', () => {
  it('gives the same hash for the same input and a lowercase hex of 32 bytes', () => {
    const a = keyedHash(root, org, 'supplier_bank_account.number', '0123456789');
    expect(a).toBe(keyedHash(root, org, 'supplier_bank_account.number', '0123456789'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives another hash for another org, another purpose, another value or another root', () => {
    const base = keyedHash(root, org, 'supplier_bank_account.number', '0123456789');
    expect(keyedHash(root, randomUUID(), 'supplier_bank_account.number', '0123456789')).not.toBe(base);
    expect(keyedHash(root, org, 'other.purpose', '0123456789')).not.toBe(base);
    expect(keyedHash(root, org, 'supplier_bank_account.number', '0123456780')).not.toBe(base);
    expect(keyedHash(randomBytes(32), org, 'supplier_bank_account.number', '0123456789')).not.toBe(base);
  });

  it('carries no key material, the value or the org in its output', () => {
    const out = keyedHash(root, org, 'supplier_bank_account.number', '0123456789');
    expect(out).not.toContain(root.toString('hex'));
    expect(out).not.toContain('0123456789');
    expect(out).not.toContain(org.replaceAll('-', ''));
  });

  it('refuses a malformed purpose or org and a value that is empty or too long, without echoing the value', () => {
    expect(() => keyedHash(root, org, 'Bad Purpose', 'x')).toThrow(KeyedHashError);
    expect(() => keyedHash(root, 'not-an-org', 'p', 'x')).toThrow(KeyedHashError);
    expect(() => keyedHash(root, org, 'p', '')).toThrow(KeyedHashError);
    expect(() => keyedHash(root, org, 'p', 'x'.repeat(4097))).toThrow(KeyedHashError);
    try {
      keyedHash(root, org, 'p', '');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(root.toString('hex'));
    }
  });
});
