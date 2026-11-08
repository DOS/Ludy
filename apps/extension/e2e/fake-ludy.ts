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
}

export interface FakeLudy {
  origin: string;
  requests: Array<{ method: string; path: string; authorization: string | undefined }>;
  created: Array<Record<string, unknown>>;
  uploads: Upload[];
  features: { meetings: boolean };
  failUploads: boolean;
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startFakeLudy(): Promise<FakeLudy> {
  const fake: FakeLudy = { origin: '', requests: [], created: [], uploads: [], features: { meetings: true }, failUploads: false, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      // The extension page has no host permission in the test, so the answer carries CORS like a split deployment's.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      fake.requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
      const body = await read(req);
      const json = (value: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (path === '/api/config') return json({ uploads: 'direct' });
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
        const text = body.toString('latin1');
        fake.uploads.push({
          meetingId: media[1]!,
          kind: /name="kind"\r\n\r\n(\w+)/.exec(text)?.[1] ?? null,
          fileType: /name="file"; filename="[^"]*"\r\nContent-Type: ([^\r\n]+)/.exec(text)?.[1] ?? null,
          bytes: body.length,
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
