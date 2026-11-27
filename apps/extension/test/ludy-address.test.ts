// SPDX-License-Identifier: AGPL-3.0-only
// The split Ludy Cloud addresses (App vs API), and the rule that no network request goes anywhere but the API origin.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_ADDRESS, DEFAULT_APP_ADDRESS, ludyUrl, originPattern, parseAddress } from '../src/ludy-address.ts';
import { assertGrantUrl, createClient, LudyError } from '../src/api.ts';

describe('default Ludy Cloud split origins and parseAddress', () => {
  it('defaults to separate app.ludy.vn and api.ludy.vn origins', () => {
    expect(DEFAULT_APP_ADDRESS).toBe('https://app.ludy.vn');
    expect(DEFAULT_API_ADDRESS).toBe('https://api.ludy.vn');
    expect(originPattern(DEFAULT_APP_ADDRESS)).toBe('https://app.ludy.vn/*');
    expect(originPattern(DEFAULT_API_ADDRESS)).toBe('https://api.ludy.vn/*');
  });

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
    ['http://127.0.0.1:8080', 'insecure'],
    ['http://[::1]:8080', 'insecure'],
    ['https://user:pw@ludy.congty.vn', 'credentials'],
    ['javascript:alert(1)', 'invalid'],
    ['ftp://ludy.congty.vn', 'invalid'],
    ['https://*', 'invalid'],
    ['https://*.example.com', 'invalid'],
    ['https://a*.example.com', 'invalid'],
  ])('refuses %s', (input, problem) => {
    expect(parseAddress(input)).toEqual({ problem });
  });

  it('allows http://127.0.0.1 only when allowLoopbackIp is explicitly enabled for local test builds', () => {
    expect(parseAddress('http://127.0.0.1:8080', { allowLoopbackIp: true })).toEqual({ origin: 'http://127.0.0.1:8080' });
    expect(originPattern('https://ludy.congty.vn:8443')).toBe('https://ludy.congty.vn/*');
  });
});

describe('no request goes anywhere but the configured API origin', () => {
  it.each(['https://evil.example/api/config', '//evil.example/x', '/\\evil.example', 'api/config', 'http://api.ludy.vn/x'])('ludyUrl refuses %s', (path) => {
    expect(() => ludyUrl('https://api.ludy.vn', path)).toThrow(/Refused/);
  });

  it('every call of the client is made on the configured API origin, without cookies', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      urls.push(input);
      expect(init?.credentials).toBe('omit');
      return Response.json({ json: { meetingId: 'm1' }, uploads: 'direct', fileId: 'f1', features: {}, token: 't', tokenId: 'i', orgId: 'o', scopes: ['meetings'], expiresAt: 'x' });
    });
    const client = createClient('https://api.ludy.vn', 'crx_abc', fetchImpl);
    await client.config();
    await client.exchangeCode('crc_x', 'v'.repeat(43));
    await client.me();
    await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'in_invite', liveNotes: false });
    await client.uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'audio', file: new File(['a'], 'a.webm'), lengthSeconds: 1, uploads: 'direct' });
    expect(urls).toHaveLength(5);
    for (const url of urls) expect(new URL(url).origin).toBe('https://api.ludy.vn');
  });

  it('a live piece goes to its meeting with the seq, the length, the audio type and the token; a refusal carries its status', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    let status = 200;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, init });
      return status === 200 ? Response.json({ meetingId: 'm', seq: 3, duplicate: false }) : Response.json({ code: 'LIVE_CLOSED', message: 'closed' }, { status });
    });
    const client = createClient('https://api.ludy.vn', 'crx_abc', fetchImpl);
    await client.sendLiveChunk({ meetingId: 'm 1', seq: 3, lengthSeconds: 15, blob: new Blob(['a'], { type: 'audio/webm;codecs=opus' }) });
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.ludy.vn/api/meetings/m%201/live-chunk');
    expect(url.searchParams.get('seq')).toBe('3');
    expect(url.searchParams.get('lengthSeconds')).toBe('15');
    const headers = new Headers(seen[0]!.init?.headers);
    expect(headers.get('content-type')).toBe('audio/webm');
    expect(headers.get('authorization')).toBe('Bearer crx_abc');
    expect(seen[0]!.init?.credentials).toBe('omit');
    await client.sendLiveChunk({ meetingId: 'm', seq: 0, lengthSeconds: 1, blob: new Blob(['a']) });
    expect(new Headers(seen[1]!.init?.headers).get('content-type')).toBe('application/octet-stream');
    status = 409;
    await expect(client.sendLiveChunk({ meetingId: 'm', seq: 1, lengthSeconds: 1, blob: new Blob(['a']) })).rejects.toMatchObject({ status: 409, code: 'LIVE_CLOSED' });
  });

  it('createMeeting sends liveNotes as given', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ json: { meetingId: 'm1' } });
    });
    const client = createClient('https://api.ludy.vn', 'crx_abc', fetchImpl);
    await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'in_invite', liveNotes: true });
    await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'in_invite', liveNotes: false });
    expect(bodies.map((b) => (b as { json: { liveNotes: boolean } }).json.liveNotes)).toEqual([true, false]);
  });

  it('a call that needs the token makes no request without one', async () => {
    const fetchImpl = vi.fn();
    await expect(createClient('https://api.ludy.vn', null, fetchImpl).me()).rejects.toBeInstanceOf(LudyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a path that would leave the origin is refused before any request', async () => {
    const fetchImpl = vi.fn();
    const client = createClient('https://api.ludy.vn', 't', fetchImpl);
    await expect(client.uploadMedia({ meetingId: '../../..//evil.example', kind: 'audio', file: new File(['a'], 'a.webm'), lengthSeconds: 1, uploads: 'direct' })).rejects.toBeDefined();
    for (const [url] of fetchImpl.mock.calls) expect(new URL(url as string).origin).toBe('https://api.ludy.vn');
  });

  it('a staged upload goes to the address the configured server granted, https only, with no token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, auth: new Headers(init?.headers).get('authorization') });
      if (input.endsWith('/api/files/uploads')) return Response.json({ uploadId: 'u1', url: 'https://bucket.example/stage', fields: { key: 'k' } });
      return Response.json({ fileId: 'f1' });
    });
    await createClient('https://api.ludy.vn', 'crx_t', fetchImpl).uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'video', file: new File(['v'], 'v.webm'), lengthSeconds: 5, uploads: 'presigned' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.ludy.vn/api/files/uploads', 'https://bucket.example/stage', 'https://api.ludy.vn/api/meetings/11111111-1111-4111-8111-111111111111/media']);
    expect(calls[1]!.auth).toBeNull();
  });

  it('refuses a granted upload address that is not plain https', () => {
    const cloud = 'https://api.ludy.vn';
    expect(() => assertGrantUrl('http://bucket.example/stage', cloud)).toThrow(/Refused/);
    expect(() => assertGrantUrl('https://u:p@bucket.example/stage', cloud)).toThrow(/Refused/);
    expect(assertGrantUrl('https://bucket.example/stage', cloud).hostname).toBe('bucket.example');
  });

  it('accepts an http loopback grant only when the configured address is itself http on localhost', () => {
    expect(assertGrantUrl('http://localhost:9000/stage', 'http://localhost:8080').hostname).toBe('localhost');
    // A remote https server cannot point the upload at the member's own machine.
    expect(() => assertGrantUrl('http://localhost:9000/stage', 'https://ludy.congty.vn')).toThrow(/Refused/);
    expect(() => assertGrantUrl('http://127.0.0.1:9000/stage', 'http://localhost:8080')).toThrow(/Refused/);
    expect(() => assertGrantUrl('http://bucket.example/stage', 'http://localhost:8080')).toThrow(/Refused/);
  });

  it('a direct upload sends the file itself as the body, with its type and the kind and length in the query', async () => {
    const seen: Array<{ url: string; type: string | null; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, type: new Headers(init?.headers).get('content-type'), body: init?.body });
      return Response.json({ fileId: 'f1' });
    });
    const file = new File(['abc'], 'a.webm', { type: 'video/webm' });
    await createClient('https://api.ludy.vn', 'crx_t', fetchImpl).uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'video', file, lengthSeconds: 90, uploads: 'direct' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.ludy.vn/api/meetings/11111111-1111-4111-8111-111111111111/media?kind=video&lengthSeconds=90');
    expect(seen[0]!.type).toBe('video/webm');
    expect(seen[0]!.body).toBe(file);
    // A type that is not audio or video goes as an opaque body.
    await createClient('https://api.ludy.vn', 'crx_t', fetchImpl).uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'audio', file: new File(['x'], 'a.bin', { type: 'text/html' }), lengthSeconds: 1, uploads: 'direct' });
    expect(seen[1]!.type).toBe('application/octet-stream');
  });

  it('never follows a redirect: every request says so', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push(init);
      if (input.endsWith('/api/files/uploads')) return Response.json({ uploadId: 'u1', url: 'https://bucket.example/stage', fields: {} });
      return Response.json({ fileId: 'f1', json: { meetingId: 'm' }, uploads: 'direct', features: {} });
    });
    const client = createClient('https://api.ludy.vn', 'crx_t', fetchImpl);
    await client.config();
    await client.me();
    await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'in_invite', liveNotes: false });
    await client.uploadMedia({ meetingId: '11111111-1111-4111-8111-111111111111', kind: 'audio', file: new File(['a'], 'a.webm'), lengthSeconds: 1, uploads: 'presigned' });
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const init of seen) expect(init?.redirect).toBe('error');
  });
});
