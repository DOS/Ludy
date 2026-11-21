// SPDX-License-Identifier: AGPL-3.0-only
// A Teams recording download through the REAL egress guard (meetings integrations C4, #3176): the adapter's own description of the request, a local server standing in for Graph and SharePoint by the
// guard's test resolver, and redirects to hosts that are not Microsoft's. Only the scheme and port of the address are swapped for the local server; the hosts, the suffix and the headers are the
// adapter's own. The first host is exact (Graph), a redirect may go only to SharePoint, and the member's token never leaves the first host.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { minimalMp4, TeamsMeetingPlatform, type MeetingPlatformAdapter } from '@crove/channel';
import { LocalDiskStore } from '@crove/kernel-runtime';
import type { MediaExtractClient } from '@crove/media-contract/extract';
import { createMediaAudioExtractor } from '../src/meetings-extract.ts';
import { runMeetingsImport, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'c'.repeat(64)}`;
const OPUS = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);
// The list's id of an occurrence: the online meeting and its start and end in seconds (2026-11-17 02:00 to 03:00 UTC).
const MEETING = `MSo1N2Y5ZGFjYy1BQUFB~${Date.parse('2026-11-17T02:00:00Z') / 1000}~${Date.parse('2026-11-17T03:00:00Z') / 1000}`;
const RECORDINGS = { value: [{ id: '7e31db25-bc6e-4fd8-96c7-e01264e9b6fc', createdDateTime: '2026-11-17T03:00:00Z', recordingContentUrl: 'https://graph.microsoft.com/ignored' }] };
const job = (): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'sandbox',
  externalId: MEETING,
  hasAudio: false,
  hasVideo: true,
  sizeBytes: null,
  stagingKey: KEY,
});
const attempt = { retryCount: 0, retryLimit: 3 };
const mp4 = (() => {
  const out = new Uint8Array(3000);
  out.set(minimalMp4());
  for (let i = 24; i < out.length; i++) out[i] = i % 251;
  return out;
})();

describe('a Teams recording download (the redirect rules)', () => {
  let server: Server;
  let port = 0;
  let dir: string;
  let store: LocalDiskStore;
  const seen: Array<{ host: string; path: string; authorization: string | undefined }> = [];
  const resolveMap: Record<string, string> = {
    'graph.microsoft.com': '127.0.0.1',
    'contoso-my.sharepoint.com': '127.0.0.1',
    'sharepoint.com': '127.0.0.1',
    'evil.example.test': '127.0.0.1',
    'sharepoint.com.evil.example.test': '127.0.0.1',
    'notsharepoint.com': '127.0.0.1',
    'microsoft.com': '127.0.0.1',
    'login.microsoftonline.com': '127.0.0.1',
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crove-import-teams-'));
    store = new LocalDiskStore(dir);
    server = createServer((req, res) => {
      const host = String(req.headers.host ?? '').split(':')[0] ?? '';
      const path = req.url ?? '/';
      seen.push({ host, path, authorization: req.headers.authorization });
      const to = (target: string, to_path = '/steal') => {
        res.writeHead(302, { location: `http://${target}:${port}${to_path}` });
        res.end();
      };
      if (path === '/file') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(mp4.byteLength) });
        res.end(mp4);
      } else if (path === '/to-sharepoint') to('contoso-my.sharepoint.com', '/file');
      else if (path === '/to-evil') to('evil.example.test');
      else if (path === '/to-lookalike') to('sharepoint.com.evil.example.test');
      else if (path === '/to-suffix-lookalike') to('notsharepoint.com');
      else if (path === '/to-other-microsoft') to('microsoft.com');
      else if (path === '/to-login') to('login.microsoftonline.com');
      else {
        res.writeHead(200, { 'content-length': '0' });
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await store.delete(KEY);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  // The adapter, answering "which file" from a mocked Graph, with the content address pointing at the local server (the file itself is the job's to fetch, through the guard).
  function teamsAt(path: string): MeetingPlatformAdapter {
    const real = new TeamsMeetingPlatform({ clientId: '11111111-2222-4333-8444-555555555555', clientSecret: 'teams-client-secret-not-real' }, { fetch: async () => new Response(JSON.stringify(RECORDINGS), { status: 200 }) });
    return {
      provider: 'sandbox',
      hosts: real.hosts,
      list: (c, since, signal) => real.list(c, since, signal),
      prepareDownload: async (c, id, format, signal) => {
        const download = await real.prepareDownload(c, id, format, signal);
        expect(new URL(download.url).hostname).toBe('graph.microsoft.com');
        return { ...download, url: `http://graph.microsoft.com:${port}${path}` };
      },
    };
  }
  const run = async (path: string) => {
    seen.length = 0;
    const executed: string[] = [];
    const client: MediaExtractClient = {
      extractAudio: async (source) => {
        for await (const piece of source) void piece;
        return { audio: OPUS, durationSeconds: 2 };
      },
    };
    const deps = {
      runtime: {
        query: async (name: string) => (name === 'kernel.meeting_platform.credential' ? { keyId: 'k', envelope: Buffer.from('x').toString('base64'), provider: 'sandbox', externalAccount: 'a@b' } : 'importing'),
        execute: async (name: string, input: Record<string, unknown>) => {
          executed.push(`${name}:${String(input.code ?? '')}`);
          return { applied: 1 };
        },
      },
      broker: { id: 'test', open: () => JSON.stringify({ accessToken: 'token-123' }) },
      store,
      adapters: { sandbox: teamsAt(path) },
      extractor: createMediaAudioExtractor(client),
      streamOptions: {
        resolve: async (host: string) => {
          const address = resolveMap[host];
          if (!address) throw new Error('ENOTFOUND');
          return [{ address, family: 4 }];
        },
        allowed: (address: string) => address === '127.0.0.1',
        anyPort: true,
        httpsOnly: false,
        timeoutMs: 5000,
      },
    } as unknown as MeetingsImportDeps;
    return { result: await runMeetingsImport(deps, job(), attempt), executed };
  };

  it('fetches the file from Graph with the member\'s token on that first request', async () => {
    const { result, executed } = await run('/file');
    expect(result).toBe('staged');
    expect(executed).toEqual(['kernel.meeting_platform.import_staged:']);
    expect(seen).toEqual([{ host: 'graph.microsoft.com', path: '/file', authorization: 'Bearer token-123' }]);
  });

  it('follows a redirect to a SharePoint host without the token (the headers stay with Graph)', async () => {
    const { result } = await run('/to-sharepoint');
    expect(result).toBe('staged');
    expect(seen).toEqual([
      { host: 'graph.microsoft.com', path: '/to-sharepoint', authorization: 'Bearer token-123' },
      { host: 'contoso-my.sharepoint.com', path: '/file', authorization: undefined },
    ]);
  });

  it('refuses a redirect to any other host (foreign, lookalike, a suffix that is not a subdomain, another Microsoft host, the sign-in host), records platform_refused, and never reaches the target', async () => {
    for (const path of ['/to-evil', '/to-lookalike', '/to-suffix-lookalike', '/to-other-microsoft', '/to-login']) {
      const { result, executed } = await run(path);
      expect(result, path).toBe('failed');
      expect(executed, path).toEqual(['kernel.meeting_platform.import_failed:platform_refused']);
      // Only the first request was made; the redirect target was never connected to, and no bytes were staged.
      expect(seen.map((r) => r.host), path).toEqual(['graph.microsoft.com']);
      await expect(store.get(KEY), path).rejects.toThrow(/blob not found/);
    }
  });
});
