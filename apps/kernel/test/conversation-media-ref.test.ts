// SPDX-License-Identifier: AGPL-3.0-only
// An image given only by a reference (WhatsApp's media id, #3131): the adapter turns it into bytes with the connection's token, and every byte of that call goes
// through the egress guard of @ludy/kernel-runtime: the provider's media hosts only, https only on the real path, no redirect followed (the token is never
// sent to a second host), a byte cap, and the bytes are an image only if their first bytes say so. The guard's own options (a local server, any port, http)
// are the tests' alone.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TELEGRAM_PHOTO_MAX_BYTES, type ConversationAdapter, type ConversationMediaInput } from '@ludy/channel';
import { CONVERSATION_IMAGE_MAX_BYTES } from '@ludy/kernel-contract';
import { CredentialVault, parseVaultKey, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { fetchConversationMedia, mediaHostsOf } from '../src/conversation-media.ts';
import { runConversationAttachment } from '../src/conversations-worker.ts';

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
      res.writeHead(answer.status ?? 200, answer.location ? { location: answer.location } : {});
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
    // A provider with no list has no allowed host.
    expect(mediaHostsOf('linkedin_page', undefined)).toEqual([]);
  });

  it('has Telegram\'s one host, the Bot API\'s own, which no deployment list changes (#3192)', () => {
    expect(mediaHostsOf('telegram', undefined)).toEqual(['api.telegram.org']);
    expect(mediaHostsOf('telegram', ['media.example.test'], { telegram: ['media.example.test'], whatsapp: ['media.example.test'] })).toEqual(['api.telegram.org']);
  });

  it('holds the Telegram package\'s cap to the core\'s (the package does not import the contract)', () => {
    expect(TELEGRAM_PHOTO_MAX_BYTES).toBe(CONVERSATION_IMAGE_MAX_BYTES);
  });
});

describe('runConversationAttachment mismatch guards (#3152)', () => {
  const store: BlobStore = {
    put: async () => 'gen-1',
    get: async () => new Uint8Array(),
    delete: async () => undefined,
  };

  it('fails closed with ATTACHMENT_CONNECTION_MISMATCH before querying credentials or modifying the row', async () => {
    const queries: string[] = [];
    const recorded: unknown[] = [];
    let mediaCalled = 0;
    const runtime = {
      query: async (name: string) => {
        queries.push(name);
        if (name === 'kernel.conversation.attachment_source') {
          return { connectionId: randomUUID(), provider: 'whatsapp', sourceUrl: null, mediaRef: '555111222333', storageKey: 'k1' };
        }
        throw new Error(`unexpected query ${name}`);
      },
      execute: async (name: string, input: unknown) => {
        if (name === 'kernel.conversation.attachment_record') recorded.push(input);
        return { recorded: true };
      },
    } as unknown as Runtime;
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const adapter: ConversationAdapter = {
      provider: 'whatsapp',
      reply: async () => ({ kind: 'unknown' }),
      media: async () => {
        mediaCalled++;
        return { kind: 'ok', bytes: PNG };
      },
    };
    const outcome = await runConversationAttachment(
      { runtime, store, broker: vault, adapter: () => adapter, egress },
      { orgId: randomUUID(), connectionId: randomUUID(), action: 'attachment', attachmentId: randomUUID() },
    );
    expect(outcome).toBe('ATTACHMENT_CONNECTION_MISMATCH');
    expect(queries).toEqual(['kernel.conversation.attachment_source']);
    expect(mediaCalled).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('fails closed with ATTACHMENT_PROVIDER_MISMATCH when opened credential provider differs from attachment source provider', async () => {
    const orgId = randomUUID();
    const connectionId = randomUUID();
    const attachmentId = randomUUID();
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const sealed = vault.seal(JSON.stringify({ botToken: '123:abc' }), { orgId, provider: 'telegram', externalAccountId: 'tg-acc-1' });
    const recorded: unknown[] = [];
    let mediaCalled = 0;
    const runtime = {
      query: async (name: string) => {
        if (name === 'kernel.conversation.attachment_source') {
          return { connectionId, provider: 'whatsapp', sourceUrl: null, mediaRef: '555111222333', storageKey: 'k1' };
        }
        if (name === 'kernel.channel.credential') {
          return { provider: 'telegram', externalAccountId: 'tg-acc-1', keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') };
        }
        throw new Error(`unexpected query ${name}`);
      },
      execute: async (name: string, input: unknown) => {
        if (name === 'kernel.conversation.attachment_record') recorded.push(input);
        return { recorded: true };
      },
    } as unknown as Runtime;
    const adapter: ConversationAdapter = {
      provider: 'whatsapp',
      reply: async () => ({ kind: 'unknown' }),
      media: async () => {
        mediaCalled++;
        return { kind: 'ok', bytes: PNG };
      },
    };
    const outcome = await runConversationAttachment(
      { runtime, store, broker: vault, adapter: () => adapter, egress },
      { orgId, connectionId, action: 'attachment', attachmentId },
    );
    expect(outcome).toBe('dropped');
    expect(mediaCalled).toBe(0);
    expect(recorded).toEqual([{ outcome: 'failed', attachmentId, retry: false, code: 'ATTACHMENT_PROVIDER_MISMATCH' }]);
  });
});
