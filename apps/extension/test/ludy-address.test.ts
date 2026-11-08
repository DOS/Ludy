// SPDX-License-Identifier: AGPL-3.0-only
// The one configured Ludy address, and the rule that no request goes anywhere else.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ADDRESS, isDefaultAddress, ludyUrl, originPattern, parseAddress } from '../src/ludy-address.ts';
import { assertGrantUrl, createClient, LudyError } from '../src/api.ts';

describe('parseAddress', () => {
  it.each([
    ['app.ludy.vn', 'https://app.ludy.vn'],
    ['https://ludy.congty.vn/some/path?x=1', 'https://ludy.congty.vn'],
    ['  https://ludy.congty.vn:8443  ', 'https://ludy.congty.vn:8443'],
    ['http://localhost:8080', 'http://localhost:8080'],
  ])('accepts %s', (input, origin) => {
    expect(parseAddress(input)).toEqual({ origin });
  });

  it.each([
    ['', 'empty'],
    ['http://ludy.congty.vn', 'insecure'],
    ['https://user:pw@ludy.congty.vn', 'credentials'],
    ['javascript:alert(1)', 'invalid'],
    ['ftp://ludy.congty.vn', 'invalid'],
  ])('refuses %s', (input, problem) => {
    expect(parseAddress(input)).toEqual({ problem });
  });

  it('asks the browser for one host pattern per address', () => {
    expect(originPattern('https://ludy.congty.vn:8443')).toBe('https://ludy.congty.vn/*');
    expect(isDefaultAddress(DEFAULT_ADDRESS)).toBe(true);
    expect(isDefaultAddress('https://ludy.congty.vn')).toBe(false);
  });
});

describe('no request goes anywhere but the configured address', () => {
  it.each(['https://evil.example/api/config', '//evil.example/x', '/\\evil.example', 'api/config', 'http://app.ludy.vn/x'])('ludyUrl refuses %s', (path) => {
    expect(() => ludyUrl('https://app.ludy.vn', path)).toThrow(/Refused/);
  });

  it('every call of the client is made on the configured origin, without cookies', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      urls.push(input);
      expect(init?.credentials).toBe('omit');
      return Response.json({ json: { meetingId: 'm1' }, uploads: 'direct', fileId: 'f1', features: {}, token: 't', tokenId: 'i', orgId: 'o', scopes: ['meetings'], expiresAt: 'x' });
    });
    const client = createClient('https://ludy.congty.vn', 'crx_abc', fetchImpl);
    await client.config();
    await client.exchangeCode('crc_x', 'v'.repeat(43));
    await client.me();
    await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'in_invite' });
    await client.uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'audio', file: new File(['a'], 'a.webm'), lengthSeconds: 1, uploads: 'direct' });
    expect(urls).toHaveLength(5);
    for (const url of urls) expect(new URL(url).origin).toBe('https://ludy.congty.vn');
  });

  it('a call that needs the token makes no request without one', async () => {
    const fetchImpl = vi.fn();
    await expect(createClient('https://app.ludy.vn', null, fetchImpl).me()).rejects.toBeInstanceOf(LudyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a path that would leave the origin is refused before any request', async () => {
    const fetchImpl = vi.fn();
    const client = createClient('https://app.ludy.vn', 't', fetchImpl);
    await expect(client.uploadMedia({ meetingId: '../../..//evil.example', kind: 'audio', file: new File(['a'], 'a.webm'), lengthSeconds: 1, uploads: 'direct' })).rejects.toBeDefined();
    for (const [url] of fetchImpl.mock.calls) expect(new URL(url as string).origin).toBe('https://app.ludy.vn');
  });

  it('a staged upload goes to the address the configured server granted, https only, with no token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, auth: new Headers(init?.headers).get('authorization') });
      if (input.endsWith('/api/files/uploads')) return Response.json({ uploadId: 'u1', url: 'https://bucket.example/stage', fields: { key: 'k' } });
      return Response.json({ fileId: 'f1' });
    });
    await createClient('https://app.ludy.vn', 'crx_t', fetchImpl).uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'video', file: new File(['v'], 'v.webm'), lengthSeconds: 5, uploads: 'presigned' });
    expect(calls.map((c) => c.url)).toEqual(['https://app.ludy.vn/api/files/uploads', 'https://bucket.example/stage', 'https://app.ludy.vn/api/meetings/11111111-1111-4111-8111-111111111111/media']);
    expect(calls[1]!.auth).toBeNull();
  });

  it('refuses a granted upload address that is not plain https', () => {
    expect(() => assertGrantUrl('http://bucket.example/stage')).toThrow(/Refused/);
    expect(() => assertGrantUrl('https://u:p@bucket.example/stage')).toThrow(/Refused/);
    expect(assertGrantUrl('https://bucket.example/stage').hostname).toBe('bucket.example');
  });
});
