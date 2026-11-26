// SPDX-License-Identifier: AGPL-3.0-only
// Invariant checks for WhatsApp media egress and attachment job connection/provider binding (#3152).
// Self-contained under test/invariant/: verifies allowlist boundaries, HTTPS/userinfo/redirect/private-IP/size/sniffing
// enforcement across WhatsAppConversations.media, fetchConversationMedia + egressFetch, and runConversationAttachment.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Graph, WHATSAPP_MEDIA_HOSTS, WhatsAppConversations, mediaHostAllowed, type ConversationAdapter, type Fetch } from '@ludy/channel';
import { CONVERSATION_IMAGE_MAX_BYTES } from '@ludy/kernel-contract';
import { CredentialVault, EgressError, parseVaultKey, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { fetchConversationMedia, mediaHostsOf } from '../../src/conversation-media.ts';
import { runConversationAttachment } from '../../src/conversations-worker.ts';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);
const APP_SECRET = 'wa-invariant-app-secret-not-real-0001';
const ACCESS_TOKEN = 'EAAG-wa-invariant-token-0123456789abcdef';
const SECRET = JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '204000000000001' });
// Upper-bound set of known Meta/WhatsApp media suffixes so future narrowing (e.g. #5042 to exact subdomains) remains valid against base invariants.
const META_WHATSAPP_HOST_SUPERSET = ['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com'] as const;
const SYNTHETIC_ALLOWED_HOSTS = ['fbsbx.com', 'whatsapp.net'] as const;

function graphFor(payload: unknown): { adapter: WhatsAppConversations; graphCalls: string[] } {
  const graphCalls: string[] = [];
  const fetchImpl: Fetch = async (input) => {
    graphCalls.push(input);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { adapter: new WhatsAppConversations(new Graph(APP_SECRET, undefined, fetchImpl)), graphCalls };
}

describe('WhatsApp media host allowlist invariants (#3152)', () => {
  it('enforces label-boundary matching, keeps default WhatsApp hosts bounded, and rejects spoofed or local hosts', () => {
    for (const allowedHost of ['fbsbx.com', 'lookaside.fbsbx.com', 'whatsapp.net', 'mmg.whatsapp.net']) {
      expect(mediaHostAllowed(allowedHost, SYNTHETIC_ALLOWED_HOSTS), allowedHost).toBe(true);
    }
    const defaults = mediaHostsOf('whatsapp', undefined);
    expect(defaults).toEqual(WHATSAPP_MEDIA_HOSTS);
    expect(defaults.length).toBeGreaterThan(0);
    for (const suffix of defaults) {
      expect(suffix.length > 0 && !suffix.startsWith('.'), suffix).toBe(true);
      expect(mediaHostAllowed(suffix, META_WHATSAPP_HOST_SUPERSET), suffix).toBe(true);
    }
    for (const blockedHost of [
      '',
      'notfbsbx.com',
      'fbsbx.com.evil.test',
      'fbcdn.net.attacker.test',
      'evilwhatsapp.com',
      'whatsapp.net.example.com',
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
    ]) {
      expect(mediaHostAllowed(blockedHost, SYNTHETIC_ALLOWED_HOSTS), blockedHost).toBe(false);
      expect(mediaHostAllowed(blockedHost, defaults), blockedHost).toBe(false);
    }
  });

  it('keeps WhatsApp host overrides isolated from other providers', () => {
    expect(mediaHostsOf('whatsapp', undefined, { whatsapp: ['wa-media.example.test'] })).toEqual(['wa-media.example.test']);
    expect(mediaHostsOf('facebook_page', undefined, { whatsapp: ['wa-media.example.test'] })).not.toContain('wa-media.example.test');
    expect(mediaHostsOf('telegram', undefined, { whatsapp: ['wa-media.example.test'] })).toEqual(['api.telegram.org']);
    expect(mediaHostsOf('zalo_oa', undefined, { whatsapp: ['wa-media.example.test'] })).not.toContain('wa-media.example.test');
  });
});

describe('WhatsApp media egress guard invariants (#3152)', () => {
  let server: Server | undefined;
  let base = '';
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const routes = new Map<string, { status?: number; body: Buffer | string; location?: string }>();

  beforeAll(async () => {
    const srv = createServer((req, res) => {
      requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      const route = routes.get(req.url ?? '');
      if (!route) return void res.writeHead(404).end();
      res.writeHead(route.status ?? 200, route.location ? { location: route.location } : {});
      res.end(route.body);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    server = srv;
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('refuses non-https URLs, userinfo credentials, lookalike/unlisted hosts, oversized URLs, and oversized file_size before egress', async () => {
    const testHosts = ['fbsbx.com', 'example.com'];
    const forbiddenUrls: Array<[string, string]> = [
      ['http://lookaside.fbsbx.com/wa/media.png', 'WA_MEDIA_HOST'],
      ['https://tok:pw@lookaside.fbsbx.com/wa/media.png', 'WA_MEDIA_HOST'],
      ['https://user@example.com/wa/media.png', 'WA_MEDIA_HOST'],
      ['https://notfbsbx.com/wa/media.png', 'WA_MEDIA_HOST'],
      ['https://fbsbx.com.evil.test/wa/media.png', 'WA_MEDIA_HOST'],
      ['https://127.0.0.1/wa/media.png', 'WA_MEDIA_HOST'],
      [`https://lookaside.fbsbx.com/${'a'.repeat(2000)}`, 'WA_MEDIA_HOST'],
      ['not-a-url', 'WA_MEDIA_URL'],
    ];
    for (const [badUrl, expectedCode] of forbiddenUrls) {
      let fetchCalled = 0;
      const { adapter } = graphFor({ url: badUrl, file_size: 128 });
      const res = await adapter.media({
        externalAccountId: '104000000000001',
        secret: SECRET,
        mediaRef: '555111222333',
        hosts: testHosts,
        maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
        fetch: async () => {
          fetchCalled++;
          return new Response(PNG, { status: 200 });
        },
      });
      expect(res, badUrl).toEqual({ kind: 'failed', retry: false, code: expectedCode });
      expect(fetchCalled, badUrl).toBe(0);
    }

    let oversizeFetchCalled = 0;
    const { adapter: sizeAdapter } = graphFor({
      url: 'https://lookaside.fbsbx.com/wa/media.png',
      file_size: CONVERSATION_IMAGE_MAX_BYTES + 1,
    });
    const sizeRes = await sizeAdapter.media({
      externalAccountId: '104000000000001',
      secret: SECRET,
      mediaRef: '555111222333',
      hosts: testHosts,
      maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
      fetch: async () => {
        oversizeFetchCalled++;
        return new Response(PNG, { status: 200 });
      },
    });
    expect(sizeRes).toEqual({ kind: 'failed', retry: false, code: 'BAD_SIZE' });
    expect(oversizeFetchCalled).toBe(0);

    // Direct EgressError('too_large') returned by input.fetch fails permanently (retry: false).
    const { adapter: tooLargeAdapter } = graphFor({ url: 'https://lookaside.fbsbx.com/wa/media.png', file_size: 128 });
    const tooLargeRes = await tooLargeAdapter.media({
      externalAccountId: '104000000000001',
      secret: SECRET,
      mediaRef: '555111222333',
      hosts: testHosts,
      maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
      fetch: async () => {
        throw new EgressError('too_large', 'the response is too large');
      },
    });
    expect(tooLargeRes).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_FETCH' });

    // Real WhatsAppConversations.media never manually follows a 3xx redirect returned by input.fetch (called exactly once).
    let redirectCalls = 0;
    const { adapter: redirectAdapter } = graphFor({ url: 'https://lookaside.fbsbx.com/wa/media.png', file_size: 128 });
    const redirectRes = await redirectAdapter.media({
      externalAccountId: '104000000000001',
      secret: SECRET,
      mediaRef: '555111222333',
      hosts: testHosts,
      maxBytes: CONVERSATION_IMAGE_MAX_BYTES,
      fetch: async () => {
        redirectCalls++;
        return new Response(null, { status: 302, headers: { location: 'https://lookaside.fbsbx.com/wa/next.png' } });
      },
    });
    expect(redirectRes).toEqual({ kind: 'failed', retry: false, code: 'HTTP_302' });
    expect(redirectCalls).toBe(1);
  });

  it('blocks private, loopback, and link-local IP resolutions through the real egress guard', async () => {
    for (const privateIp of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1']) {
      const { adapter } = graphFor({ url: 'https://lookaside.fbsbx.com/wa/media.png', file_size: PNG.byteLength });
      const res = await fetchConversationMedia(adapter, {
        externalAccountId: '104000000000001',
        secret: SECRET,
        mediaRef: '555111222333',
        hosts: ['fbsbx.com'],
        egress: {
          resolve: async () => [{ address: privateIp, family: 4 }],
        },
      });
      expect(res, privateIp).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_FETCH' });
    }
  });

  it('never follows 3xx redirects, enforces streamed byte limits, and rejects non-image content types', async () => {
    routes.set('/secret-target.png', { body: PNG });
    routes.set('/redirect', { status: 302, body: '', location: `${base}/secret-target.png` });
    routes.set('/svg', { body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    routes.set('/html', { body: '<html><body>not an image</body></html>' });
    routes.set('/empty', { body: '' });
    routes.set('/too-big', { body: Buffer.concat([PNG, Buffer.alloc(CONVERSATION_IMAGE_MAX_BYTES + 1)]) });

    // Mirrors WhatsAppConversations.media's EgressError mapping over the real egress-guarded fetch.
    const localAdapterFor = (path: string): ConversationAdapter => ({
      provider: 'whatsapp',
      reply: async () => ({ kind: 'unknown' }),
      media: async (input) => {
        let response: Response;
        try {
          response = await input.fetch(`${base}${path}`, {
            method: 'GET',
            headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
          });
        } catch (error) {
          const transient = error instanceof EgressError && (error.code === 'dns' || error.code === 'timeout' || error.code === 'network');
          return { kind: 'failed', retry: transient, code: 'WA_MEDIA_FETCH' };
        }
        if (response.status !== 200) return { kind: 'failed', retry: false, code: `HTTP_${response.status}` };
        return { kind: 'ok', bytes: new Uint8Array(await response.arrayBuffer()) };
      },
    });
    const localEgress = { allowed: () => true, anyPort: true, httpsOnly: false };
    const runLocal = (path: string, hosts: readonly string[] = ['127.0.0.1']) =>
      fetchConversationMedia(localAdapterFor(path), {
        externalAccountId: '104000000000001',
        secret: SECRET,
        mediaRef: '555111222333',
        hosts,
        egress: localEgress,
      });

    // Redirect is returned directly as HTTP_302 and never delivers Authorization to /secret-target.png.
    const beforeReqCount = requests.length;
    expect(await runLocal('/redirect')).toEqual({ kind: 'failed', retry: false, code: 'HTTP_302' });
    expect(requests.slice(beforeReqCount).filter((r) => r.url === '/secret-target.png')).toHaveLength(0);

    // Non-image, empty, and over-limit streamed responses fail permanently without retry.
    expect(await runLocal('/svg')).toEqual({ kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' });
    expect(await runLocal('/html')).toEqual({ kind: 'failed', retry: false, code: 'NOT_AN_IMAGE' });
    expect(await runLocal('/empty')).toEqual({ kind: 'failed', retry: false, code: 'BAD_SIZE' });
    expect(await runLocal('/too-big')).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_FETCH' });

    // Fetch-layer hostAllowed rejects hosts absent from the allowlist before hitting the local server.
    const beforeBlockedCount = requests.length;
    expect(await runLocal('/secret-target.png', ['fbsbx.com'])).toEqual({ kind: 'failed', retry: false, code: 'WA_MEDIA_FETCH' });
    expect(requests).toHaveLength(beforeBlockedCount);

    // Valid image succeeds when host is allowlisted.
    expect(await runLocal('/secret-target.png')).toMatchObject({ kind: 'image', contentType: 'image/png', width: 2, height: 3 });
  });

  it('fails closed in runConversationAttachment when connectionId or opened provider disagrees (#3152)', async () => {
    const store: BlobStore = {
      put: async () => 'gen-1',
      get: async () => new Uint8Array(),
      delete: async () => undefined,
    };
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const localEgress = { allowed: () => true, anyPort: true, httpsOnly: false };

    // Connection id mismatch fails closed without querying credentials, invoking adapter.media, or deleting the owning row.
    const recordedConn: unknown[] = [];
    const queriesConn: string[] = [];
    let adapterCalled = 0;
    const runtimeConn = {
      query: async (name: string) => {
        queriesConn.push(name);
        return { connectionId: randomUUID(), provider: 'whatsapp', sourceUrl: null, mediaRef: '555111222333', storageKey: 'k1' };
      },
      execute: async (name: string, input: unknown) => {
        if (name === 'kernel.conversation.attachment_record') recordedConn.push(input);
        return { recorded: true };
      },
    } as unknown as Runtime;
    const spyAdapter: ConversationAdapter = {
      provider: 'whatsapp',
      reply: async () => ({ kind: 'unknown' }),
      media: async () => {
        adapterCalled++;
        return { kind: 'ok', bytes: PNG };
      },
    };
    expect(
      await runConversationAttachment(
        { runtime: runtimeConn, store, broker: vault, adapter: () => spyAdapter, egress: localEgress },
        { orgId: randomUUID(), connectionId: randomUUID(), action: 'attachment', attachmentId: randomUUID() },
      ),
    ).toBe('ATTACHMENT_CONNECTION_MISMATCH');
    expect(queriesConn).toEqual(['kernel.conversation.attachment_source']);
    expect(adapterCalled).toBe(0);
    expect(recordedConn).toEqual([]);

    // Opened credential provider mismatch drops before invoking adapter.media or egress.
    const orgId = randomUUID();
    const connectionId = randomUUID();
    const attachmentId = randomUUID();
    const sealedOther = vault.seal(JSON.stringify({ botToken: '123:abc' }), { orgId, provider: 'telegram', externalAccountId: 'tg-1' });
    const recordedProv: unknown[] = [];
    const runtimeProv = {
      query: async (name: string) => {
        if (name === 'kernel.conversation.attachment_source') {
          return { connectionId, provider: 'whatsapp', sourceUrl: null, mediaRef: '555111222333', storageKey: 'k2' };
        }
        return { provider: 'telegram', externalAccountId: 'tg-1', keyId: sealedOther.keyId, envelope: sealedOther.envelope.toString('base64') };
      },
      execute: async (name: string, input: unknown) => {
        if (name === 'kernel.conversation.attachment_record') recordedProv.push(input);
        return { recorded: true };
      },
    } as unknown as Runtime;
    expect(
      await runConversationAttachment(
        { runtime: runtimeProv, store, broker: vault, adapter: () => spyAdapter, egress: localEgress },
        { orgId, connectionId, action: 'attachment', attachmentId },
      ),
    ).toBe('dropped');
    expect(adapterCalled).toBe(0);
    expect(recordedProv).toEqual([{ outcome: 'failed', attachmentId, retry: false, code: 'ATTACHMENT_PROVIDER_MISMATCH' }]);
  });
});
