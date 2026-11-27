// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { advisoryLockKey } from '../src/advisory-lock.ts';
import { zChannelConnect } from '../src/channels.ts';

const base = {
  provider: 'whatsapp',
  displayName: 'Shop',
  scopes: [],
  expiresAt: null,
  credential: { keyId: 'k1', envelope: 'QUJD' },
};

describe('zChannelConnect externalAccountId (#5091)', () => {
  it('trims surrounding whitespace so it never persists', () => {
    const parsed = zChannelConnect.parse({ ...base, externalAccountId: ' \t123456789012345\n ' });
    expect(parsed.externalAccountId).toBe('123456789012345');
  });

  it('derives the same advisory lock key with or without surrounding whitespace', () => {
    const padded = zChannelConnect.parse({ ...base, externalAccountId: '  15551234567 ' });
    const clean = zChannelConnect.parse({ ...base, externalAccountId: '15551234567' });
    expect(advisoryLockKey('ludy.whatsapp_handover', padded.externalAccountId)).toBe(advisoryLockKey('ludy.whatsapp_handover', clean.externalAccountId));
  });

  it('keeps inner whitespace', () => {
    expect(zChannelConnect.parse({ ...base, externalAccountId: ' a b ' }).externalAccountId).toBe('a b');
  });

  it('rejects empty and whitespace-only ids', () => {
    expect(zChannelConnect.safeParse({ ...base, externalAccountId: '' }).success).toBe(false);
    const blank = zChannelConnect.safeParse({ ...base, externalAccountId: ' \t\n ' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues[0]?.message).toBe('External account id must not be blank');
  });

  it('still caps the trimmed id at 200 characters', () => {
    expect(zChannelConnect.safeParse({ ...base, externalAccountId: 'a'.repeat(200) }).success).toBe(true);
    expect(zChannelConnect.safeParse({ ...base, externalAccountId: 'a'.repeat(201) }).success).toBe(false);
  });
});
