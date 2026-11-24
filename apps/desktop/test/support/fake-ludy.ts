// SPDX-License-Identifier: AGPL-3.0-only
// A fake Ludy for the Windows smoke run (#4566): just enough of the real server's desktop sign-in to drive the installed app, on
// 127.0.0.1 only. It is NOT the real server: it holds no data, trusts nothing and exists for the CI job and its unit test.
//   GET  /api/config               public config (desktop capture off, so the sign-in asks for no scope)
//   GET  /-/extension/connect      the "sign-in page": checks the PKCE request and sends the browser back to the loopback address
//   POST /api/extension/token      trades the code and PKCE verifier for a `crx_` token, once
//   GET  /api/extension/me         who the token is; 401 for any token this server did not issue (or that was revoked)
//   GET  /feed/<file>              the update feed folder (RELEASES and nupkg files) from `feedDir()`
// Tokens and codes are random and never logged; `requestLog` holds method, path and status only.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';

export interface ConnectRequest {
  device: string;
  redirectUri: string;
  // The PKCE method the client asked for; the fake only accepts S256.
  method: string;
}

export interface FakeLudy {
  // http://127.0.0.1:<port>
  url: string;
  connects: ConnectRequest[];
  // How many token exchanges succeeded (a good code and the matching PKCE verifier).
  exchanges: number;
  // Token exchanges that were refused (wrong verifier, reused or unknown code).
  refusedExchanges: number;
  // One entry per /api/extension/me call: whether the bearer token was one this server issued and still accepts.
  meCalls: Array<{ accepted: boolean }>;
  feedRequests: Array<{ method: string; file: string; status: number }>;
  requestLog: string[];
  // Every token this server issued (the harness checks they never reach a log or a plain file; never print them).
  issuedTokens(): string[];
  // After this the issued tokens get a 401 from /api/extension/me.
  revokeAll(): void;
  close(): Promise<void>;
}

export interface FakeLudyOptions {
  // The folder served at /feed; read on every request so the harness can swap the feed between steps.
  feedDir?: () => string | null;
  port?: number;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export async function startFakeLudy(options: FakeLudyOptions = {}): Promise<FakeLudy> {
  const feedDir = options.feedDir ?? (() => null);
  // code -> the PKCE challenge it was issued against
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  const revoked = new Set<string>();
  let port = 0;
  const fake: FakeLudy = {
    url: '',
    connects: [],
    exchanges: 0,
    refusedExchanges: 0,
    meCalls: [],
    feedRequests: [],
    requestLog: [],
    issuedTokens: () => [...tokens],
    revokeAll: () => tokens.forEach((t) => revoked.add(t)),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 400, { code: 'BAD_HOST' });

    if (method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { meetingsDesktopCapture: false, uploads: 'direct', modules: [] });
    }

    if (method === 'GET' && url.pathname === '/-/extension/connect') {
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      let target: URL;
      try {
        target = new URL(redirect);
      } catch {
        return json(res, 400, { code: 'BAD_REDIRECT' });
      }
      const loopback = target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.pathname === '/ludy-desktop/callback' && target.search === '';
      if (url.searchParams.get('client') !== 'desktop' || !loopback || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state === '') {
        return json(res, 400, { code: 'BAD_CONNECT_REQUEST' });
      }
      const code = `crc_${randomBytes(32).toString('base64url')}`;
      codes.set(code, challenge);
      fake.connects.push({ device: url.searchParams.get('device') ?? '', redirectUri: redirect, method: url.searchParams.get('code_challenge_method') ?? '' });
      // The member would sign in and press "Cho phép" here; the fake approves at once and sends the browser back.
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      target.searchParams.set('org', 'smoke-org');
      res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (method === 'POST' && url.pathname === '/api/extension/token') {
      let body: { code?: unknown; codeVerifier?: unknown; client?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        return json(res, 400, { code: 'BAD_BODY' });
      }
      const challenge = typeof body.code === 'string' ? codes.get(body.code) : undefined;
      // One use only, whatever the verifier.
      if (typeof body.code === 'string') codes.delete(body.code);
      const verifierOk = typeof body.codeVerifier === 'string' && challenge !== undefined && createHash('sha256').update(body.codeVerifier, 'utf8').digest('base64url') === challenge;
      if (body.client !== 'desktop' || !verifierOk) {
        fake.refusedExchanges += 1;
        return json(res, 400, { code: 'EXTENSION_CODE_INVALID' });
      }
      const token = `crx_${randomBytes(32).toString('base64url')}`;
      tokens.add(token);
      fake.exchanges += 1;
      return json(res, 200, { token, tokenId: 'smoke-token-1', orgId: 'smoke-org-id', scopes: [], expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
    }

    if (method === 'GET' && url.pathname === '/api/extension/me') {
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const accepted = tokens.has(bearer) && !revoked.has(bearer);
      fake.meCalls.push({ accepted });
      if (!accepted) return json(res, 401, { code: 'UNAUTHORIZED' });
      return json(res, 200, { tokenId: 'smoke-token-1', orgId: 'smoke-org-id', client: 'desktop', scopes: [], expiresAt: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(), features: { meetings: false, agenda: false, notes: false } });
    }

    if ((method === 'GET' || method === 'HEAD') && url.pathname.startsWith('/feed/')) {
      const dir = feedDir();
      // One flat folder: the file name is the last path segment, never a path.
      const file = basename(decodeURIComponent(url.pathname.slice('/feed/'.length)));
      let status = 404;
      let size = 0;
      if (dir !== null && file !== '' && !file.startsWith('.')) {
        try {
          const stat = statSync(join(dir, file));
          if (stat.isFile()) {
            status = 200;
            size = stat.size;
          }
        } catch {
          // not there
        }
      }
      fake.feedRequests.push({ method, file, status });
      if (status !== 200 || dir === null) return json(res, 404, { code: 'NOT_FOUND' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
      if (method === 'HEAD') return void res.end();
      createReadStream(join(dir, file))
        .once('error', () => res.destroy())
        .pipe(res);
      return;
    }

    json(res, 404, { code: 'NOT_FOUND' });
  };

  const server = createServer((req, res) => {
    // Method, path (no query: the connect request carries the sign-in state) and status.
    const path = (req.url ?? '/').split('?')[0];
    res.once('finish', () => fake.requestLog.push(`${req.method} ${path} ${res.statusCode}`));
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { code: 'FAKE_ERROR' });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}
