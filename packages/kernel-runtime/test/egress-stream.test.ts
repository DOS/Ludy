// SPDX-License-Identifier: AGPL-3.0-only
// guardedStream: the streaming variant of the egress guard. Same checks as the buffered helpers, a body handed out as it
// arrives, and a socket that is always released. Names (a.test, b.test) resolve to a local server through the injected
// resolver; the test allows 127.0.0.1 itself, the guard would refuse it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressError, guardedStream, streamHeadersGo, type EgressStreamOptions } from '../src/egress.ts';

describe('guardedStream', () => {
  let server: Server;
  let other: Server;
  let port = 0;
  let otherPort = 0;
  const closed = { big: false, slow: false, early: false, declared: false };
  const hosts: Record<string, string> = { 'a.test': '127.0.0.1', 'b.test': '127.0.0.1', 'inside.test': '10.0.0.5' };
  const resolve = async (host: string) => {
    const address = hosts[host];
    if (!address) throw new Error('ENOTFOUND');
    return [{ address, family: 4 }];
  };
  // `bare` removes the test allowances (the guard's own address check, the http allowance) to see the defaults.
  const opts = (o: Partial<EgressStreamOptions> = {}, bare: ('allowed' | 'httpsOnly')[] = []): EgressStreamOptions => {
    const all: EgressStreamOptions = { timeoutMs: 3000, maxBytes: 1 << 20, allowed: (a) => a === '127.0.0.1', anyPort: true, httpsOnly: false, resolve, firstHosts: [...Object.keys(hosts), '127.0.0.1', '::1'], ...o };
    for (const key of bare) delete all[key];
    return all;
  };
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/body') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-multi': 'a' });
        let i = 0;
        const next = () => {
          if (i === 5) return res.end();
          res.write(`chunk-${i++}|`);
          setTimeout(next, 10);
        };
        next();
      } else if (path === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null, host: req.headers.host }));
      } else if (path === '/to-b') {
        res.writeHead(302, { location: url('b.test', '/echo') });
        res.end();
      } else if (path === '/to-same') {
        res.writeHead(302, { location: url('a.test', '/echo') });
        res.end();
      } else if (path === '/to-other-port') {
        res.writeHead(302, { location: `http://a.test:${otherPort}/echo` });
        res.end();
      } else if (path === '/gzip') {
        // A compressed 2xx answer, small: refused for its encoding before a byte is read.
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' });
        res.end('not really gzip');
      } else if (path === '/declared') {
        // A 2xx answer that declares more than the cap: refused for its length before a byte is read.
        req.socket.once('close', () => (closed.declared = true));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100000' });
        res.write(Buffer.alloc(1024, 1));
      } else if (path === '/to-private') {
        res.writeHead(302, { location: 'http://10.0.0.1/admin' });
        res.end();
      } else if (path === '/to-inside-name') {
        res.writeHead(302, { location: url('inside.test', '/echo') });
        res.end();
      } else if (path === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (path === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not here');
      } else if (path === '/big' || path === '/slow' || path === '/early') {
        const key = path.slice(1) as 'big' | 'slow' | 'early';
        req.socket.once('close', () => (closed[key] = true));
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const pause = key === 'big' ? 1 : 40;
        const timer = setInterval(() => res.write(Buffer.alloc(key === 'big' ? 4096 : 16, 1)), pause);
        req.socket.once('close', () => clearInterval(timer));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    port = (server.address() as AddressInfo).port;
    // Another origin on the same host name: another port.
    other = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, host: req.headers.host }));
    });
    await new Promise<void>((resolveListen) => other.listen(0, '127.0.0.1', resolveListen));
    otherPort = (other.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => other.close(() => resolveClose()));
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (error) {
      return error instanceof EgressError ? error.code : String(error);
    }
  };
  const drain = async (body: AsyncIterable<Uint8Array>) => {
    const parts: Buffer[] = [];
    for await (const chunk of body) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
  };
  const eventually = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };

  it('delivers a multi-chunk body intact and in order, with the status and headers', async () => {
    const stream = await guardedStream(url('a.test', '/body'), {}, opts());
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('application/octet-stream');
    expect(stream.headers['x-multi']).toBe('a');
    const chunks: string[] = [];
    for await (const chunk of stream.body) chunks.push(Buffer.from(chunk).toString('utf8'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe('chunk-0|chunk-1|chunk-2|chunk-3|chunk-4|');
  });

  it('refuses plain http by default, and a host that is not allowlisted before resolving it', async () => {
    expect(await code(guardedStream(url('a.test', '/body'), {}, opts({}, ['httpsOnly'])))).toBe('invalid_url');
    let resolved = 0;
    const counting = async (h: string) => (resolved++, resolve(h));
    expect(await code(guardedStream(url('a.test', '/body'), {}, opts({ hostAllowed: () => false, resolve: counting })))).toBe('blocked');
    expect(resolved).toBe(0);
  });

  it('refuses a private or loopback answer, across all answers, and a literal address', async () => {
    expect(await code(guardedStream(url('inside.test', '/echo'), {}, opts()))).toBe('blocked');
    const mixed = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    expect(await code(guardedStream(url('a.test', '/echo'), {}, opts({ resolve: mixed })))).toBe('blocked');
    expect(await code(guardedStream(`http://127.0.0.1:${port}/echo`, {}, opts({}, ['allowed'])))).toBe('blocked');
    expect(await code(guardedStream('http://[::1]/', {}, opts({}, ['allowed'])))).toBe('blocked');
  });

  it('sends the caller headers on the first request and to the same host, never to another host', async () => {
    const headers = { Authorization: 'Bearer secret' };
    const direct = JSON.parse((await drain((await guardedStream(url('a.test', '/echo'), { headers }, opts())).body)).toString('utf8'));
    expect(direct).toMatchObject({ auth: 'Bearer secret' });
    const same = await guardedStream(url('a.test', '/to-same'), { headers }, opts());
    expect(same.url).toBe(url('a.test', '/echo'));
    expect(JSON.parse((await drain(same.body)).toString('utf8'))).toMatchObject({ auth: 'Bearer secret' });
    const other = await guardedStream(url('a.test', '/to-b'), { headers }, opts());
    expect(other.url).toBe(url('b.test', '/echo'));
    expect(JSON.parse((await drain(other.body)).toString('utf8'))).toEqual({ auth: null, host: `b.test:${port}` });
    // Opted out: not even to the same host.
    const none = await guardedStream(url('a.test', '/to-same'), { headers }, opts({ redirectHeaders: 'none' }));
    expect(JSON.parse((await drain(none.body)).toString('utf8'))).toMatchObject({ auth: null });
  });

  it('re-checks every redirect: a private address, a name resolving inside, the allowlist, the scheme, the hop count', async () => {
    expect(await code(guardedStream(url('a.test', '/to-private'), {}, opts()))).toBe('blocked');
    expect(await code(guardedStream(url('a.test', '/to-inside-name'), {}, opts()))).toBe('blocked');
    const asked: string[] = [];
    expect(await code(guardedStream(url('a.test', '/to-b'), {}, opts({ hostAllowed: (h) => (asked.push(h), h === 'a.test') })))).toBe('blocked');
    expect(asked).toEqual(['a.test', 'b.test']);
    expect(await code(guardedStream(url('a.test', '/loop'), {}, opts({ maxRedirects: 2 })))).toBe('redirects');
  });

  it('sends the first request only to one of firstHosts: any other host is refused before it is resolved or connected to, a suffix is not a host, and a redirect hop is not held to the list', async () => {
    let resolved = 0;
    const counting = async (h: string) => (resolved++, resolve(h));
    // Whatever the per-hop allowlist accepts (here: everything, a CDN-suffix-like rule), a first host outside the exact list is 'blocked' with no DNS and no connection.
    const acceptAll = { hostAllowed: () => true, resolve: counting };
    expect(await code(guardedStream(url('b.test', '/echo'), { headers: { authorization: 'Bearer secret' } }, opts({ ...acceptAll, firstHosts: ['a.test'] })))).toBe('blocked');
    expect(await code(guardedStream(url('b.test', '/echo'), {}, opts({ ...acceptAll, firstHosts: ['b.test.evil.test', 'test', '.test'] })))).toBe('blocked');
    expect(await code(guardedStream(url('a.test', '/echo'), {}, opts({ ...acceptAll, firstHosts: [] })))).toBe('blocked');
    expect(resolved).toBe(0);
    // An exact host passes, in any letter case; a literal address must be listed too.
    expect((await guardedStream(url('a.test', '/echo'), {}, opts({ firstHosts: ['A.Test'] }))).status).toBe(200);
    expect(await code(guardedStream(`http://127.0.0.1:${port}/echo`, {}, opts({ firstHosts: ['a.test'] })))).toBe('blocked');
    // The list is for the first request only: a redirect to a host the per-hop allowlist accepts goes on, and without the caller's headers.
    const hop = await guardedStream(url('a.test', '/to-b'), { headers: { authorization: 'Bearer secret' } }, opts({ firstHosts: ['a.test'] }));
    expect(hop.url).toBe(url('b.test', '/echo'));
    expect(JSON.parse((await drain(hop.body)).toString('utf8'))).toEqual({ auth: null, host: `b.test:${port}` });
  });

  it('decides by origin, not by host name: the same host over another scheme or port is another place for the caller headers', () => {
    const first = new URL('https://files.example.test/rec');
    const go = (to: string, hop = 1, mode: 'same-host' | 'none' = 'same-host') => streamHeadersGo(first, new URL(to), hop, mode);
    expect(go('https://files.example.test/rec', 0, 'none')).toBe(true);
    expect(go('https://files.example.test/other')).toBe(true);
    // The default port is the same origin, written or not.
    expect(go('https://files.example.test:443/other')).toBe(true);
    // URL.host is the same for each of these; the origin is not.
    expect(new URL('http://files.example.test/rec').host).toBe(first.host);
    expect(go('http://files.example.test/rec')).toBe(false);
    expect(go('https://files.example.test:8443/rec')).toBe(false);
    expect(go('https://cdn.example.test/rec')).toBe(false);
    expect(go('https://files.example.test/other', 1, 'none')).toBe(false);
  });

  it('does not send the caller headers to the same host name on another port after a redirect', async () => {
    const headers = { Authorization: 'Bearer secret' };
    const moved = await guardedStream(url('a.test', '/to-other-port'), { headers }, opts());
    expect(moved.url).toBe(`http://a.test:${otherPort}/echo`);
    expect(JSON.parse((await drain(moved.body)).toString('utf8'))).toEqual({ auth: null, host: `a.test:${otherPort}` });
  });

  it('refuses a compressed 2xx answer and a declared length over the cap when the answer starts, and closes the socket', async () => {
    const compressed = await guardedStream(url('a.test', '/gzip'), {}, opts()).then(() => null, (e: unknown) => e);
    expect(compressed).toBeInstanceOf(EgressError);
    expect((compressed as EgressError).code).toBe('encoding');
    closed.declared = false;
    const declared = await guardedStream(url('a.test', '/declared'), {}, opts({ maxBytes: 1000 })).then(() => null, (e: unknown) => e);
    expect(declared).toBeInstanceOf(EgressError);
    expect((declared as EgressError).code).toBe('too_large');
    expect(await eventually(() => closed.declared)).toBe(true);
    // Within the cap the same answer is handed over: the refusal is the declared length, not the route.
    const within = await guardedStream(url('a.test', '/declared'), {}, opts({ maxBytes: 1 << 20 }));
    expect(within.status).toBe(200);
    within.destroy();
  });

  it('hands over a non-2xx answer with its status and a body to drain', async () => {
    const stream = await guardedStream(url('a.test', '/missing'), {}, opts());
    expect(stream.status).toBe(404);
    expect((await drain(stream.body)).toString('utf8')).toBe('not here');
  });

  it('enforces maxBytes while streaming and destroys the socket', async () => {
    const stream = await guardedStream(url('a.test', '/big'), {}, opts({ maxBytes: 20_000 }));
    let seen = 0;
    let error: unknown;
    try {
      for await (const chunk of stream.body) seen += chunk.length;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EgressError);
    expect((error as EgressError).code).toBe('too_large');
    expect(seen).toBeLessThanOrEqual(20_000);
    expect(await eventually(() => closed.big)).toBe(true);
  });

  it('enforces the overall deadline during a slow stream', async () => {
    const started = Date.now();
    const stream = await guardedStream(url('a.test', '/slow'), {}, opts({ timeoutMs: 400 }));
    await expect(drain(stream.body)).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await eventually(() => closed.slow)).toBe(true);
  });

  it('releases the socket when the consumer stops iterating early, and on destroy()', async () => {
    const stream = await guardedStream(url('a.test', '/early'), {}, opts());
    for await (const chunk of stream.body) {
      expect(chunk.length).toBeGreaterThan(0);
      break;
    }
    expect(await eventually(() => closed.early)).toBe(true);
    // destroy() before any read: the iteration fails instead of hanging, and the socket is gone.
    closed.big = false;
    const unread = await guardedStream(url('a.test', '/big'), {}, opts());
    unread.destroy();
    expect(await eventually(() => closed.big)).toBe(true);
    await expect(drain(unread.body)).rejects.toBeInstanceOf(EgressError);
  });
});
