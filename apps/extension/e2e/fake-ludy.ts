// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for the Ludy kernel's extension routes: just enough to sign in a token, answer /api/extension/me, create a
// meeting and take the media upload, recording every request so a test can say where the extension went.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Upload {
  meetingId: string;
  kind: string | null;
  fileType: string | null;
  bytes: number;
  // The code the extension said the recording stopped by itself with (A1, #3159), or null.
  stopReason: string | null;
}

export interface FakeLudy {
  origin: string;
  requests: Array<{ method: string; path: string; authorization: string | undefined; origin: string | undefined }>;
  // The bodies of the code exchanges (POST /api/extension/token) the extension made.
  exchanges: Array<Record<string, unknown>>;
  created: Array<Record<string, unknown>>;
  uploads: Upload[];
  features: { meetings: boolean };
  failUploads: boolean;
  // When set, /api/extension/me answers 302 to this address (a misconfigured proxy).
  redirectMeTo: string | null;
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startFakeLudy(): Promise<FakeLudy> {
  const fake: FakeLudy = { origin: '', requests: [], exchanges: [], created: [], uploads: [], features: { meetings: true }, failUploads: false, redirectMeTo: null, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      // The extension page has no host permission in the test, so the answer carries CORS like a split deployment's.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      fake.requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization, origin: req.headers.origin });
      const body = await read(req);
      const json = (value: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (path === '/api/config') return json({ uploads: 'direct' });
      if (path === '/api/extension/token') {
        fake.exchanges.push(JSON.parse(body.toString()) as Record<string, unknown>);
        return json({ token: 'crx_signed_in', tokenId: 't2', orgId: 'org1', scopes: ['meetings'], expiresAt: '2027-01-01T00:00:00.000Z' });
      }
      if (path === '/api/extension/me' && fake.redirectMeTo) return void res.writeHead(302, { location: `${fake.redirectMeTo}/api/extension/me` }).end();
      if (path === '/api/extension/me') {
        return json({ tokenId: 't1', orgId: 'org1', scopes: ['meetings'], expiresAt: '2027-01-01T00:00:00.000Z', features: { meetings: fake.features.meetings } });
      }
      if (path === '/api/rpc/meetings/create') {
        fake.created.push((JSON.parse(body.toString()) as { json: Record<string, unknown> }).json);
        return json({ json: { meetingId: '11111111-1111-4111-8111-111111111111' } });
      }
      const media = /^\/api\/meetings\/([0-9a-f-]{36})\/media$/.exec(path);
      if (media) {
        if (fake.failUploads) return json({ code: 'INTERNAL', message: 'down' }, 500);
        // The raw body of the file: the kind in the query and the type in Content-Type (#2780).
        const url = new URL(req.url ?? '/', 'http://x');
        fake.uploads.push({
          meetingId: media[1]!,
          kind: url.searchParams.get('kind'),
          fileType: req.headers['content-type'] ?? null,
          bytes: body.length,
          stopReason: url.searchParams.get('stopReason'),
        });
        return json({ fileId: 'f1' });
      }
      return json({ code: 'NOT_FOUND' }, 404);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}
