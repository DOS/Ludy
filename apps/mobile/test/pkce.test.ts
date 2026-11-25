// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { base64url, base64urlDecode, pkceChallenge, randomToken } from '../src/auth/pkce.ts';
import { nodeCrypto } from './helpers.ts';

describe('PKCE', () => {
  it('computes the S256 challenge of the RFC 7636 appendix B example', async () => {
    expect(await pkceChallenge(nodeCrypto, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('encodes base64url like Buffer for every length', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) % 256);
      const text = base64url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(Array.from(base64urlDecode(text) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it('refuses to decode what is not base64url', () => {
    expect(base64urlDecode('a+b/')).toBeNull();
    expect(base64urlDecode('a')).toBeNull();
    expect(base64urlDecode('ab=c')).toBeNull();
  });

  it('makes a token of 43 URL-safe characters from 32 random bytes, and a new one each time', () => {
    const a = randomToken(nodeCrypto);
    const b = randomToken(nodeCrypto);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('refuses a random source that answers the wrong length', () => {
    expect(() => randomToken({ randomBytes: () => new Uint8Array(8), sha256: nodeCrypto.sha256 })).toThrow();
  });
});
