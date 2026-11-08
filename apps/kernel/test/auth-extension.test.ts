// SPDX-License-Identifier: AGPL-3.0-only
// The extension token's credential format, its route list and the edge's scope check (#2582, ADR-0047 point 10).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import {
  EXTENSION_ROUTES,
  EXTENSION_TOKEN_PREFIX,
  hashExtensionSecret,
  isExtensionBearer,
  matchExtensionRoute,
  newExtensionCode,
  newExtensionToken,
  refuseOutsideScopes,
  wellFormedChallenge,
  wellFormedExtensionCode,
  wellFormedVerifier,
} from '../src/auth-extension.ts';

const ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('extension secrets', () => {
  it('makes 256-bit tokens and codes of their own kind, hashed with SHA-256 and never equal', () => {
    const token = newExtensionToken();
    const code = newExtensionCode();
    expect(token.value).toMatch(/^crx_[A-Za-z0-9_-]{43}$/);
    expect(code.value).toMatch(/^crc_[A-Za-z0-9_-]{43}$/);
    expect(token.hash).toEqual(createHash('sha256').update(token.value).digest());
    expect(token.hash).toHaveLength(32);
    expect(hashExtensionSecret(token.value)).toEqual(token.hash);
    expect(newExtensionToken().value).not.toBe(token.value);
    expect(isExtensionBearer(token.value)).toBe(true);
    expect(isExtensionBearer(code.value)).toBe(false);
    expect(isExtensionBearer('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBe(false);
    expect(token.value.startsWith(EXTENSION_TOKEN_PREFIX)).toBe(true);
  });

  it('checks the shape of a code, a verifier and a challenge before anything else', () => {
    expect(wellFormedExtensionCode(newExtensionCode().value)).toBe(true);
    expect(wellFormedExtensionCode(newExtensionToken().value)).toBe(false);
    expect(wellFormedExtensionCode(`crc_${'A'.repeat(42)}`)).toBe(false);
    expect(wellFormedExtensionCode(undefined)).toBe(false);
    expect(wellFormedVerifier('v'.repeat(43))).toBe(true);
    expect(wellFormedVerifier('v'.repeat(128))).toBe(true);
    expect(wellFormedVerifier('v'.repeat(42))).toBe(false);
    expect(wellFormedVerifier('v'.repeat(129))).toBe(false);
    expect(wellFormedVerifier(`${'v'.repeat(42)}!`)).toBe(false);
    expect(wellFormedChallenge('A'.repeat(43))).toBe(true);
    expect(wellFormedChallenge('A'.repeat(44))).toBe(false);
  });
});

describe('the routes an extension token may reach', () => {
  it('lists each route with its reason, the meetings ones with the meetings scope', () => {
    expect(EXTENSION_ROUTES.map((r) => `${r.method} ${r.path} ${r.scope}`)).toEqual([
      'GET /api/extension/me null',
      'POST /api/rpc/meetings/create meetings',
      'POST /api/rpc/meetings/extensionStatus meetings',
      'POST /api/files/uploads meetings',
      'POST /api/meetings/:id/media meetings',
    ]);
    expect(EXTENSION_ROUTES.every((r) => r.why.length > 20)).toBe(true);
  });

  it('matches a listed method and path exactly, with one UUID for an id', () => {
    expect(matchExtensionRoute('POST', `/api/meetings/${ID}/media`)?.scope).toBe('meetings');
    expect(matchExtensionRoute('POST', '/api/meetings/x/media')).toBeNull();
    expect(matchExtensionRoute('POST', `/api/meetings/${ID}/media/`)).toBeNull();
    expect(matchExtensionRoute('GET', `/api/meetings/${ID}/audio`)).toBeNull();
    expect(matchExtensionRoute('GET', '/api/extension/me')?.scope).toBeNull();
    expect(matchExtensionRoute('POST', '/api/extension/me')).toBeNull();
    expect(matchExtensionRoute('POST', '/api/rpc/meetings/get')).toBeNull();
    expect(matchExtensionRoute('POST', '/api/rpc/meetings/create/extra')).toBeNull();
    expect(matchExtensionRoute('POST', '/api/rpc/meetings/create?x=1'.split('?')[0] ?? '')?.scope).toBe('meetings');
    // A percent sign anywhere is no route: the router would decode it to a path the list does not name.
    expect(matchExtensionRoute('POST', '/api/rpc/meetings%2Fcreate')).toBeNull();
    expect(matchExtensionRoute('POST', '/api/rpc/%6deetings/create')).toBeNull();
    expect(matchExtensionRoute('POST', '/api/rpc/meetings/create/../get')).toBeNull();
  });

  it('refuses outside the token\'s scopes with a 403 that names the rule, and passes nothing else', () => {
    const refused = refuseOutsideScopes(['meetings'], 'GET', `/api/meetings/${ID}/audio`);
    expect(refused).toBeInstanceOf(DomainError);
    expect(refused).toMatchObject({ code: 'FORBIDDEN', status: 403, details: { rule: 'extension_scope' } });
    expect(refuseOutsideScopes(['meetings'], 'POST', '/api/rpc/meetings/create')).toBeNull();
    expect(refuseOutsideScopes(['other'], 'POST', '/api/rpc/meetings/create')).toMatchObject({ status: 403 });
    expect(refuseOutsideScopes([], 'POST', '/api/rpc/meetings/create')).toMatchObject({ status: 403 });
    // A route open to any token still needs a token that is valid, which authenticate() has settled before this runs.
    expect(refuseOutsideScopes([], 'GET', '/api/extension/me')).toBeNull();
  });
});
