// SPDX-License-Identifier: AGPL-3.0-only
// An Outlook calendar from the connect to the disconnect, in one go (Meetings B3, #3167; gap 9 of #3179): the member connects through the HTTP rpc, the REAL `MicrosoftCalendarAdapter` trades the code at a scripted
// Entra token endpoint and the tokens are sealed under the tenant's own key; the worker's sweep reads `/me/calendarView` through the same adapter (a scripted Graph with pages, free and busy variants, an all-day
// and a cancelled event) and the busy blocks it stores carry no title; a rotated refresh token is stored, a refused token or grant expires the connection; and a disconnect makes no call to Microsoft, which has no
// revoke endpoint. Every piece has its own test (the adapter's, the commands', the sweep's against fakes); this one crosses their seams against a real database with real row security, so the first live run with a real
// Microsoft tenant has one known path to compare with. The stub transport throws on any address it does not know, so an unexpected call fails the test even where the adapter turns it into a short code (an address the adapter's own host allowlist refuses never reaches the stub; the sync's outcome shows that case). Nothing calls
// a real Microsoft host. The tests chain their state (the connection, the token pairs, the blocks), so run the file whole, not one test. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries, type SealedCalendarCredential } from '@ludy/kernel';
import { calendarBinding } from '@ludy/kernel-contract';
import { MicrosoftCalendarAdapter, type Fetch } from '@ludy/channel';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { runCalendarSync, syncCalendars } from '../src/calendar-sync.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-calendar-microsoft-flow-0123456789';
const ISSUER = 'ludy-auth';
const suite = ADMIN ? describe : describe.skip;
const APP_URL = 'https://app.example.test';
const REDIRECT = `${APP_URL}/calendar/oauth/microsoft_calendar/callback`;
const OUTLOOK_APP = { clientId: '22222222-3333-4444-8555-666666666666', clientSecret: 'outlook-client-secret-not-real' };
const ENTRA_HOST = 'login.microsoftonline.com';
const GRAPH_HOST = 'graph.microsoft.com';
// The adapter has no tenant here, so it is the `common` authority.
const TOKEN_PATH = '/common/oauth2/v2.0/token';
const VIEW_PATH = '/v1.0/me/calendarView';
// The address the member signs in to Microsoft with (mixed case on purpose: the account is stored lower case) is not the address they log in to Ludy with.
const SIGN_IN = 'Linh.Nguyen@MP-Outlook-Flow.test';
const EMAIL = SIGN_IN.toLowerCase();
const OTHER_SIGN_IN = 'Nguoi.Khac@MP-Outlook-Flow.test';
const CODE = 'code-not-real-0001';
const A1 = 'outlook-access-not-real-0001';
const R1 = 'outlook-refresh-not-real-0001';
const A2 = 'outlook-access-not-real-0002';
const R2 = 'outlook-refresh-not-real-0002';
const A3 = 'outlook-access-not-real-0003';
const R3 = 'outlook-refresh-not-real-0003';
const A4 = 'outlook-access-not-real-0004';
const R4 = 'outlook-refresh-not-real-0004';
const REFUSED_ACCESS = 'refused-access-not-real';
const REFUSED_REFRESH = 'refused-refresh-not-real';
// What Graph returns although the busy read does not ask for it ($select names only the times and the availability): it must never reach a block, an audit row or a log line.
const SUBJECT = 'Họp hội đồng quản trị bí mật';
const ATTENDEE = 'khach.hang.bi.mat@attendee.test';
const MS_WORDS = 'secret-reason-not-real';
// What must never reach a log line: the member's tokens, the app's secret, the titles and invitees of the member's meetings and the words of Microsoft's refusals.
const NEVER_LOGGED = [A1, R1, A2, R2, A3, R3, A4, R4, REFUSED_ACCESS, REFUSED_REFRESH, OUTLOOK_APP.clientSecret, SUBJECT, ATTENDEE, MS_WORDS, 'Access token has expired'];
const DAY = 86_400_000;
const HOUR = 3_600_000;
// Midnight UTC three days from today: the scripted events are placed from here, inside the sweep's window (from the start of this hour, 366 days ahead).
const BASE = Math.floor(Date.now() / DAY) * DAY + 3 * DAY;
const at = (days: number, hour: number) => BASE + days * DAY + hour * HOUR;
const span = (from: number, to: number): [string, string] => [new Date(from).toISOString(), new Date(to).toISOString()];
// Graph writes a time in the zone asked for (UTC, by the Prefer header) with seven fractional digits and no offset.
const graphTime = (ms: number) => ({ dateTime: new Date(ms).toISOString().replace('Z', '0000'), timeZone: 'UTC' });

interface Account { subject: string; email: string; session: string; userId: string }
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@cal-ms-flow.test`, session: randomUUID(), userId: '' });

// The id_token carries only the claims the adapter reads (no signature check is needed for a token received directly): the app it is for (aud) and the sign-in name.
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (scope: string, access: string, refresh: string | null, signIn = SIGN_IN) => ({
  access_token: access,
  ...(refresh === null ? {} : { refresh_token: refresh }),
  token_type: 'Bearer',
  expires_in: 3599,
  scope,
  id_token: idToken({ aud: OUTLOOK_APP.clientId, preferred_username: signIn, name: 'Linh Nguyen' }),
});
// Entra writes the Graph permission with its address in a v1 answer: the adapter reads it as its short name.
const FULL_SCOPE = 'openid profile email https://graph.microsoft.com/Calendars.ReadBasic';
const renewal = (access: string, refresh: string) => () => json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3599, scope: 'openid profile email Calendars.ReadBasic' });

interface Scripted { startMs: number; graph: Record<string, unknown> }
// One event as Graph answers it, with the title and invitees it sends whatever the $select says.
const ev = (id: string, from: number, to: number, showAs: string, extra: Record<string, unknown> = {}): Scripted => ({
  startMs: from,
  graph: { '@odata.etag': `W/"${id}"`, id: `AAMkAD-${id}`, subject: SUBJECT, start: graphTime(from), end: graphTime(to), showAs, isCancelled: false, isAllDay: false, attendees: [{ emailAddress: { address: ATTENDEE } }], ...extra },
});
// The member's calendar. First: busy, tentative, free and "working elsewhere" on day 0, out of office on day 1, an all-day event shown as free (day 2), a cancelled one (day 3), an all-day event out of
// office (day 4), one more far down the list (day 5, the third page) and one 150 days out (the second piece of the year). Changed: the tentative one is freed, the "working elsewhere" one becomes busy and the
// day-5 event is gone.
const calendar = (changed: boolean): Scripted[] => [
  ev('busy', at(0, 9), at(0, 10), 'busy'),
  ev('tentative', at(0, 11), at(0, 12), changed ? 'free' : 'tentative'),
  ev('free', at(0, 14), at(0, 15), 'free'),
  ev('elsewhere', at(0, 15), at(0, 16), changed ? 'busy' : 'workingElsewhere'),
  ev('oof', at(1, 9), at(1, 17), 'oof'),
  ev('allday-free', at(2, 0), at(3, 0), 'free', { isAllDay: true }),
  ev('cancelled', at(3, 9), at(3, 10), 'busy', { isCancelled: true }),
  ev('allday-oof', at(4, 0), at(5, 0), 'oof', { isAllDay: true }),
  ...(changed ? [] : [ev('next-page', at(5, 10), at(5, 11), 'busy')]),
  ev('far', at(150, 13), at(150, 14), 'busy'),
];
const FIRST_BLOCKS = [span(at(0, 9), at(0, 10)), span(at(0, 11), at(0, 12)), span(at(1, 9), at(1, 17)), span(at(4, 0), at(5, 0)), span(at(5, 10), at(5, 11)), span(at(150, 13), at(150, 14))];
const CHANGED_BLOCKS = [span(at(0, 9), at(0, 10)), span(at(0, 15), at(0, 16)), span(at(1, 9), at(1, 17)), span(at(4, 0), at(5, 0)), span(at(150, 13), at(150, 14))];
const PAGE_SIZE = 4;

interface Call { method: string; host: string; path: string; search: URLSearchParams; headers: Record<string, string>; form: URLSearchParams | null }
const routeOf = (c: Call) => `${c.method} ${c.host}${c.path}`;
// Microsoft, as a script: the token endpoint (the code, and the renewal when a test scripts one) and Graph's calendar view over the scripted events, in pages of PAGE_SIZE with a next link of Graph's own, filtered
// to the window the adapter asked for. Every call is logged with the headers it carried; an address, a method or a grant the script does not know is logged apart AND thrown, so an unexpected call fails the test
// even where the adapter turns a throw into a short code (the `afterEach` below checks the log).
function microsoft() {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const hooks = {
    events: [] as Scripted[],
    // Per test, replaced by `reset` after it: the answer to the code, the renewal (none: a renewal is unexpected), answers that go first to the next calendar reads, and a next link to put on every first page.
    onCode: null as (() => Response) | null,
    onRefresh: null as (() => Response) | null,
    views: [] as Array<() => Response>,
    nextLink: null as string | null,
  };
  const view = (u: URL): Response => {
    const from = Date.parse(u.searchParams.get('startDateTime') ?? '');
    const to = Date.parse(u.searchParams.get('endDateTime') ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to)) return json(400, { error: { code: 'BadRequest', message: 'no window' } });
    const skip = Number(u.searchParams.get('$skiptoken') ?? 0);
    const inWindow = hooks.events.filter((e) => e.startMs >= from && e.startMs < to).sort((a, b) => a.startMs - b.startMs);
    const page = inWindow.slice(skip, skip + PAGE_SIZE).map((e) => e.graph);
    if (hooks.nextLink !== null) return json(200, { value: page, '@odata.nextLink': hooks.nextLink });
    if (skip + PAGE_SIZE >= inWindow.length) return json(200, { value: page });
    const next = new URL(u);
    next.searchParams.set('$skiptoken', String(skip + PAGE_SIZE));
    return json(200, { value: page, '@odata.nextLink': next.toString() });
  };
  const route = (u: URL, call: Call): Response | null => {
    if (u.host === ENTRA_HOST && call.method === 'POST' && u.pathname === TOKEN_PATH) {
      const kind = call.form?.get('grant_type');
      if (kind === 'authorization_code') return (hooks.onCode ?? (() => json(200, grant(FULL_SCOPE, A1, R1))))();
      if (kind === 'refresh_token' && hooks.onRefresh) return hooks.onRefresh();
      return null;
    }
    if (u.host === GRAPH_HOST && call.method === 'GET' && u.pathname === VIEW_PATH) {
      const queued = hooks.views.shift();
      return queued ? queued() : view(u);
    }
    return null;
  };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? 'GET',
      host: u.host,
      path: u.pathname,
      search: u.searchParams,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
    };
    calls.push(call);
    const answer = route(u, call);
    if (answer) return answer;
    unexpected.push(`${call.method} ${u.host}${u.pathname}`);
    throw new Error(`the Outlook flow test reached an address it does not know: ${call.method} ${u.host}${u.pathname}`);
  };
  const reset = () => {
    hooks.onCode = null;
    hooks.onRefresh = null;
    hooks.views.length = 0;
    hooks.nextLink = null;
  };
  const where = (pattern: RegExp) => calls.filter((c) => pattern.test(c.path));
  return { fetchImpl, calls, unexpected, hooks, reset, where };
}

suite('an Outlook calendar from the connect to the disconnect (Meetings B3, #3167)', () => {
  const dbName = `ludy_test_cal_ms_flow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let http: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: ReturnType<typeof createDb>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const stub = microsoft();
  // The REAL adapter over the scripted transport, as the API (the connect) and the worker (the sweep) both hold it.
  const adapter = new MicrosoftCalendarAdapter(OUTLOOK_APP, stub.fetchImpl);
  const owner = account('owner');
  const member = account('member');
  let org = { slug: '', orgId: '' };
  let connectionId = '';
  const system = { type: 'system' as const, component: 'calendar-microsoft-flow-test' };
  // What the code under test writes to the console (the spies call through): no token, title or invitee may be in it.
  let logs: Array<ReturnType<typeof vi.spyOn>> = [];

  const sqlAdmin = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<R>(text, params);
    } finally {
      await c.end();
    }
  };
  const tokenFor = (who: Account, mfa = false) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...(mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {}) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(who.subject).setIssuer(ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(SECRET));
  };
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; mfa?: boolean } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await http.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options.mfa)}`, 'content-type': 'application/json', ...(slug ? { 'x-ludy-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  const loggedText = () => logs.flatMap((spy) => spy.mock.calls.flat().map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))).join('\n');
  // Nothing of the member's tokens, the app's secret, the titles and invitees or Microsoft's own words is in the log, or in what the caller is shown.
  const expectNoSecrets = (shown?: unknown) => {
    for (const secret of NEVER_LOGGED) {
      expect(loggedText(), secret).not.toContain(secret);
      if (shown !== undefined) expect(JSON.stringify(shown), secret).not.toContain(secret);
    }
  };
  // The member's connect: the dialog's start and the page the browser returns to, as the web calls them.
  const start = (who: Account = member) => rpc('calendar/connectStart', who, { provider: 'microsoft_calendar' });
  const finish = (state: string, who: Account = member) => rpc('calendar/connectFinish', who, { provider: 'microsoft_calendar', state, code: CODE });
  async function connectMember() {
    const started = await start();
    expect(started.status).toBe(200);
    const done = await finish(started.body.state as string);
    expect(done.status).toBe(200);
    connectionId = String(done.body.connectionId);
    return done;
  }
  const connections = async () =>
    (
      await sqlAdmin<{ id: string; user_id: string; provider: string; external_account: string; display_name: string; scopes: string[]; status: string; status_reason: string | null; expires_at: Date | null; updated_at: Date; last_synced_at: Date | null; read_events: boolean; write_back: boolean }>(
        'SELECT id, user_id, provider, external_account, display_name, scopes, status, status_reason, expires_at, updated_at, last_synced_at, read_events, write_back FROM ludy_kernel.calendar_connection WHERE org_id = $1 ORDER BY connected_at',
        [org.orgId],
      )
    ).rows;
  const blocks = async () =>
    (await sqlAdmin<{ starts_at: Date; ends_at: Date; title: string | null; kind: string; time_zone: string; user_id: string }>('SELECT starts_at, ends_at, title, kind, time_zone, user_id FROM ludy_kernel.calendar_event WHERE org_id = $1 AND source_id = $2 ORDER BY starts_at', [org.orgId, connectionId])).rows;
  const spans = (rows: Array<{ starts_at: Date; ends_at: Date }>) => rows.map((r) => [r.starts_at.toISOString(), r.ends_at.toISOString()]);
  const credentialRows = async () => (await sqlAdmin('SELECT 1 FROM ludy_kernel.calendar_credential WHERE org_id = $1 AND id = $2', [org.orgId, connectionId])).rowCount;
  const listed = async () => (await rpc('calendar/connections', member, {})).body as Array<Record<string, unknown>>;
  // The sealed token as the worker opens it: under the binding of this org, provider and Microsoft account.
  async function sealedSecret(): Promise<{ accessToken?: unknown; refreshToken?: unknown }> {
    const sealed = await worker.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId }, { actor: system, orgId: org.orgId });
    expect(sealed).toMatchObject({ provider: 'microsoft', externalAccount: EMAIL });
    return JSON.parse(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(org.orgId, 'microsoft', EMAIL))) as { accessToken?: unknown; refreshToken?: unknown };
  }
  // The worker's 15 minute sweep over the whole database (one org here), and one connection's sync for the counts it gives back.
  const sweep = () => syncCalendars({ runtime: worker, broker: vault, workerDb, adapters: { microsoft_calendar: adapter }, exclusive: async <T>(run: () => Promise<T>) => ({ ran: true as const, value: await run() }) });
  const runOne = () => runCalendarSync({ runtime: worker, broker: vault, adapters: { microsoft_calendar: adapter } }, { orgId: org.orgId, connectionId });
  // A token that runs out within the next minute: the sync renews it before it reads.
  const expireSoon = () => sqlAdmin("UPDATE ludy_kernel.calendar_connection SET expires_at = now() + interval '1 minute' WHERE org_id = $1 AND id = $2", [org.orgId, connectionId]);
  const quiet = { disconnected: 0, synced: 0, expired: 0, retry: 0, skipped: 0, busy: false };

  beforeAll(async () => {
    logs = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('ludy_app', 'test-app-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(pool, workerPool);
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    const api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    http = createHttpApp({
      config,
      runtime: api,
      store: {} as BlobStore,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: { broker: vault, publicUrl: APP_URL, calendars: { microsoft_calendar: adapter } } as never,
    });
    for (const who of [owner, member]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Outlook Họp', idempotencyKey: randomUUID() }, { slug: null });
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, { mfa: true });
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null })).status).toBe(200);
    stub.hooks.events = calendar(false);
  }, 300_000);

  afterEach(() => {
    // The stub throws on an address it does not know, and an adapter may turn that into a short code: the log says it happened.
    // Emptied after the check, so one stray address fails its own test and not every later one.
    const unexpected = [...stub.unexpected];
    stub.unexpected.length = 0;
    stub.reset();
    expect(unexpected).toEqual([]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('connects Outlook through the rpc: the real adapter trades the code at Entra, the sign-in name becomes the account, the tokens are sealed for this org and account, and no answer, row or log carries one', async () => {
    expect((await rpc('calendar/providers', member, {})).body).toEqual(['microsoft_calendar']);
    const started = await start();
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(['authorizeUrl', 'expiresAt', 'state']);
    const url = new URL(started.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${ENTRA_HOST}/common/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(OUTLOOK_APP.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(started.body.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The one calendar permission, and nothing that writes or reads more.
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'profile', 'email', 'offline_access', 'Calendars.ReadBasic']);
    expect(String(started.body.authorizeUrl)).not.toContain(OUTLOOK_APP.clientSecret);
    const challenge = url.searchParams.get('code_challenge');

    stub.calls.length = 0;
    const done = await finish(started.body.state as string);
    expect(done.status).toBe(200);
    expect(Object.keys(done.body).sort()).toEqual(['connectionId', 'displayName', 'reconnected']);
    expect(done.body).toMatchObject({ displayName: 'Linh Nguyen', reconnected: false });
    connectionId = String(done.body.connectionId);
    // Entra was asked once, for the token, with the app's secret, the code, the return address and the verifier of the SAME attempt; no other call (no profile read, no revoke).
    expect(stub.calls.map(routeOf)).toEqual([`POST ${ENTRA_HOST}${TOKEN_PATH}`]);
    const form = stub.calls[0]?.form;
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe(CODE);
    expect(form?.get('client_id')).toBe(OUTLOOK_APP.clientId);
    expect(form?.get('client_secret')).toBe(OUTLOOK_APP.clientSecret);
    expect(form?.get('redirect_uri')).toBe(REDIRECT);
    expect(createHash('sha256').update(form?.get('code_verifier') ?? '').digest('base64url')).toBe(challenge);
    expect(stub.calls[0]?.search.toString()).toBe('');
    expectNoSecrets(done.body);

    // The connection is the member's, active, with the account in lower case, the permissions as short names and the expiry Microsoft gave; the meetings read is off until the member turns it on.
    const [row, ...rest] = await connections();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ id: connectionId, user_id: member.userId, provider: 'microsoft', external_account: EMAIL, display_name: 'Linh Nguyen', status: 'active', status_reason: null, last_synced_at: null, read_events: false, write_back: false });
    expect(row?.scopes).toEqual(['openid', 'profile', 'email', 'Calendars.ReadBasic']);
    expect(row?.expires_at?.getTime() ?? 0).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await listed()).toMatchObject([{ id: connectionId, provider: 'microsoft', displayName: 'Linh Nguyen', status: 'active', statusReason: null, lastSyncedAt: null, writeBack: false, canWriteBack: false, readEvents: false, canReadEvents: true }]);
    // The owner of the org sees none of it: the member's own calendar is listed to its member only (the list is by user).
    expect((await rpc('calendar/connections', owner, {})).body).toEqual([]);

    // The worker opens the tokens under this org, provider and account only; at rest the envelope holds neither token.
    expect(await sealedSecret()).toEqual({ accessToken: A1, refreshToken: R1 });
    const sealed = await worker.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId }, { actor: system, orgId: org.orgId });
    const open = (orgId: string, accountId: string) => vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(orgId, 'microsoft', accountId));
    expect(() => open(randomUUID(), EMAIL)).toThrow();
    expect(() => open(org.orgId, 'someone-else@mp-outlook-flow.test')).toThrow();
    const stored = await sqlAdmin<{ envelope: Buffer }>('SELECT envelope FROM ludy_kernel.calendar_credential WHERE org_id = $1 AND id = $2', [org.orgId, connectionId]);
    for (const token of [A1, R1]) expect(stored.rows[0]?.envelope.includes(token), token).toBe(false);
    // The attempt is used up and its verifier wiped; the audit trail holds no token, no verifier and no state.
    const attempts = await sqlAdmin<{ code_verifier: string | null }>("SELECT code_verifier FROM ludy_kernel.oauth_state WHERE org_id = $1 AND provider = 'microsoft_calendar'", [org.orgId]);
    expect(attempts.rows.map((r) => r.code_verifier)).toEqual([null]);
    const audit = (await sqlAdmin<{ text: string }>('SELECT detail::text AS text FROM ludy_kernel.audit_event WHERE org_id = $1', [org.orgId])).rows.map((r) => r.text).join('\n');
    for (const secret of [A1, R1, OUTLOOK_APP.clientSecret, form?.get('code_verifier') ?? 'x', started.body.state as string]) expect(audit, secret).not.toContain(secret);
    expectNoSecrets();
  });

  it('refuses a grant without Calendars.ReadBasic (a broader Calendars.Read does not stand in for it): nothing is stored, the attempt is used up and the member\'s own connection is untouched', async () => {
    const before = await connections();
    for (const scope of ['openid profile email', 'openid profile email Calendars.Read']) {
      const started = await start();
      stub.hooks.onCode = () => json(200, grant(scope, REFUSED_ACCESS, REFUSED_REFRESH, OTHER_SIGN_IN));
      stub.calls.length = 0;
      const refused = await finish(started.body.state as string);
      expect(refused).toMatchObject({ status: 422, body: { code: 'OAUTH_PERMISSION_MISSING' } });
      // Entra was asked once and nothing else was called: Microsoft has no revoke for the unused grant and the adapter makes none.
      expect(stub.calls.map(routeOf)).toEqual([`POST ${ENTRA_HOST}${TOKEN_PATH}`]);
      expectNoSecrets(refused.body);
      // The same state is used up (and is refused before the code is traded again).
      expect(await finish(started.body.state as string)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
      expect(stub.calls).toHaveLength(1);
      // No row for the refused account, and the member's connection is as it was, with its sealed tokens.
      expect(await connections()).toEqual(before);
      expect(await sealedSecret()).toEqual({ accessToken: A1, refreshToken: R1 });
      stub.reset();
    }
  });

  it('tells a tenant that needs its administrator so, in a fixed text with no Microsoft words, uses the attempt up and stores nothing', async () => {
    const before = await connections();
    const refusals: Array<Record<string, unknown>> = [
      // consent_required with the number in error_codes.
      { error: 'consent_required', error_description: `AADSTS65001: The user or administrator has not consented to use the application. ${MS_WORDS} for ${SIGN_IN}`, error_codes: [65001] },
      // The number only in the text, under another error name.
      { error: 'invalid_grant', error_description: `AADSTS90094: The grant requires admin permission. ${MS_WORDS} for ${SIGN_IN}` },
      { error: 'access_denied', error_description: `AADSTS90095: Admin approval is required. ${MS_WORDS}`, error_codes: [90095] },
    ];
    for (const body of refusals) {
      const started = await start();
      stub.hooks.onCode = () => json(400, body);
      stub.calls.length = 0;
      const refused = await finish(started.body.state as string);
      expect(refused).toMatchObject({ status: 422, body: { code: 'OAUTH_ADMIN_CONSENT_REQUIRED' } });
      expect(JSON.stringify(refused.body)).not.toContain('AADSTS');
      expect(JSON.stringify(refused.body)).not.toContain(SIGN_IN);
      expectNoSecrets(refused.body);
      // Nothing is retried: the token endpoint was asked once, the state is used up, and no connection changed.
      expect(stub.calls.map(routeOf)).toEqual([`POST ${ENTRA_HOST}${TOKEN_PATH}`]);
      expect(await finish(started.body.state as string)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
      expect(stub.calls).toHaveLength(1);
      expect(await connections()).toEqual(before);
      stub.reset();
    }
  });

  it('syncs through the worker\'s sweep: the real adapter reads the calendar view in pages of Graph\'s own links, and the busy blocks are the busy, tentative and out-of-office events with no title', async () => {
    stub.calls.length = 0;
    expect(await sweep()).toEqual({ ...quiet, synced: 1 });
    // Only Graph was called (the token is fresh, so no renewal), every call with the sealed token and the UTC preference.
    const views = stub.where(/\/me\/calendarView$/);
    expect(stub.calls).toHaveLength(views.length);
    expect(views).toHaveLength(6);
    for (const call of views) {
      expect(call.host).toBe(GRAPH_HOST);
      expect(call.method).toBe('GET');
      expect(call.headers.authorization).toBe(`Bearer ${A1}`);
      expect(call.headers.prefer).toBe('outlook.timezone="UTC", odata.maxpagesize=250');
      // The read asks for the times and the availability alone: no subject, body, location, organizer or invitee.
      expect(call.search.get('$select')).toBe('start,end,showAs,isCancelled');
      expect(call.search.get('$top')).toBe('250');
      expect(call.search.get('$orderby')).toBe('start/dateTime');
    }
    // Four pieces of the year (100, 100, 100 and 66 days from the start of the hour); the first piece takes three pages through Graph's own next links, the others one.
    const firsts = views.filter((c) => !c.search.has('$skiptoken'));
    expect(firsts).toHaveLength(4);
    const starts = firsts.map((c) => Date.parse(c.search.get('startDateTime') ?? ''));
    const ends = firsts.map((c) => Date.parse(c.search.get('endDateTime') ?? ''));
    expect((starts[0] as number) % HOUR).toBe(0);
    expect(starts.slice(1)).toEqual(ends.slice(0, -1));
    expect(ends.map((end, i) => end - (starts[i] as number))).toEqual([100, 100, 100, 66].map((d) => d * DAY));
    expect(views.filter((c) => c.search.has('$skiptoken')).map((c) => c.search.get('$skiptoken'))).toEqual(['4', '8']);

    // Free and "working elsewhere" events, the all-day event shown as free and the cancelled one are not busy; the all-day event marked out of office is, as given (midnight to midnight UTC).
    const stored = await blocks();
    expect(spans(stored)).toEqual(FIRST_BLOCKS);
    // Only start and end are kept: no title, in UTC, for the member, under the provider's name.
    expect(stored.every((b) => b.title === null && b.kind === 'microsoft' && b.time_zone === 'UTC' && b.user_id === member.userId)).toBe(true);
    const everything = (await sqlAdmin<{ text: string }>('SELECT to_jsonb(e)::text AS text FROM ludy_kernel.calendar_event e WHERE org_id = $1', [org.orgId])).rows.map((r) => r.text).join('\n');
    const audit = (await sqlAdmin<{ text: string }>('SELECT detail::text AS text FROM ludy_kernel.audit_event WHERE org_id = $1', [org.orgId])).rows.map((r) => r.text).join('\n');
    for (const secret of [SUBJECT, ATTENDEE, A1, R1]) {
      expect(everything, secret).not.toContain(secret);
      expect(audit, secret).not.toContain(secret);
    }
    // The audit row of the replace holds counts only.
    expect((await sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.calendar.busy_replace'", [org.orgId])).rows[0]?.detail).toMatchObject({ provider: 'microsoft', added: 6, removed: 0 });
    // The member sees the sync noted on the connection, with no failure.
    expect(await listed()).toMatchObject([{ id: connectionId, status: 'active', statusReason: null }]);
    expect(((await listed())[0] as { lastSyncedAt: string | null }).lastSyncedAt).not.toBeNull();
    expectNoSecrets();
  });

  it('replaces the blocks as a set when the calendar changes: what is freed or gone leaves, what became busy comes in, the rest stays', async () => {
    stub.hooks.events = calendar(true);
    stub.calls.length = 0;
    expect(await runOne()).toEqual({ outcome: 'synced', added: 1, removed: 2 });
    expect(stub.calls.every((c) => c.host === GRAPH_HOST && c.method === 'GET')).toBe(true);
    expect(spans(await blocks())).toEqual(CHANGED_BLOCKS);
    // The same answer again changes nothing.
    expect(await runOne()).toEqual({ outcome: 'synced', added: 0, removed: 0 });
    expect(spans(await blocks())).toEqual(CHANGED_BLOCKS);
  });

  it('never follows a next link that is not Graph\'s own: the read is not whole, so the sync notes a failure to try again and keeps the blocks it has', async () => {
    const before = spans(await blocks());
    expect(before).toEqual(CHANGED_BLOCKS);
    const foreign = [
      'https://evil.example.test/v1.0/me/calendarView?$skiptoken=x',
      // Not Graph's host, though it starts with it.
      'https://graph.microsoft.com.evil.example.test/v1.0/me/calendarView?$skiptoken=x',
      // Graph's host, not over https.
      'http://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=x',
    ];
    for (const link of foreign) {
      stub.hooks.nextLink = link;
      stub.calls.length = 0;
      // A missing block would let a booking land on a busy time, so a list that is not whole is a failure to try again, never a shorter list: the range is cut in halves down to a day and given up.
      expect(await runOne(), link).toEqual({ outcome: 'retry', reason: 'TOO_MANY_EVENTS' });
      expect(stub.calls.length).toBeGreaterThan(1);
      // Every request went to Graph's calendar view: none to the foreign address, and none to the token endpoint.
      expect(stub.calls.every((c) => c.host === GRAPH_HOST && c.method === 'GET' && c.path === VIEW_PATH && c.search.get('$skiptoken') === null), link).toBe(true);
      const last = stub.calls.at(-1) as Call;
      expect(Date.parse(last.search.get('endDateTime') ?? '') - Date.parse(last.search.get('startDateTime') ?? '')).toBeLessThanOrEqual(DAY);
      expect(await listed()).toMatchObject([{ status: 'active', statusReason: 'sync failed (TOO_MANY_EVENTS)' }]);
      expect(spans(await blocks())).toEqual(before);
      stub.reset();
    }
    // The next good sync clears the note.
    expect(await runOne()).toEqual({ outcome: 'synced', added: 0, removed: 0 });
    expect(await listed()).toMatchObject([{ status: 'active', statusReason: null }]);
    expectNoSecrets();
  });

  it('renews a token that is about to run out before it reads, and stores the rotated refresh token', async () => {
    await expireSoon();
    stub.hooks.onRefresh = renewal(A2, R2);
    stub.calls.length = 0;
    expect(await sweep()).toEqual({ ...quiet, synced: 1 });
    // The renewal comes first, with the stored refresh token and the app's secret; every read after it carries the new access token.
    const [refresh, ...reads] = stub.calls;
    expect(refresh && routeOf(refresh)).toBe(`POST ${ENTRA_HOST}${TOKEN_PATH}`);
    expect(refresh?.form?.get('grant_type')).toBe('refresh_token');
    expect(refresh?.form?.get('refresh_token')).toBe(R1);
    expect(refresh?.form?.get('client_id')).toBe(OUTLOOK_APP.clientId);
    expect(refresh?.form?.get('client_secret')).toBe(OUTLOOK_APP.clientSecret);
    expect(refresh?.form?.get('scope')).toContain('Calendars.ReadBasic');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.host === GRAPH_HOST && c.path === VIEW_PATH && c.headers.authorization === `Bearer ${A2}`)).toBe(true);
    // The new pair replaced the old one, sealed under the same binding, and the expiry moved an hour on.
    expect(await sealedSecret()).toEqual({ accessToken: A2, refreshToken: R2 });
    const [row] = await connections();
    expect(row).toMatchObject({ status: 'active', status_reason: null });
    expect(row?.expires_at?.getTime() ?? 0).toBeGreaterThan(Date.now() + 3_000_000);
    const audit = (await sqlAdmin<{ text: string }>('SELECT detail::text AS text FROM ludy_kernel.audit_event WHERE org_id = $1', [org.orgId])).rows.map((r) => r.text).join('\n');
    for (const secret of [A1, R1, A2, R2]) expect(audit, secret).not.toContain(secret);
    expectNoSecrets();
  });

  it('answers a refused access token by renewing once and reading again, and keeps the connection', async () => {
    stub.hooks.views.push(() => json(401, { error: { code: 'InvalidAuthenticationToken', message: `Access token has expired or is not yet valid for ${SIGN_IN}.` } }));
    stub.hooks.onRefresh = renewal(A3, R3);
    stub.calls.length = 0;
    expect(await runOne()).toEqual({ outcome: 'synced', added: 0, removed: 0 });
    const [refused, refresh, ...reads] = stub.calls;
    expect(refused && routeOf(refused)).toBe(`GET ${GRAPH_HOST}${VIEW_PATH}`);
    expect(refused?.headers.authorization).toBe(`Bearer ${A2}`);
    expect(refresh && routeOf(refresh)).toBe(`POST ${ENTRA_HOST}${TOKEN_PATH}`);
    expect(refresh?.form?.get('refresh_token')).toBe(R2);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.path === VIEW_PATH && c.headers.authorization === `Bearer ${A3}`)).toBe(true);
    expect(await sealedSecret()).toEqual({ accessToken: A3, refreshToken: R3 });
    expect(await listed()).toMatchObject([{ status: 'active', statusReason: null }]);
    expectNoSecrets();
  });

  it('expires the connection when the renewed token is refused too: the sealed token is dropped, the blocks stay and nothing is asked of Microsoft again', async () => {
    const before = spans(await blocks());
    const refuse = () => json(401, { error: { code: 'InvalidAuthenticationToken', message: `Access token has expired for ${SIGN_IN}.` } });
    stub.hooks.views.push(refuse, refuse);
    stub.hooks.onRefresh = renewal(A4, R4);
    stub.calls.length = 0;
    expect(await runOne()).toEqual({ outcome: 'expired', reason: 'invalid_token' });
    // Refused, renewed once, refused again: the grant is gone.
    expect(stub.calls.map(routeOf)).toEqual([`GET ${GRAPH_HOST}${VIEW_PATH}`, `POST ${ENTRA_HOST}${TOKEN_PATH}`, `GET ${GRAPH_HOST}${VIEW_PATH}`]);
    const [row] = await connections();
    expect(row).toMatchObject({ status: 'expired', status_reason: 'refused (invalid_token)' });
    expect(await credentialRows()).toBe(0);
    await expect(worker.query('kernel.calendar.credential', { connectionId }, { actor: system, orgId: org.orgId })).rejects.toMatchObject({ code: 'CALENDAR_NOT_ACTIVE' });
    expect(await listed()).toMatchObject([{ status: 'expired', statusReason: 'refused (invalid_token)' }]);
    // Its blocks stay, so time that may still be busy is not offered; the sweep no longer takes it up.
    expect(spans(await blocks())).toEqual(before);
    stub.calls.length = 0;
    expect(await sweep()).toEqual(quiet);
    expect(stub.calls).toEqual([]);
    expectNoSecrets();
  });

  it('connects again to bring an expired connection back (the same row, new tokens), then expires it when Entra refuses the refresh token with invalid_grant, before any read', async () => {
    const before = spans(await blocks());
    const idBefore = connectionId;
    const again = await connectMember();
    expect(again.body).toMatchObject({ reconnected: true, connectionId: idBefore });
    expect((await connections())[0]).toMatchObject({ id: connectionId, status: 'active', status_reason: null });
    expect(await sealedSecret()).toEqual({ accessToken: A1, refreshToken: R1 });
    expect(spans(await blocks())).toEqual(before);

    await expireSoon();
    stub.hooks.onRefresh = () => json(400, { error: 'invalid_grant', error_description: `AADSTS700082: The refresh token has expired due to inactivity. ${MS_WORDS} for ${SIGN_IN}`, error_codes: [700082] });
    stub.calls.length = 0;
    expect(await sweep()).toEqual({ ...quiet, expired: 1 });
    // One call, the refresh: a refused grant stops the sync before any read.
    expect(stub.calls.map(routeOf)).toEqual([`POST ${ENTRA_HOST}${TOKEN_PATH}`]);
    expect(stub.calls[0]?.form?.get('refresh_token')).toBe(R1);
    expect((await connections())[0]).toMatchObject({ status: 'expired', status_reason: 'refused (invalid_grant)' });
    expect(await credentialRows()).toBe(0);
    expect(spans(await blocks())).toEqual(before);
    expect(await listed()).toMatchObject([{ status: 'expired', statusReason: 'refused (invalid_grant)' }]);
    expectNoSecrets();
  });

  it('keeps the connection and notes a failure to try again when the token endpoint answers 401 to the refresh (the app\'s own secret is wrong, not the member\'s grant)', async () => {
    await connectMember();
    await expireSoon();
    stub.hooks.onRefresh = () => json(401, { error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret provided. ${MS_WORDS}`, error_codes: [7000215] });
    stub.calls.length = 0;
    expect(await runOne()).toEqual({ outcome: 'retry', reason: 'invalid_client' });
    expect(stub.calls.map(routeOf)).toEqual([`POST ${ENTRA_HOST}${TOKEN_PATH}`]);
    expect((await connections())[0]).toMatchObject({ status: 'active', status_reason: 'sync failed (invalid_client)' });
    // The member's tokens are as they were: nothing was learned about them.
    expect(await sealedSecret()).toEqual({ accessToken: A1, refreshToken: R1 });
    expectNoSecrets();
  });

  it('disconnects without any call to Microsoft (it has no revoke endpoint): the blocks go at once, then the worker finishes, the token and the row go, and the audit row says no revoke was made', async () => {
    await connectMember();
    expect(await sweep()).toEqual({ ...quiet, synced: 1 });
    expect(await blocks()).not.toEqual([]);
    stub.calls.length = 0;
    const gone = await rpc('calendar/disconnect', member, { connectionId });
    expect(gone).toMatchObject({ status: 200, body: { connectionId, disconnected: true } });
    // Step 1, the member's: the blocks and the entry in their list are gone at once; the connection waits for the worker with its sealed token.
    expect(await blocks()).toEqual([]);
    expect((await listed())).toEqual([]);
    expect((await connections())[0]).toMatchObject({ id: connectionId, status: 'disconnecting' });
    expect(await credentialRows()).toBe(1);
    expect(await sealedSecret()).toEqual({ accessToken: A1, refreshToken: R1 });
    expect(stub.calls).toEqual([]);
    // Step 2, the worker's: the adapter says there is nothing to revoke, and the connection is finished without a call to Entra or Graph.
    expect(await sweep()).toEqual({ ...quiet, disconnected: 1 });
    expect(stub.calls).toEqual([]);
    expect(await connections()).toEqual([]);
    expect(await credentialRows()).toBe(0);
    expect(await blocks()).toEqual([]);
    const audit = await sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.calendar.finish_disconnect'", [org.orgId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail).toMatchObject({ connection_id: connectionId, provider: 'microsoft', revoked: false, reason: 'no_provider_revoke' });
    expect(await sweep()).toEqual(quiet);
    expectNoSecrets();
  });
});
