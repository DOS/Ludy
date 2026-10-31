// SPDX-License-Identifier: AGPL-3.0-only
// Structured logs (#2175): the JSON line, the request id shared by the lines of one request and its answer header, the org
// id, the job's ids, and the promise that no header value, cookie, query or body reaches a line.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { describeError, installJsonLogs, orgIdOf, parseLogFormat, redact, runWithLogContext, setLogContext, withJobLogContext, type LogLevel } from '../src/log.ts';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-10-31T12:34:56.789Z');

interface Line {
  ts: string;
  level: LogLevel;
  role: string;
  msg: string;
  requestId?: string;
  orgId?: string;
  jobId?: string;
  queue?: string;
  [key: string]: unknown;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

// Installs JSON logs into an array; lines are parsed, so a line that is not one JSON object fails the test that prints it.
function capture(role = 'api') {
  const raw: string[] = [];
  restore = installJsonLogs({ role, write: (_level, line) => raw.push(line), now: () => NOW });
  return { raw, lines: () => raw.map((line) => JSON.parse(line) as Line) };
}

describe('JSON log lines', () => {
  it('turns console output into one JSON object per call, with the level, the role and the time, and keeps the message', () => {
    const log = capture('worker');
    console.log('[archive] verified %d batch(es)', 3);
    console.info('[x] info');
    console.warn('[x] warn');
    console.error('[x] error', new Error('boom'));
    console.debug('[x] debug');
    const lines = log.lines();
    expect(lines.map((l) => l.level)).toEqual(['info', 'info', 'warn', 'error', 'debug']);
    expect(lines[0]).toEqual({ ts: NOW.toISOString(), level: 'info', role: 'worker', msg: '[archive] verified 3 batch(es)' });
    // An Error keeps its text (and stack) in msg, on one line of JSON.
    expect(lines[3]?.msg).toMatch(/^\[x\] error Error: boom\n\s+at /);
    // Every line is one line.
    expect(log.raw.every((line) => !line.includes('\n'))).toBe(true);
  });

  it('puts the request, org, job and queue ids on the lines of the context, and only those', () => {
    const log = capture();
    console.log('before');
    runWithLogContext({ requestId: 'r-1' }, () => {
      console.log('in request');
      setLogContext({ orgId: 'o-1' });
      console.log('with org');
    });
    runWithLogContext({ queue: 'q', jobId: 'j-1', orgId: 'o-2' }, async () => {
      await Promise.resolve();
      console.log('in job, after an await');
    });
    const lines = log.lines();
    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[1]).toMatchObject({ msg: 'in request', requestId: 'r-1' });
    expect(lines[1]).not.toHaveProperty('orgId');
    expect(lines[2]).toMatchObject({ msg: 'with org', requestId: 'r-1', orgId: 'o-1' });
  });

  it('carries the ids across awaits and into concurrent work without mixing them up', async () => {
    const log = capture();
    const work = async (id: string) =>
      runWithLogContext({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 10 : 1));
        console.log(`done ${id}`);
      });
    await Promise.all([work('a'), work('b')]);
    expect(log.lines().map((l) => [l.msg, l.requestId])).toEqual([
      ['done b', 'b'],
      ['done a', 'a'],
    ]);
  });

  it('blanks a bearer token, a JWT and the password of a URL, whoever printed them', () => {
    // Built at run time, so no commit holds a token-shaped literal for a secret scanner to flag.
    const jwt = [{ alg: 'HS256' }, { sub: 'test-subject' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).concat(Buffer.from('signature-value').toString('base64url')).join('.');
    expect(jwt.split('.')).toHaveLength(3);
    expect(redact(`Authorization: Bearer abc.def-ghi_jkl=== and more`)).toBe('Authorization: Bearer [redacted] and more');
    expect(redact(`token ${jwt} end`)).toBe('token [jwt redacted] end');
    expect(redact('connect ECONNREFUSED postgres://crove_app:s3cret-pw@db:5432/postgres')).toBe('connect ECONNREFUSED postgres://crove_app:[redacted]@db:5432/postgres');
    // A URL with no password, or a host and port, is left alone.
    expect(redact('http://localhost:8080/api and postgres://crove_app@db:5432/x')).toBe('http://localhost:8080/api and postgres://crove_app@db:5432/x');
    const log = capture();
    console.error(`[db] failed for ${jwt} at postgres://u:pw@h/x`);
    expect(log.raw[0]).not.toContain('pw@');
    expect(log.raw[0]).not.toContain(jwt);
  });

  // A database error carries the row it refused in `detail`, `where`, `internalQuery` and `hint`: tenant values and personal
  // data. In JSON mode an Error argument is written field by field, and those four never reach a line.
  it('writes an Error argument without the row values a database error carries', () => {
    const log = capture();
    const failure = Object.assign(new pg.DatabaseError('duplicate key value violates unique constraint "users_email_key"', 0, 'error'), {
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      schema: 'public',
      column: 'email',
      detail: 'Key (email)=(private.person@example.com) already exists.',
      where: 'SQL statement "INSERT INTO users VALUES (\'private.person@example.com\')"',
      internalQuery: 'SELECT private-internal-query',
      hint: 'private-hint-text',
    });
    runWithLogContext({ requestId: 'r-1', orgId: 'o-1' }, () => {
      console.error('[http]', failure);
      console.error('failed for %s:', 'the org', failure);
    });
    const [first, second] = log.lines();
    expect(first).toMatchObject({ level: 'error', requestId: 'r-1', orgId: 'o-1' });
    expect(first?.msg).toContain('duplicate key value violates unique constraint "users_email_key"');
    expect(first?.msg).toContain('{ code: 23505, constraint: users_email_key, table: users, schema: public, column: email }');
    expect(second?.msg).toContain('failed for the org:');
    for (const line of log.raw) {
      for (const value of ['private.person@example.com', 'private-internal-query', 'private-hint-text', 'INSERT INTO users']) expect(line, value).not.toContain(value);
    }
  });

  it('writes an Error and its causes by name, message, stack and the fixed place fields, a few levels deep', () => {
    const inner = Object.assign(new Error('inner failure'), { detail: 'inner-secret-detail', table: 'orders' });
    const outer = new Error('outer failure', { cause: inner });
    const described = describeError(outer);
    expect(described).toContain('Error: outer failure');
    expect(described).toContain('[cause] Error: inner failure');
    expect(described).toContain('{ table: orders }');
    expect(described).not.toContain('inner-secret-detail');
    // A cause chain longer than three levels stops there.
    let chain = new Error('level 0');
    for (let level = 1; level <= 6; level++) chain = new Error(`level ${level}`, { cause: chain });
    expect(describeError(chain)).not.toContain('level 0');
    // An error with no stack still reads.
    const bare = new Error('no stack here');
    bare.stack = '';
    expect(describeError(bare)).toBe('Error: no stack here');
  });

  it('stays fast on a long message that echoes attacker-chosen text (no quadratic scan), and cuts an enormous one', () => {
    const slow = (text: string) => {
      const started = performance.now();
      const out = redact(text);
      return { out, ms: performance.now() - started };
    };
    // The shapes that make an unbounded `\b...+` scan restart at every boundary.
    const jwtStart = Buffer.from('{"a').toString('base64url').slice(0, 3);
    for (const text of [`${jwtStart}-`.repeat(50_000), 'a.'.repeat(100_000), 'Bearer '.repeat(30_000), 'http://'.repeat(30_000), `postgres://${'u'.repeat(200_000)}`]) {
      const { ms } = slow(text);
      expect(ms, text.slice(0, 12)).toBeLessThan(1000);
    }
    expect(slow('x'.repeat(100_000)).out.length).toBeLessThan(33_000);
    expect(slow('x'.repeat(100_000)).out).toMatch(/\.\.\.\[67232 more characters\]$/);
    // A message under the cap is untouched, and a bearer token in any case is blanked.
    expect(redact('plain')).toBe('plain');
    expect(redact('authorization: bearer abc123')).toBe('authorization: Bearer [redacted]');
  });

  it('blanks a URL password that spans the cut of an enormous message', () => {
    // 32,768 characters of filler, then a URL whose password straddles the cut, then more text.
    const head = 'x'.repeat(32_768 - 30);
    const out = redact(`${head}postgres://crove_app:straddling-password-value@db:5432/x and the rest`);
    expect(out).not.toContain('straddling-password');
    expect(out).not.toContain('straddling');
    expect(out).toMatch(/more characters\]$/);
    expect(out.length).toBeLessThan(32_768 + 64);
  });

  it('reads a job payload for its org id only: a uuid, and nothing else of it', () => {
    const org = randomUUID();
    expect(orgIdOf({ orgId: org.toUpperCase(), email: 'a@b.test' })).toBe(org);
    expect(orgIdOf({ orgId: 'not-a-uuid' })).toBeUndefined();
    expect(orgIdOf({ orgId: 7 })).toBeUndefined();
    expect(orgIdOf(null)).toBeUndefined();
    expect(orgIdOf('x')).toBeUndefined();
  });

  it('chooses the format from LOG_FORMAT: text by default, json on request, anything else refused', () => {
    expect(parseLogFormat(undefined)).toBe('text');
    expect(parseLogFormat('')).toBe('text');
    expect(parseLogFormat('json')).toBe('json');
    expect(() => parseLogFormat('yaml')).toThrow(/LOG_FORMAT/);
    const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth' };
    expect(loadConfig(base)).toMatchObject({ LOG_FORMAT: 'text', DATABASE_POOL_MAX: 10, WORKER_DATABASE_POOL_MAX: 10 });
    expect(loadConfig({ ...base, LOG_FORMAT: 'json', DATABASE_POOL_MAX: '25', WORKER_DATABASE_POOL_MAX: '4' })).toMatchObject({ LOG_FORMAT: 'json', DATABASE_POOL_MAX: 25, WORKER_DATABASE_POOL_MAX: 4 });
    expect(() => loadConfig({ ...base, LOG_FORMAT: 'yaml' })).toThrow();
    expect(() => loadConfig({ ...base, DATABASE_POOL_MAX: '0' })).toThrow();
    // The worker's pool needs a second connection: the calendar jobs hold one for a lock and query on another.
    expect(() => loadConfig({ ...base, WORKER_DATABASE_POOL_MAX: '1' })).toThrow();
    expect(loadConfig({ ...base, DATABASE_POOL_MAX: '1', WORKER_DATABASE_POOL_MAX: '2' })).toMatchObject({ DATABASE_POOL_MAX: 1, WORKER_DATABASE_POOL_MAX: 2 });
  });
});

describe('the lines of an HTTP request (#2175)', () => {
  const orgId = randomUUID();
  const user: AuthUser = { userId: randomUUID(), email: 'owner@example.com', name: 'Chủ Sở Hữu', aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
  let failure: Error | null = null;
  const app = createHttpApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' }),
    runtime: {
      installed: () => true,
      modules: () => ['kernel', 'finance'],
      forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
      query: async () => {
        if (failure) throw failure;
        return [];
      },
      execute: async () => ({}),
    } as unknown as Runtime,
    store: {} as BlobStore,
    authenticate: async () => user,
    pool: {} as pg.Pool,
    aiEnabled: false,
  });
  const TOKEN = 'tok-9f2c41d7-secret-bearer-value';
  const COOKIE = 'sb-session=cookie-secret-value-81c3';
  const QUERY = 'query-secret-value-5e7a';
  const BODY = 'body-secret-value-3b9d';
  const headers = { authorization: `Bearer ${TOKEN}`, cookie: COOKIE, [ORG_HEADER]: 'acme', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'private-agent/1.0' };

  it('shares one request id between its log lines and its x-request-id header, with the org once it is known', async () => {
    const log = capture();
    failure = new Error('the database said no');
    try {
      const response = await app.request(`/api/export/journal.xlsx?from=2026-01-01&token=${QUERY}`, { headers });
      expect(response.status).toBe(500);
      const id = response.headers.get('x-request-id');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const lines = log.lines();
      // The error line the route already printed, and the access line, both of this request.
      expect(lines.map((l) => l.msg.split(' ')[0])).toEqual(['[http]', 'request']);
      for (const line of lines) expect(line).toMatchObject({ requestId: id, orgId, role: 'api' });
      expect(lines[1]).toMatchObject({ level: 'error', msg: 'request', method: 'GET', route: '/api/export/journal.xlsx', status: 500 });
      expect(typeof lines[1]?.durationMs).toBe('number');
    } finally {
      failure = null;
    }
  });

  it('gives each request its own id, and ignores one the caller sent', async () => {
    const log = capture();
    const sent = 'caller-chosen-id';
    const first = await app.request('/api/export/journal.xlsx', { headers: { ...headers, 'x-request-id': sent } });
    const second = await app.request('/api/export/journal.xlsx', { headers });
    expect(first.status).toBe(200);
    const [a, b] = [first.headers.get('x-request-id'), second.headers.get('x-request-id')];
    expect(a).not.toBe(sent);
    expect(a).not.toBe(b);
    expect(log.lines().map((l) => l.requestId)).toEqual([a, b]);
    expect(log.raw.join('\n')).not.toContain(sent);
  });

  it('prints no header value, cookie, query string, body, address or user detail on any line', async () => {
    const log = capture();
    failure = new Error('the database said no');
    try {
      await app.request(`/api/export/journal.xlsx?token=${QUERY}`, { headers });
      await app.request(`/api/rpc/anything?token=${QUERY}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ secret: BODY }) });
      await app.request(`/api/files?token=${QUERY}`, { method: 'POST', headers, body: BODY });
      await app.request(`/api/unknown/${QUERY}`, { headers });
    } finally {
      failure = null;
    }
    const printed = log.raw.join('\n');
    expect(log.lines().length).toBeGreaterThanOrEqual(4);
    for (const secret of [TOKEN, COOKIE, 'cookie-secret-value-81c3', QUERY, BODY, '203.0.113.7', 'private-agent', user.email, user.userId, user.sessionId, 'Chủ Sở Hữu']) {
      expect(printed, secret).not.toContain(secret);
    }
    // A request is logged by its route pattern (`/api/*` for a path no route matches), never by the path a caller typed.
    const routes = log.lines().filter((l) => l.msg === 'request').map((l) => l.route);
    expect(routes).toHaveLength(4);
    expect(routes.every((route) => typeof route === 'string' && !route.includes(QUERY))).toBe(true);
  });

  it('answers with the id in text mode too, and prints nothing new there', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      const response = await app.request('/api/export/journal.xlsx', { headers });
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      console.log = original;
    }
    expect(lines).toEqual([]);
  });

  it('adds the id to error answers and to the health probes without logging the probes', async () => {
    const log = capture();
    const unauthenticated = await app.request('/healthz');
    expect(unauthenticated.status).toBe(200);
    expect(unauthenticated.headers.get('x-request-id')).toBeTruthy();
    expect(log.raw).toEqual([]);
  });
});

describe('the lines of a job (#2175)', () => {
  type Handler = (jobs: Array<{ id: string; data?: unknown }>) => Promise<void>;
  function fakeBoss() {
    const handlers = new Map<string, Handler>();
    const boss = {
      work: async (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest.at(-1) as Handler);
        return 'worker-id';
      },
    };
    withJobLogContext(boss);
    return { boss, run: (name: string, jobs: Array<{ id: string; data?: unknown }>) => handlers.get(name)!(jobs) };
  }

  it('carries the job id, the queue and the org its payload names on every line the handler prints', async () => {
    const log = capture('worker');
    const { boss, run } = fakeBoss();
    const org = randomUUID();
    const job = randomUUID();
    await boss.work('finance-file-extract', { batchSize: 1 }, async ([j]: Array<{ id: string; data?: unknown }>) => {
      console.log('[extract] reading', j?.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      console.warn('[extract] after an await');
    });
    await run('finance-file-extract', [{ id: job, data: { orgId: org, email: 'private@example.com', body: 'payload-secret' } }]);
    const lines = log.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatchObject({ role: 'worker', queue: 'finance-file-extract', jobId: job, orgId: org });
    // Nothing else of the payload is on a line.
    expect(log.raw.join('\n')).not.toContain('private@example.com');
    expect(log.raw.join('\n')).not.toContain('payload-secret');
  });

  it('has no org for a job whose payload names none (or not a uuid), and no job id for a batch; a handler without options still works', async () => {
    const log = capture('worker');
    const { boss, run } = fakeBoss();
    await boss.work('kernel-retention', async () => {
      console.log('[retention] running');
    });
    await boss.work('kernel-batch', { batchSize: 2 }, async () => {
      console.log('[batch] running');
    });
    await run('kernel-retention', [{ id: 'job-1', data: { orgId: 'not-a-uuid' } }]);
    await run('kernel-batch', [{ id: 'a' }, { id: 'b' }]);
    const [one, batch] = log.lines();
    expect(one).toMatchObject({ queue: 'kernel-retention', jobId: 'job-1' });
    expect(one).not.toHaveProperty('orgId');
    expect(batch).toMatchObject({ queue: 'kernel-batch' });
    expect(batch).not.toHaveProperty('jobId');
  });

  it('logs a failed handler with the job ids, then rethrows it so the queue records the failure', async () => {
    const log = capture('worker');
    const { boss, run } = fakeBoss();
    const org = randomUUID();
    const refused = Object.assign(new Error('the handler said no'), { detail: 'private-row-detail', table: 'orders' });
    await boss.work('finance-file-extract', async () => {
      await Promise.resolve();
      throw refused;
    });
    await boss.work('kernel-sync-throw', () => {
      throw new Error('thrown before any await');
    });
    await expect(run('finance-file-extract', [{ id: 'job-9', data: { orgId: org } }])).rejects.toBe(refused);
    // A handler that throws before its first await (the queue awaits it, so it is a rejection there too).
    await expect((async () => run('kernel-sync-throw', [{ id: 'job-10' }]))()).rejects.toThrow('thrown before any await');
    const [first, second] = log.lines();
    expect(first).toMatchObject({ level: 'error', queue: 'finance-file-extract', jobId: 'job-9', orgId: org });
    expect(first?.msg).toContain('[jobs] finance-file-extract handler failed Error: the handler said no');
    expect(first?.msg).toContain('{ table: orders }');
    expect(second).toMatchObject({ queue: 'kernel-sync-throw', jobId: 'job-10' });
    expect(log.raw.join('\n')).not.toContain('private-row-detail');
  });

  it('passes every argument the queue gives the handler, and its result', async () => {
    const seen: unknown[][] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const queue = {
      work: async (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest.at(-1) as (...args: unknown[]) => unknown);
        return 'id';
      },
    };
    withJobLogContext(queue);
    await queue.work('q', { batchSize: 1 }, (...args: unknown[]) => {
      seen.push(args);
      return 'handled';
    });
    const transaction = { db: 'transaction' };
    expect(await handlers.get('q')!([{ id: 'j' }], transaction)).toBe('handled');
    expect(seen).toEqual([[[{ id: 'j' }], transaction]]);
  });

  // The wrapper only helps when it is installed before the first registration, and the logger only when main starts it:
  // two lines of source, so pin them (a fake queue above cannot notice either going missing).
  it('is installed in the worker before any job is registered, and the logger is started by main for the long-running roles', () => {
    const worker = readFileSync(join(import.meta.dirname, '..', 'src', 'worker.ts'), 'utf8');
    const created = worker.indexOf('new PgBoss(');
    const wrapped = worker.indexOf('withJobLogContext(boss)');
    const firstWork = worker.indexOf('boss.work');
    expect(created).toBeGreaterThan(0);
    expect(wrapped).toBeGreaterThan(created);
    expect(firstWork).toBeGreaterThan(wrapped);
    expect(worker.match(/new PgBoss\(/g)).toHaveLength(1);
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/role === 'api' \|\| role === 'worker' \|\| role === 'all' \|\| role === 'prober'[\s\S]{0,200}installJsonLogs\(\{ role \}\)/);
  });

  // pg_stat_statements keeps a utility statement as written, and `migrate` sets the role passwords with ALTER ROLE ...
  // PASSWORD '<literal>': the database must load the extension with utility tracking off (#2175).
  it('loads pg_stat_statements in the compose database with utility statements untracked', () => {
    const compose = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docker-compose.yml'), 'utf8');
    // An active line: a commented-out copy would not do.
    expect(compose).toMatch(/^ {4}command: \['postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements\.track_utility=off'\]$/m);
  });

  it('does not leak a job context to the code after it', async () => {
    const log = capture('worker');
    const { boss, run } = fakeBoss();
    await boss.work('q', async () => {
      console.log('inside');
    });
    await run('q', [{ id: 'j' }]);
    console.log('outside');
    const [inside, outside] = log.lines();
    expect(inside).toMatchObject({ jobId: 'j' });
    expect(outside).not.toHaveProperty('jobId');
    expect(outside).not.toHaveProperty('queue');
  });
});
