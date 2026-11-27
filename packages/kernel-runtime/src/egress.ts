// The egress guard for URLs a tenant supplies (plan §7.7, first used by Social link previews, #641). A request goes
// only to a public address over HTTP or HTTPS on the default ports: the host is resolved first, every address it
// resolves to must be public (private, loopback, link-local, metadata, carrier-grade NAT, multicast, documentation and
// IPv6 translation ranges are refused), and the connection is pinned to the checked address, so a second DNS answer
// cannot point it elsewhere. Redirects are followed by hand, each checked the same way. One deadline covers the whole
// fetch, and the body is cut or refused at a byte limit. No cookies, credentials or compression.
import { lookup } from 'node:dns/promises';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Two lists: BlockList also matches an IPv4 address against an IPv6 rule through its mapped form, so one list with the
// IPv4-mapped range would refuse every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // Unspecified, loopback and the IPv4-compatible range.
  ['::', 96],
  // IPv4-mapped: an IPv4 address in IPv6 form is refused rather than checked twice.
  ['::ffff:0:0', 96],
  // NAT64 and local-use translation.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  // IETF protocol assignments (Teredo among them), documentation, 6to4.
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  // Unique local, link-local, site-local, multicast.
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');
}

// A literal address a request may go to.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return !BLOCKED_V6.check(address, 'ipv6');
  return false;
}

export const EGRESS_ERROR_CODES = ['invalid_url', 'blocked', 'dns', 'timeout', 'too_large', 'redirects', 'encoding', 'network'] as const;
export type EgressErrorCode = (typeof EGRESS_ERROR_CODES)[number];

export class EgressError extends Error {
  readonly code: EgressErrorCode;
  constructor(code: EgressErrorCode, message: string) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

export interface EgressOptions {
  // For the whole fetch, redirects included.
  timeoutMs: number;
  maxBytes: number;
  // 'truncate': keep the first maxBytes and stop reading (enough for a page's head); 'fail': refuse the response.
  overLimit: 'truncate' | 'fail';
  maxRedirects?: number;
  accept?: string;
  userAgent?: string;
  // Tests only: the resolver, the address check, and any port (a local test server).
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  allowed?: (address: string) => boolean;
  anyPort?: boolean;
  // A host allowlist, asked for the host of the first request and of every redirect: a host it refuses is 'blocked' before anything is
  // resolved or sent. For a fetch that may go only to one platform's own media hosts (a customer's image, #2357).
  hostAllowed?: (host: string) => boolean;
  // Only https, on the first request and on every redirect: an allowed host that redirects to plain http is refused as 'invalid_url'.
  httpsOnly?: boolean;
}

export interface EgressResponse {
  // The URL that answered, after redirects.
  url: string;
  status: number;
  contentType: string | null;
  // Lowercase scalar response headers forwarded when present (for rate-limit / retry metadata).
  headers?: Readonly<Record<string, string>>;
  body: Buffer;
  truncated: boolean;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

// An absolute http(s) URL with no credentials, on the scheme's default port.
export function egressTarget(raw: string, anyPort = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('invalid_url', 'not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressError('invalid_url', 'only http and https');
  if (url.username || url.password) throw new EgressError('invalid_url', 'credentials in the URL');
  if (url.port && url.port !== DEFAULT_PORTS[url.protocol] && !anyPort) throw new EgressError('invalid_url', 'only the default port');
  if (!url.hostname) throw new EgressError('invalid_url', 'no host');
  return url;
}

function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new EgressError('timeout', 'took too long');
  return left;
}

async function addressFor(url: URL, options: EgressOptions, deadline: number): Promise<{ address: string; family: number }> {
  const allowed = options.allowed ?? isPublicAddress;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (options.httpsOnly && url.protocol !== 'https:') throw new EgressError('invalid_url', 'only https');
  if (options.hostAllowed && !options.hostAllowed(host)) throw new EgressError('blocked', 'not an allowed host');
  const family = isIP(host);
  if (family !== 0) {
    if (!allowed(host)) throw new EgressError('blocked', 'not a public address');
    return { address: host, family };
  }
  const resolve = options.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EgressError('timeout', 'took too long')), remaining(deadline));
  });
  let answers: { address: string; family: number }[];
  try {
    answers = await Promise.race([resolve(host), timeout]);
  } catch (error) {
    if (error instanceof EgressError) throw error;
    throw new EgressError('dns', 'the host does not resolve');
  } finally {
    clearTimeout(timer);
  }
  if (answers.length === 0) throw new EgressError('dns', 'the host does not resolve');
  // Every answer, not only the first: a host that also points inside is refused.
  if (answers.some((a) => !allowed(a.address))) throw new EgressError('blocked', 'not a public address');
  return answers[0] as { address: string; family: number };
}

type Hop = { redirect: string } | { response: EgressResponse };

// What one request sends: GET with no body by default; guardedRequest sends a method, headers and a body of its own.
interface Sent {
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

// The request every helper sends: the checked address pinned as the connection's only lookup answer, the TLS name the
// host's, the guard's own headers last so a caller cannot change them. Not ended: the caller sends the body.
function openRequest(url: URL, target: { address: string; family: number }, options: EgressOptions, sent: Sent, onResponse: (res: IncomingMessage) => void): ClientRequest {
  const client = url.protocol === 'https:' ? https : http;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return client.request(
    {
      protocol: url.protocol,
      hostname: host,
      port: url.port || DEFAULT_PORTS[url.protocol],
      path: `${url.pathname}${url.search}`,
      method: sent.method,
      agent: false,
      // The checked address, whatever the resolver would say now; the TLS name stays the host's.
      lookup: (_name, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
        else (cb as (e: null, a: string, f: number) => void)(null, target.address, target.family);
      },
      ...(isIP(host) === 0 ? { servername: host } : {}),
      headers: {
        accept: options.accept ?? '*/*',
        'user-agent': options.userAgent ?? 'Ludy/1.0 (+https://github.com/DOS/Ludy)',
        ...sent.headers,
        // Never compressed, and the body's own length: neither is the caller's to change.
        'accept-encoding': 'identity',
        ...(sent.body ? { 'content-length': String(sent.body.length) } : {}),
      },
    },
    onResponse,
  );
}

// The Location of a 3xx answer that has one: the only answers followed as redirects.
function redirectLocation(res: IncomingMessage): string | null {
  const status = res.statusCode ?? 0;
  const location = res.headers.location;
  return status >= 300 && status < 400 && location ? location : null;
}

function isCompressed(res: IncomingMessage): boolean {
  const encoding = res.headers['content-encoding'];
  return Boolean(encoding) && encoding !== 'identity';
}

function once(url: URL, target: { address: string; family: number }, options: EgressOptions, deadline: number, sent: Sent = { method: 'GET', headers: {}, body: null }): Promise<Hop> {
  // Before the request exists: a deadline already past throws here, with nothing to clean up.
  const ms = remaining(deadline);
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    // Every way out (an answer, a redirect, a refusal, the deadline) closes the socket: a server that keeps a
    // connection open after a redirect, or after the byte limit, holds nothing of ours.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn();
    };
    const req = openRequest(url, target, options, sent, (res) => {
      const status = res.statusCode ?? 0;
      const location = redirectLocation(res);
      if (location) {
        finish(() => resolve({ redirect: location }));
        return;
      }
      if (isCompressed(res)) {
        res.destroy();
        finish(() => reject(new EgressError('encoding', 'the response is compressed')));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (options.overLimit === 'fail' && Number.isFinite(declared) && declared > options.maxBytes) {
        res.destroy();
        finish(() => reject(new EgressError('too_large', 'the response is too large')));
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'] as const) {
        const raw = res.headers[name];
        if (typeof raw === 'string') headers[name] = raw;
        else if (Array.isArray(raw) && raw[0] !== undefined) headers[name] = raw[0];
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (truncated: boolean) =>
        finish(() =>
          resolve({ response: { url: url.toString(), status, contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null, headers, body: Buffer.concat(chunks), truncated } }),
        );
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = options.maxBytes - size;
        if (chunk.length > room) {
          if (options.overLimit === 'fail') {
            res.destroy();
            finish(() => reject(new EgressError('too_large', 'the response is too large')));
            return;
          }
          chunks.push(chunk.subarray(0, room));
          size += room;
          res.destroy();
          done(true);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => done(false));
      res.on('error', () => finish(() => reject(new EgressError('network', 'the connection failed'))));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new EgressError('timeout', 'took too long')));
    }, ms);
    req.on('error', () => finish(() => reject(new EgressError('network', 'the connection failed'))));
    req.end(sent.body ?? undefined);
  });
}

// GET a tenant-supplied URL through the guard.
export async function guardedFetch(raw: string, options: EgressOptions): Promise<EgressResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = egressTarget(raw, options.anyPort);
  for (let hop = 0; ; hop++) {
    const target = await addressFor(url, options, deadline);
    const result = await once(url, target, options, deadline);
    if ('response' in result) return result.response;
    if (hop >= maxRedirects) throw new EgressError('redirects', 'too many redirects');
    url = redirectTarget(result.redirect, url, options);
  }
}

// Where a redirect goes: resolved against the URL that sent it, and held to the same rules as a first request.
function redirectTarget(location: string, from: URL, options: EgressOptions): URL {
  let next: string;
  try {
    next = new URL(location, from).toString();
  } catch {
    throw new EgressError('invalid_url', 'a redirect to something that is not a URL');
  }
  return egressTarget(next, options.anyPort);
}

// A request with a method, headers and a body to a tenant-supplied URL (#748: a Mastodon instance), through the same
// guard: public addresses only, the connection pinned to the checked address, one deadline and a byte limit for the
// answer. A redirect is not followed: a POST with a token must not move to another host, so it comes back as the
// answer (status 3xx) for the caller to refuse. Header names are lower-cased; content-length and accept-encoding are
// the guard's.
export interface GuardedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Readonly<Record<string, string>>;
  body?: Buffer;
}

const HOP_HEADERS = new Set(['host', 'connection', 'upgrade', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'content-length', 'accept-encoding']);
// Statuses whose answer has no body (a Response refuses one).
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function guardedHeaders(raw: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => !HOP_HEADERS.has(k as string)));
}

export async function guardedRequest(raw: string, request: GuardedRequest, options: EgressOptions): Promise<EgressResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const url = egressTarget(raw, options.anyPort);
  const target = await addressFor(url, options, deadline);
  // Headers that would change where or how the request goes are the guard's, never the caller's.
  const headers = guardedHeaders(request.headers);
  const result = await once(url, target, options, deadline, { method: request.method, headers, body: request.body ?? null });
  if ('response' in result) return result.response;
  return { url: url.toString(), status: 302, contentType: null, body: Buffer.alloc(0), truncated: false };
}

// A streamed GET (#meetings import: a recording of hundreds of megabytes cannot be buffered). The same checks as
// guardedFetch on the first request and on every redirect: https only (unless the options say otherwise for a test
// server), the host allowlist, every DNS answer public, the connection pinned to the checked address, one deadline for
// everything including the body. The body is handed out as it arrives; maxBytes is enforced while it streams, and the
// socket is released when the body ends, fails, is stopped early (the iterator's return()) or destroy() is called.
// The caller's headers (a bearer token) go on the first request and, by default, on a redirect only to the very same
// origin (scheme, host and port); a redirect to anywhere else is sent without them ('none' drops them on every redirect).
// The first request goes only to one of `firstHosts`, exact host names (ASCII or punycode, lower-cased on comparison, no brackets, no trailing dot, no suffix, no wildcard): the guard
// refuses any other first host as 'blocked' before resolving it or opening a connection, so the caller's headers can never leave
// for a host the caller did not name, whatever `hostAllowed` accepts for the hops a redirect leads to (a CDN suffix, say). The
// option is required: a caller that has no list to give has no business sending headers.
export interface EgressStreamOptions extends Omit<EgressOptions, 'overLimit'> {
  firstHosts: readonly string[];
  redirectHeaders?: 'same-host' | 'none';
}

export interface EgressStream {
  // The URL that answered, after redirects.
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  // Chunks as they arrive. Over maxBytes, past the deadline or on a broken connection the iteration throws an EgressError
  // ('too_large', 'timeout', 'network'). Not read at all: destroy() it (the deadline closes it in the end).
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

// Whether a hop of guardedStream carries the caller's headers: the first request always; a redirect only to the very same origin (scheme, host and port), and only while the options keep headers on
// redirects. URL.host alone is not enough: a redirect from https to http on the same host name has the same host, and is another place (a token must not go in the clear).
export function streamHeadersGo(first: URL, url: URL, hop: number, redirectHeaders: 'same-host' | 'none'): boolean {
  return hop === 0 || (redirectHeaders === 'same-host' && url.origin === first.origin);
}

export async function guardedStream(raw: string, request: { headers?: Readonly<Record<string, string>> }, options: EgressStreamOptions): Promise<EgressStream> {
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 3;
  // https unless the caller says httpsOnly: false; the buffered limit modes do not apply, a stream always fails over the limit.
  const guard: EgressOptions = { ...options, httpsOnly: options.httpsOnly ?? true, overLimit: 'fail' };
  const callerHeaders = guardedHeaders(request.headers);
  const first = egressTarget(raw, options.anyPort);
  const firstHost = first.hostname.startsWith('[') ? first.hostname.slice(1, -1) : first.hostname;
  if (!options.firstHosts.some((host) => host.toLowerCase() === firstHost)) throw new EgressError('blocked', 'not an allowed first host');
  let url = first;
  for (let hop = 0; ; hop++) {
    const target = await addressFor(url, guard, deadline);
    const forward = streamHeadersGo(first, url, hop, options.redirectHeaders ?? 'same-host');
    const result = await openHop(url, target, guard, deadline, { method: 'GET', headers: forward ? callerHeaders : {}, body: null });
    if ('redirect' in result) {
      if (hop >= maxRedirects) throw new EgressError('redirects', 'too many redirects');
      url = redirectTarget(result.redirect, url, guard);
      continue;
    }
    return streamOf(url, result.req, result.res, guard, deadline);
  }
}

// One request, up to the answer's headers: a redirect comes back as its location (its connection closed), anything else
// as the live response for the caller to read.
function openHop(url: URL, target: { address: string; family: number }, options: EgressOptions, deadline: number, sent: Sent): Promise<{ redirect: string } | { req: ClientRequest; res: IncomingMessage }> {
  const ms = remaining(deadline);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: EgressError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(error);
    };
    const req = openRequest(url, target, options, sent, (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const location = redirectLocation(res);
      if (location) {
        res.destroy();
        req.destroy();
        resolve({ redirect: location });
        return;
      }
      resolve({ req, res });
    });
    const timer = setTimeout(() => fail(new EgressError('timeout', 'took too long')), ms);
    // After the answer this listener stays, so a late socket error cannot go unhandled; the body's iteration reports it.
    req.on('error', () => fail(new EgressError('network', 'the connection failed')));
    req.end();
  });
}

function streamOf(url: URL, req: ClientRequest, res: IncomingMessage, options: EgressOptions, deadline: number): EgressStream {
  const status = res.statusCode ?? 0;
  const ok = status >= 200 && status < 300;
  let released = false;
  let failure: EgressError | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    res.destroy();
    req.destroy();
  };
  // The deadline covers the body: past it the socket is closed and the iteration throws.
  const timer = setTimeout(() => {
    failure ??= new EgressError('timeout', 'took too long');
    release();
  }, Math.max(1, deadline - Date.now()));
  res.on('error', () => {
    failure ??= new EgressError('network', 'the connection failed');
  });
  // A compressed or declared-too-large answer is refused up front, as the buffered helpers do; an error page (non-2xx) is
  // handed over for the caller to read the status, with the limit still enforced as it streams.
  if (ok) {
    const declared = Number(res.headers['content-length']);
    if (isCompressed(res)) failure = new EgressError('encoding', 'the response is compressed');
    else if (Number.isFinite(declared) && declared > options.maxBytes) failure = new EgressError('too_large', 'the response is too large');
    if (failure) {
      const refused = failure;
      release();
      throw refused;
    }
  }
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let size = 0;
    try {
      if (released) throw failure ?? new EgressError('network', 'the stream was destroyed');
      for await (const chunk of res) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > options.maxBytes) {
          failure ??= new EgressError('too_large', 'the response is too large');
          throw failure;
        }
        yield bytes;
      }
      if (failure) throw failure;
    } catch (error) {
      throw failure ?? (error instanceof EgressError ? error : new EgressError('network', 'the stream was destroyed'));
    } finally {
      release();
    }
  }
  const inner = chunks();
  const iterator: AsyncIterator<Uint8Array> = {
    next: () => inner.next(),
    // The consumer stopped early: the socket goes first, then the generator (which has not started if never read).
    return: async (value?: unknown) => {
      release();
      return inner.return(value);
    },
  };
  return {
    url: url.toString(),
    status,
    headers: res.headers,
    body: { [Symbol.asyncIterator]: () => iterator },
    destroy: () => {
      failure ??= new EgressError('network', 'the stream was destroyed');
      release();
    },
  };
}

// A fetch through guardedRequest, for adapters that take a fetch: string, bytes and FormData bodies (encoded as the
// platform's fetch would), a Response back. https only unless the options allow a test server.
export function egressFetch(options: EgressOptions & { httpsOnly?: boolean }): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input);
    if ((options.httpsOnly ?? true) && url.protocol !== 'https:') throw new EgressError('invalid_url', 'only https');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE' && method !== 'PATCH') throw new EgressError('invalid_url', `method ${method} not allowed`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: Buffer | undefined;
    if (init?.body !== undefined && init.body !== null) {
      // The platform's own encoding (a FormData boundary, a string's UTF-8), read back as bytes.
      const encoded = new Request('https://encode.invalid/', { method: 'POST', body: init.body, headers: init.headers ?? {} });
      // The type before the bytes: Bun drops a generated multipart type once the body has been read (#768).
      const type = encoded.headers.get('content-type');
      body = Buffer.from(await encoded.arrayBuffer());
      if (type) headers['content-type'] = type;
    }
    const answer = await guardedRequest(input, { method, headers, ...(body ? { body } : {}) }, options);
    return new Response(NULL_BODY.has(answer.status) ? null : new Uint8Array(answer.body), { status: answer.status, headers: answer.contentType ? { 'content-type': answer.contentType } : {} });
  };
}
