// Invariant suite (Decision 7): route enumeration (ADR-0028, "Acceptance tests"; External-tenant gate T1; issue #693).
// Every route the HTTP app registers goes through authenticate(), the token and session check, unless it is on the
// public list below with its reason. The test builds the app with every optional part on (every module, the status
// page, the bundled Supabase Auth proxy, inbound email, provider mail webhooks, the event stream and the SPA), reads
// Hono's route table and sends each route a request without a token: a route off the list must answer 401 and must
// have called authenticate(). So a new export or download route that skips the check fails here, whatever its path.
// Keep this directory self-contained: no imports from outside test/invariant/ besides the app's own source.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { AuthUser } from '../../src/auth.ts';
import { EXTENSION_ROUTES } from '../../src/auth-extension.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp, type HttpDeps } from '../../src/http.ts';

// Routes anyone may reach without a token, by Hono path pattern, each with its reason. A route listed here must
// exist (the list cannot go stale), and nothing else may skip authenticate().
const PUBLIC: Record<string, string> = {
  '/healthz': 'liveness probe: says only that the process serves',
  '/readyz': 'readiness probe: schema and Supabase Auth grants, no tenant data',
  '/version': 'the build id and the migrations missing from the ledger, for the deploy smoke test (#892); no tenant data',
  '/api/config': 'what the SPA needs before sign-in (auth URL, public links); no tenant data',
  '/status': 'the public status page (#678): one line per service, nothing about an org',
  '/auth/v1/*': 'the proxy to Supabase Auth, where sign-up and sign-in happen; it applies its own per-client limits',
  '/webhooks/mail/:provider': "the mail provider's delivery events, checked by the provider's signature",
  '/api/inbound/email': 'the inbound mail relay, checked by INBOUND_SECRET (constant-time)',
  '/api/bank-feed/:provider/webhook':
    "a bank feed provider's signed notice (ADR-0039, #2044): the adapter checks its signature and timestamp before anything else, it is rate limited per address, stores nothing of its body, and only asks the worker for a pull of a connection that lists an account it names",
  '/api/ads/meta/data-deletion':
    "Meta's data deletion callback for the Ads connection (ads plan section 9, #2219), POST and GET: the POST is checked by Meta's signed_request (HMAC-SHA256 with the app secret, constant time, not expired) before anything else, has a body cap, is rate limited per address, stores no body, and only queues the keyed hash of the user id for the worker, which erases the ad accounts that user granted; the GET is the status page Meta shows the person, answered by the confirmation code (128 random bits) and showing no tenant data",
  '/api/channels/zalo/webhook':
    "Zalo OA's signed notice of a customer's message (conversation core, #2304, plan docs/plan/conversations.md section 6.1): checks X-ZEvent-Signature over the raw body before anything else and refuses a body over its size cap before reading it, names no org in its path or answer, writes no tenant row (it only parks the signed body for the worker, which finds the org from the stored connection), and answers 401 to a missing or wrong signature without saying why",
  '/api/channels/facebook/webhook':
    "Meta's Page webhook for comments on connected Facebook Pages (conversation core CV2, #2307, plan docs/plan/conversations.md section 6.1): GET answers the hub.verify_token subscription challenge in constant time; POST checks X-Hub-Signature-256 (HMAC-SHA256 with the app secret, constant time) over the raw body before anything else and refuses a body over its size cap before reading it, names no org in its path or answer, writes no tenant row (it only parks the signed body for the worker, which finds the org from the stored connection), and answers 401 to a missing or wrong signature without saying why",
  '/api/extension/token':
    "the Ludy extension's one-time code exchange (#2582, ADR-0047 point 10): the code (256 random bits, 5 minutes, single use, stored only as its SHA-256) is the credential and PKCE S256 binds it to the verifier only the extension holds; a body cap of 1 KB, a per-client rate limit, the code and verifier checked for shape before the database, one 400 answer for every refusal, only hashes reach SQL, and nothing of any org in the answer but for a valid exchange",
  '/api/stream': 'the event stream, opened with a one-time ticket that POST /api/stream/tickets issues after the session check',
  '/api/review/view': "Social's client review page (#589): a signed, expiring review link is the credential",
  '/api/review/media': 'the same review link, for the media of the post under review',
  '/api/review/file': 'the same review link, for one file of the post under review',
  '/api/review/answer': "the reviewer's answer, through the same review link",
  '/api/quote/view': "a sent quote's page (#2694): a signed, expiring, revocable quote link is the credential; rate limited per client, it answers one quote document and nothing else",
  '/api/report/view': "Social's client report link (#643): a signed, expiring report link is the credential",
  '/cal/:file': 'the posting calendar feed (#862): an unguessable feed token in the file name is the credential',
  '/l/:code': 'short link redirects (#706): public by design, they only redirect to the stored target',
  '/b/:slug': 'link-in-bio pages (#707): public by design',
  '/api/booking/:org/:type':
    "a booking page's event type, its free slots and the booking itself (#1318): public by design, rate limited per IP and per event type; it shows free slots only, nothing of the host's calendar, and books through one command",
  '/b/:slug/go/:target': 'a link-in-bio link: public by design, redirects to the stored target',
  '/b/:slug/img/:file': 'a link-in-bio image: public by design',
  '/assets/*': "the SPA's static files",
  '/favicon.svg': "the SPA's icon",
  '/*': 'the SPA shell (index.html) and the security headers on every response; no data',
};

// Public routes an open PR adds. CI runs the base branch's copy of this suite on a PR, so a new public route is listed
// here first, in a PR of its own; the PR that adds the route moves it into PUBLIC. A route here may be public and may
// not exist yet; the stale-list check below skips it, and nothing else does.
const PENDING: Record<string, string> = {
  '/api/quote/logo': "the logo of a sent quote's letterhead (#2814): the quote link's token is the credential, as for /api/quote/view; rate limited per client, it answers that one quote's seller logo and nothing else",
};
const isPublic = (path: string) => Object.hasOwn(PUBLIC, path) || Object.hasOwn(PENDING, path);

const WEB_DIST = mkdtempSync(join(tmpdir(), 'crove-route-coverage-'));
writeFileSync(join(WEB_DIST, 'index.html'), '<!doctype html><title>Crove</title>');

function app(authenticate: HttpDeps['authenticate']) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: 'x'.repeat(32),
    AUTH_ISSUER: 'crove-auth',
    AUTH_UPSTREAM_URL: 'http://127.0.0.1:9',
    INBOUND_DOMAIN: 'inbound.example.com',
    INBOUND_SECRET: 'y'.repeat(32),
    STATUS_FILE: join(WEB_DIST, 'status.json').replace(/^[A-Za-z]:[\\/]/, '/').replace(/\\/g, '/'),
    WEB_DIST,
  });
  const runtime = { installed: () => true, modules: () => ['kernel', 'finance', 'social', 'crm'] } as unknown as Runtime;
  const unused = {} as never;
  return createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate,
    pool: {} as pg.Pool,
    aiEnabled: false,
    mailer: { name: 'test', enabled: true, sendRetrySafety: 'unsafe', send: unused, parseWebhook: () => [] } as unknown as NonNullable<HttpDeps['mailer']>,
    // An adapter that takes signed notices, so the bank feed route is registered and listed (ADR-0039, #2044).
    bankFeedWebhooks: { bank_sandbox: { id: 'bank_sandbox', hosts: [], verifyWebhook: () => [] } } as unknown as NonNullable<HttpDeps['bankFeedWebhooks']>,
    // The Meta app of Ads, so the data deletion callback is registered and listed (ads plan section 9, #2219).
    adsDeletion: { appSecret: 'z'.repeat(32) },
    // The Zalo app and its OA secret key, so the webhook of customers' messages is registered and listed (conversation core, #2304).
    zaloWebhook: { appId: '4318000000000000001', oaSecretKey: 'k'.repeat(24) },
    // The Meta app and its verify token, so the Page webhook is registered and listed (conversation core CV2, #2307).
    facebookWebhook: { appSecret: 's'.repeat(32), verifyToken: 'v'.repeat(24) },
    stream: { hub: { ready: false }, tickets: unused, slots: unused, recheckSeconds: 30 } as unknown as NonNullable<HttpDeps['stream']>,
  });
}

// What the probe needs of an app: its route table and a way to send it a request.
type App = Pick<Hono, 'routes' | 'request'>;

// One request per registered method and path: Hono lists each handler and middleware of a route, so duplicates fold.
function routesOf(target: App): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of target.routes) seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  return [...seen.values()];
}

// A concrete URL for a path pattern: each parameter and wildcard becomes a harmless value.
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'x').replace(/^x$/, '/x');

// The routes that answered a request without a token without calling authenticate() and without a 401.
async function unprotected(target: App, calls: { count: number }): Promise<string[]> {
  const open: string[] = [];
  for (const { method, path } of routesOf(target)) {
    if (isPublic(path)) continue;
    calls.count = 0;
    const verb = method === 'ALL' ? (path.startsWith('/api/rpc') ? 'POST' : 'GET') : method;
    const init: RequestInit = verb === 'GET' ? { method: verb } : { method: verb, headers: { 'content-type': 'application/json' }, body: '{}' };
    const response = await target.request(concrete(path), init);
    if (response.status !== 401 || calls.count === 0) open.push(`${method} ${path} (${response.status}, authenticate called ${calls.count} times)`);
  }
  return open;
}

function refusingAuthenticate(calls: { count: number }): HttpDeps['authenticate'] {
  return async () => {
    calls.count += 1;
    throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  };
}

describe('route enumeration (ADR-0028, gate T1)', () => {
  it('sends every non-public route through authenticate(), and refuses it without a token', async () => {
    const calls = { count: 0 };
    const target = app(refusingAuthenticate(calls));
    // The app is built with every optional part on, so the table holds the export and download routes.
    const paths = routesOf(target).map((r) => r.path);
    for (const path of ['/api/rpc/*', '/api/files/:id', '/api/export/journal.xlsx', '/api/export/vat-01gtgt.xml', '/api/org-export/:part']) {
      expect(paths, path).toContain(path);
    }
    // Most of the table is behind the check: a probe that reached none of it would prove nothing.
    expect(routesOf(target).filter((r) => !isPublic(r.path)).length).toBeGreaterThan(15);
    expect(await unprotected(target, calls)).toEqual([]);
  });

  it('lists only routes that exist, so the public list cannot grow stale', () => {
    const paths = new Set(routesOf(app(refusingAuthenticate({ count: 0 }))).map((r) => r.path));
    expect(Object.keys(PUBLIC).filter((path) => !paths.has(path))).toEqual([]);
    // A pending route leaves PENDING when it moves into PUBLIC.
    expect(Object.keys(PENDING).filter((path) => Object.hasOwn(PUBLIC, path))).toEqual([]);
  });

  it('catches a download route registered ahead of the check', async () => {
    // The mistake this test exists for: a route registered before app.use('/api/*', ...) runs without it, whatever its
    // path, as the public review routes do on purpose. Built the way createHttpApp builds its routes.
    const calls = { count: 0 };
    const authenticate = refusingAuthenticate(calls);
    const leaky = new Hono();
    leaky.get('/healthz', (c) => c.json({ ok: true }));
    leaky.get('/api/export/leak.xlsx', (c) => c.body('the books'));
    leaky.use('/api/*', async (c, next) => {
      try {
        await authenticate(c.req.header('authorization'));
      } catch {
        return c.json({ code: 'UNAUTHENTICATED' }, 401);
      }
      await next();
    });
    leaky.get('/api/export/journal.xlsx', (c) => c.body('checked'));
    expect(await unprotected(leaky, calls)).toEqual(['GET /api/export/leak.xlsx (200, authenticate called 0 times)']);
  });
});

// The Ludy extension token (#2582, ADR-0047 point 10). authenticate() hands the app a user made from a token; the edge then
// refuses every route that is not on the token's list (auth-extension.ts: EXTENSION_ROUTES), before any handler. This
// enumerates the whole route table with such a user, so a route added tomorrow is refused to a token unless someone puts
// it on the list, in a PR the security review reads. Nothing that reads a meeting's content is on it.
const UUID = randomUUID();

function extensionAuthenticate(scopes: readonly string[]): HttpDeps['authenticate'] {
  return async (): Promise<AuthUser> => ({
    userId: UUID,
    email: '',
    name: null,
    aal: 'aal1',
    sessionId: '',
    mfaAt: null,
    extension: { tokenId: randomUUID(), orgId: UUID, userId: UUID, scopes: scopes as never, expiresAt: '2027-01-01T00:00:00.000Z' },
  });
}

// A concrete URL for a path pattern, with a UUID where the pattern takes an id.
const concreteWithIds = (path: string) => path.replace(/:[A-Za-z]+/g, UUID).replace(/\*$/, 'x').replace(/^x$/, '/x');

async function edgeRefused(target: App, method: string, path: string): Promise<boolean> {
  const verb = method === 'ALL' ? 'POST' : method;
  const init: RequestInit =
    verb === 'GET' ? { method: verb, headers: { authorization: 'Bearer crx_test' } } : { method: verb, headers: { authorization: 'Bearer crx_test', 'content-type': 'application/json' }, body: '{}' };
  const response = await target.request(path, init);
  if (response.status !== 403) return false;
  const body = (await response.json().catch(() => null)) as { code?: string } | null;
  return body?.code === 'FORBIDDEN';
}

describe('route enumeration with an extension token (#2582)', () => {
  const listed = (method: string, path: string) =>
    EXTENSION_ROUTES.some((r) => r.method === method && r.path.replace(':id', UUID) === path);

  it('refuses a token on every route of the table but the listed ones', async () => {
    const target = app(extensionAuthenticate(['meetings']));
    const open: string[] = [];
    for (const { method, path } of routesOf(target)) {
      if (isPublic(path)) continue;
      if (!(await edgeRefused(target, method, concreteWithIds(path)))) open.push(`${method} ${path}`);
    }
    // The routes a token passes the edge on are exactly the table's own: a wildcard (the RPC) stays closed for every
    // procedure but the listed ones, checked next, and the stream, files, exports and meeting media reads stay closed.
    const expected = routesOf(target)
      .filter(({ path }) => !isPublic(path))
      .filter(({ method, path }) => EXTENSION_ROUTES.some((r) => r.path.replace(':id', UUID) === concreteWithIds(path) && (r.method === method || method === 'ALL')))
      .map(({ method, path }) => `${method} ${path}`);
    // Concretized wildcard paths ('/api/rpc/x') name no listed route, so a wildcard route is in `open` only if listed.
    expect(open.sort()).toEqual(expected.sort());
  });

  it('opens exactly the listed routes to a token that holds their scope, and refuses them to one that does not', async () => {
    const holder = app(extensionAuthenticate(['meetings']));
    const other = app(extensionAuthenticate(['somethingelse']));
    for (const route of EXTENSION_ROUTES) {
      const path = route.path.replace(':id', UUID);
      expect(await edgeRefused(holder, route.method, path), `${route.method} ${route.path} for the scope holder`).toBe(false);
      expect(await edgeRefused(other, route.method, path), `${route.method} ${route.path} for another scope`).toBe(route.scope !== null ? true : false);
    }
    // A listed path with another method, a trailing slash, a different case, an encoded segment or a dot segment is no route.
    for (const route of EXTENSION_ROUTES) {
      const path = route.path.replace(':id', UUID);
      const wrongMethod = route.method === 'GET' ? 'POST' : 'GET';
      expect(await edgeRefused(holder, wrongMethod, path), `${wrongMethod} ${path}`).toBe(true);
      expect(await edgeRefused(holder, route.method, `${path}/`), `${path}/`).toBe(true);
      // A percent-encoded letter: the router decodes it to the listed route, the edge reads the raw path and refuses.
      expect(await edgeRefused(holder, route.method, `${path.slice(0, -1)}%${path.charCodeAt(path.length - 1).toString(16)}`), `${path} encoded`).toBe(true);
      // Another case reaches no /api route at all (the SPA shell answers), so it can never run a handler.
      const upper = await holder.request(path.toUpperCase(), { method: route.method, headers: { authorization: 'Bearer crx_test' } });
      expect((await upper.text()).includes('"code"'), path.toUpperCase()).toBe(false);
    }
    expect(await edgeRefused(holder, 'POST', '/api/rpc/meetings%2Fcreate')).toBe(true);
    expect(await edgeRefused(holder, 'POST', '/api/rpc/meetings/create/../get')).toBe(true);
  });

  it('keeps every way to read a meeting, a file or the account closed to a token', async () => {
    const target = app(extensionAuthenticate(['meetings']));
    const closed: Array<[string, string]> = [
      ['POST', '/api/rpc/meetings/get'],
      ['POST', '/api/rpc/meetings/list'],
      ['POST', '/api/rpc/meetings/delete'],
      ['POST', '/api/rpc/meetings/readers/add'],
      ['POST', '/api/rpc/meetings/settings/get'],
      ['POST', '/api/rpc/extension/tokens/list'],
      ['POST', '/api/rpc/extension/tokens/revoke'],
      ['POST', '/api/rpc/me/get'],
      ['GET', `/api/meetings/${UUID}/audio`],
      ['GET', `/api/meetings/${UUID}/video`],
      ['GET', `/api/files/${UUID}`],
      ['POST', `/api/files/uploads/${UUID}/complete`],
      ['POST', '/api/files'],
      ['POST', '/api/stream/tickets'],
      ['POST', '/api/extension/authorize'],
      ['GET', '/api/org-export/x'],
      ['GET', '/api/export/journal.xlsx'],
    ];
    for (const [method, path] of closed) {
      expect(listed(method, path), `${method} ${path} must not be on the token's list`).toBe(false);
      expect(await edgeRefused(target, method, path), `${method} ${path}`).toBe(true);
    }
  });

  it('lists no route that does not exist, and none that reads content', async () => {
    const target = app(extensionAuthenticate(['meetings']));
    const paths = new Set(routesOf(target).map((r) => r.path));
    for (const route of EXTENSION_ROUTES) {
      // The RPC procedures live under the one wildcard route; every other entry is a route of its own.
      const own = route.path.startsWith('/api/rpc/') ? '/api/rpc/*' : route.path;
      expect(paths.has(own), `${route.method} ${route.path}`).toBe(true);
      expect(route.path, 'a route that streams media or files').not.toMatch(/\/(audio|video)$|^\/api\/files\/:id$|export/);
    }
  });
});
