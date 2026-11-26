// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for supplier bank account hash comparison (`matchesAccountHash`) with timing-safe digest equality and erase tombstones (#3738).
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@ludy/kernel-runtime';
import { HASH_PURPOSE, SUBJECT_HASH_KEY_ID, matchesAccountHash, supplierSubject, type AccountHashLookupContext } from '../src/supplier-bank-account.ts';

const PARTY_ID = '00000000-0000-4000-8000-000000000010';
const DIGITS = '012345678901';
const hmacHex = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');

describe('matchesAccountHash', () => {
  it('matches subject-keyed hashes and returns false when the subject key is shredded or mismatched', async () => {
    const digest = hmacHex('subject-secret', DIGITS);
    const subjectHash = vi.fn<AccountHashLookupContext['subjectHash']>(async (ref, purpose, value, opts) => {
      expect(ref).toBe(supplierSubject(PARTY_ID));
      expect(purpose).toBe(HASH_PURPOSE);
      expect(opts).toEqual({ create: false });
      return hmacHex('subject-secret', value);
    });
    const keyedHash = vi.fn<AccountHashLookupContext['keyedHash']>();

    await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, DIGITS, { hash_key_id: SUBJECT_HASH_KEY_ID, number_hash: digest })).resolves.toBe(true);
    await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, '9988776655', { hash_key_id: SUBJECT_HASH_KEY_ID, number_hash: digest })).resolves.toBe(false);

    const shredded = vi.fn<AccountHashLookupContext['subjectHash']>(async () => null);
    await expect(matchesAccountHash({ subjectHash: shredded, keyedHash }, PARTY_ID, DIGITS, { hash_key_id: SUBJECT_HASH_KEY_ID, number_hash: digest })).resolves.toBe(false);
    expect(keyedHash).not.toHaveBeenCalled();
  });

  it('matches legacy keyed hashes and handles retired keys cleanly', async () => {
    const digest = hmacHex('k1-secret', DIGITS);
    const subjectHash = vi.fn<AccountHashLookupContext['subjectHash']>();
    const keyedHash = vi.fn<AccountHashLookupContext['keyedHash']>((purpose, value, keyId) => {
      expect(purpose).toBe(HASH_PURPOSE);
      expect(keyId).toBe('k1-old');
      return hmacHex('k1-secret', value);
    });

    await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, DIGITS, { hash_key_id: 'k1-old', number_hash: digest })).resolves.toBe(true);
    await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, '9988776655', { hash_key_id: 'k1-old', number_hash: digest })).resolves.toBe(false);

    const retired = vi.fn<AccountHashLookupContext['keyedHash']>(() => {
      throw new DomainError('KEYED_HASH_KEY_RETIRED', 400, 'Retired');
    });
    await expect(matchesAccountHash({ subjectHash, keyedHash: retired }, PARTY_ID, DIGITS, { hash_key_id: 'k1-old', number_hash: digest })).resolves.toBe(false);
    expect(subjectHash).not.toHaveBeenCalled();
  });

  it('short-circuits erased tombstones and non-hex digests before any key lookup or timingSafeEqual', async () => {
    const subjectHash = vi.fn<AccountHashLookupContext['subjectHash']>();
    const keyedHash = vi.fn<AccountHashLookupContext['keyedHash']>();

    for (const bad of ['erased', '', 'abcd', 'A'.repeat(64), 'z'.repeat(64)]) {
      await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, DIGITS, { hash_key_id: 'k1-old', number_hash: bad }), bad).resolves.toBe(false);
      await expect(matchesAccountHash({ subjectHash, keyedHash }, PARTY_ID, DIGITS, { hash_key_id: SUBJECT_HASH_KEY_ID, number_hash: bad }), bad).resolves.toBe(false);
    }

    expect(subjectHash).not.toHaveBeenCalled();
    expect(keyedHash).not.toHaveBeenCalled();
  });
});
