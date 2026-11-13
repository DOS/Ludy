// SPDX-License-Identifier: AGPL-3.0-only
// An image given only by a reference (WhatsApp's media id, #3131): the adapter turns it into bytes with the connection's token, and every byte of that call goes
// through the egress guard of @crove/kernel-runtime: the provider's media hosts only, https only on the real path, no redirect followed (the token is never
// sent to a second host), a byte cap, and the bytes are an image only if their first bytes say so. The guard's own options (a local server, any port, http)
// are the tests' alone.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationAdapter, ConversationMediaInput } from '@crove/channel';
import { fetchConversationMedia, mediaHostsOf } from '../src/conversation-media.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const SECRET = JSON.stringify({ accessToken: 'tok-not-real-0123456789abcdef', wabaId: '204000000000001' });
const egress = { allowed: () => true, anyPort: true, httpsOnly: false };

describe('fetchConversationMedia', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ url: string; authorization: string | undefined; accept: string | undefined }> = [];
  const answers = new Map<string, { status?: number; body: Buffer | string; location?: string }>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization, accept: req.headers.accept });
      const answer = answers.get(req.url ?? '');
      if (!answer) return void res.writeHead(404).end();
      res.writeHead(answer.status ?? 200, { ...(answer.location ? { location: answer.location } : {}) });
      res.end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  // An adapter that fetches the address it is told to with the guarded fetch it is given, as the real one does after Meta's first call.
  const adapterFor = (path: string, host = '127.0.0.1'): ConversationAdapter & { inputs: ConversationMediaInput[] } => {
    const inputs: ConversationMediaInput[] = [];
    return {
      provider: 'whatsapp',
      inputs,
      reply: async () => ({ kind: 'unknown' }),
      media: async (input) => {
        inputs.push(input);
        const url = new URL(`${base}${path}`);
        url.hostname = host;
        const response = await input.fetch(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${JSON.parse(input.secret).accessToken}` } });
        if (response.status !== 200) return { kind: 'failed', retry: false, code: `HTTP_${response.status}` };
        return { kind: 'ok', bytes: new Uint8Array(await response.arrayBuffer()) };
      },
    };
  };
  const run = (adapter: ConversationAdapter, hosts: readonly string[] = ['127.0.0.1']) => fetchConversationMedia(adapter, { externalAccountId: '104000000000001', secret: SECRET, mediaRef: '555111222333', hosts, egress });

  it('hands the adapter the credential, the reference, the host list and a cap, and returns the image its bytes make', async () => {
    answers.set('/a.png', { body: PNG });
    const adapter = adapterFor('/a.png');
    expect(await run(adapter)).toMatchObject({ kind: 'image', contentType: 'image/png', width: 2, height: 3 });
    expect(adapter.inputs[0]).toMatchObject({ externalAccountId: '104000000000001', mediaRef: '555111222333', hosts: ['127.0.0.1'], maxBytes: 5 * 1024 * 1024 });
    // The token goes in the request's header, to the first host only, and the call asks for images.
    expect(seen.at(-1)).toMatchObject({ url: '/a.png', authorization: 'Bearer tok-not-real-0123456789abcdef', accept: 'image/jpeg, image/png, image/webp, image/gif' });
  });

  it('sends the token to no host outside the list, and follows no redirect', async () => {
    answers.set('/b.png', { body: PNG });
    const before = seen.length;
    // A host the list does not name is refused by the guard before anything is resolved or sent.
    expect(await run(adapterFor('/b.png'), ['fbsbx.com'])).toMatchObject({ kind: 'failed' });
    expect(seen).toHaveLength(before);
    // A redirect (to another host or the same) is the answer, never followed: the adapter sees a 3xx and the token goes nowhere else.
    answers.set('/c.png', { status: 302, body: '', location: `${base}/b.png` });
    expect(await run(adapterFor('/c.png'))).toEqual({ kind: 'failed', retry: false, code: 'HTTP_302' });
    expect(seen.filter((s) => s.url === '/b.png')).toHaveLength(0);
  });

  it('refuses what is not an image, what is empty, what is over the cap, and an adapter that has no media call or throws', async () => {
    answers.set('/svg', { body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    expect(await run(adapterFor('/svg'))).toEqual({ kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' });
    answers.set('/empty', { body: '' });
    expect(await run(adapterFor('/empty'))).toMatchObject({ kind: 'failed', retry: false });
    answers.set('/big', { body: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]) });
    expect(await run(adapterFor('/big'))).toMatchObject({ kind: 'failed' });
    expect(await run({ provider: 'whatsapp', reply: async () => ({ kind: 'unknown' }) })).toEqual({ kind: 'failed', retry: false, code: 'NO_MEDIA_ADAPTER' });
    expect(await run({ provider: 'whatsapp', reply: async () => ({ kind: 'unknown' }), media: async () => { throw new Error('boom'); } })).toEqual({ kind: 'failed', retry: true, code: 'MEDIA_ADAPTER_ERROR' });
    // The adapter's own refusal keeps its retry flag and its short code.
    expect(await run({ provider: 'whatsapp', reply: async () => ({ kind: 'unknown' }), media: async () => ({ kind: 'failed', retry: true, code: 'WA_MEDIA_BUSY' }) })).toEqual({ kind: 'failed', retry: true, code: 'WA_MEDIA_BUSY' });
  });
});

describe('mediaHostsOf', () => {
  it('has WhatsApp’s own list, replaced by the deployment’s when it names one, and none for a provider with no list', () => {
    expect(mediaHostsOf('whatsapp', undefined)).toEqual(['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com']);
    expect(mediaHostsOf('whatsapp', undefined, { whatsapp: [] })).toEqual(['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com']);
    expect(mediaHostsOf('whatsapp', undefined, { whatsapp: ['media.example.test'] })).toEqual(['media.example.test']);
    // Zalo's list is its own and is not changed by WhatsApp's.
    expect(mediaHostsOf('zalo_oa', undefined, { whatsapp: ['media.example.test'] })).toContain('zdn.vn');
    expect(mediaHostsOf('telegram', undefined)).toEqual([]);
  });
});
