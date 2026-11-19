// SPDX-License-Identifier: AGPL-3.0-only
// Line wake events (#3858 slice e; ADR-0051 decision 13; owner decision 2026-11-18/19): a line registers an event type for the wake-up of an MCP grant, and only ids, enum words, dates and amounts can ride in it.
// - the builder (apps/kernel/src/mcp-wake-body.ts) builds a line body only for a registered type, with exactly the registered fields, each of its kind; an unregistered type, an unlisted field, a missing field, a name, a
//   note or a message in any field, a wrong kind and a fixed type's body in a line's clothes are all refused, and the registry in code is the database's catalog (both empty until a line ships a type);
// - the database holds the same: crove_kernel.mcp_wake_event_type is filled only by a migration (no login writes it), a row must name a type in the namespace of its scope's line, and the delivery table's CHECK
//   (mcp_wake_body_ok) refuses a body whose type the catalog does not list, whose keys are not exactly the listed fields or whose value is not of its kind, whatever writes the row;
// - an event of a line's type is stored only for a company grant that holds the type's scope with the read scope: a read-only grant, a grant of another line and a member-bound grant are refused (MCP_WAKE_SCOPE), in
//   the database, and a fixed type (signal, schedule, ping) behaves as before.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { LINE_WAKE_EVENTS, lineTypeProblem, wakeBody, wakeEvent, type LineWakeRegistry } from '../../src/mcp-wake-body.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';

// A line's registry as a test builds it (the product's is empty): one Engage type with one field of each kind.
const TYPE = 'engage.conversation_unanswered';
const REGISTRY: LineWakeRegistry = {
  [TYPE]: { scope: ENGAGE, fields: { conversation_id: 'id', since: 'date', amount: 'amount', channel: ['facebook', 'zalo', 'email'] } },
};
const ids = () => ({ id: randomUUID(), org: randomUUID(), grant: randomUUID() });
const head = (type: string) => ({ ...ids(), type, created_at: '2026-11-19T03:00:00.000Z' });
const DATA = { conversation_id: randomUUID(), since: '2026-11-18', amount: '1250000.5', channel: 'zalo' };

describe('the builder of a line wake body (#3858 slice e)', () => {
  it('builds a body of a registered type with exactly the registered fields, each of its kind', () => {
    const event = { ...head(TYPE), data: DATA };
    const text = wakeBody(event, REGISTRY);
    expect(JSON.parse(text)).toEqual(event);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['id', 'type', 'created_at', 'org', 'grant', 'data']);
    expect(wakeEvent(event, REGISTRY).type).toBe(TYPE);
  });

  it('refuses a type that is not registered, with the default registry (empty) and with another one, and a fixed type given a line\'s data', () => {
    expect(Object.keys(LINE_WAKE_EVENTS)).toEqual([]);
    const event = { ...head(TYPE), data: DATA };
    expect(() => wakeBody(event)).toThrow();
    expect(() => wakeBody({ ...event, type: 'engage.other' }, REGISTRY)).toThrow();
    expect(() => wakeBody({ ...head('ping'), data: DATA }, REGISTRY)).toThrow();
    expect(() => wakeBody({ ...head('signal.fired'), data: DATA }, REGISTRY)).toThrow();
    // A fixed type cannot be re-registered by a line.
    expect(() => wakeBody({ ...head('ping'), data: {} }, { ping: { scope: ENGAGE, fields: { x: 'id' } } } as never)).not.toThrow();
    expect(lineTypeProblem('ping', { scope: ENGAGE, fields: { x: 'id' } })).not.toBeNull();
  });

  it('refuses an unlisted field, a missing one, a name or note in any field, a wrong kind, and a key at the top', () => {
    const base = { ...head(TYPE), data: DATA };
    const hostile: Array<[string, unknown]> = [
      ['an unlisted field', { ...base, data: { ...DATA, customer_name: 'Nguyễn Văn A' } }],
      ['a missing field', { ...base, data: { conversation_id: DATA.conversation_id, since: DATA.since, amount: DATA.amount } }],
      ['a name as the id', { ...base, data: { ...DATA, conversation_id: 'Nguyễn Văn A' } }],
      ['an email as the id', { ...base, data: { ...DATA, conversation_id: 'khach@example.com' } }],
      ['text as the date', { ...base, data: { ...DATA, since: 'hôm qua' } }],
      ['an account number as the amount', { ...base, data: { ...DATA, amount: '0123456789' } }],
      ['an amount as a number', { ...base, data: { ...DATA, amount: 1250000 } }],
      ['a word outside the enum', { ...base, data: { ...DATA, channel: 'Nguyễn Văn A' } }],
      ['a message as the enum word', { ...base, data: { ...DATA, channel: 'xin chào, gọi lại cho tôi' } }],
      ['a number as an id', { ...base, data: { ...DATA, conversation_id: 5 } }],
      ['a note at the top', { ...base, note: 'gọi lại khách' }],
      ['an array as a field', { ...base, data: { ...DATA, since: ['2026-11-18'] } }],
      ['an empty data', { ...base, data: {} }],
    ];
    for (const [name, body] of hostile) {
      let text: string | null = null;
      try {
        text = wakeBody(body, REGISTRY);
      } catch {
        text = null;
      }
      expect(text, name).toBeNull();
    }
  });

  it('refuses a registry entry that is not well formed: outside its scope\'s namespace, a bad field name or kind, too many fields, a fixed type\'s name', () => {
    const ok = { scope: ENGAGE, fields: { a: 'id' } } as const;
    expect(lineTypeProblem('engage.a_b', ok)).toBeNull();
    for (const [type, entry] of [
      ['ads.something', ok],
      ['engage', ok],
      ['Engage.a', ok],
      ['engage.a', { scope: ENGAGE, fields: {} }],
      ['engage.a', { scope: ENGAGE, fields: { 'Bad Name': 'id' } }],
      ['engage.a', { scope: ENGAGE, fields: { a: 'text' } }],
      ['engage.a', { scope: ENGAGE, fields: { a: [] } }],
      ['engage.a', { scope: ENGAGE, fields: { a: ['Free text allowed'] } }],
      ['engage.a', { scope: ENGAGE, fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${String.fromCharCode(97 + i)}`, 'id'])) }],
      ['signal.fired', { scope: ENGAGE, fields: { a: 'id' } }],
    ] as Array<[string, never]>) {
      expect(lineTypeProblem(type, entry), `${type} ${JSON.stringify(entry)}`).not.toBeNull();
    }
  });
});

suite('what the database holds of a line wake event (#3858 slice e)', () => {
  const dbName = `crove_test_mcp_wake_line_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgA = '';
  let owner = '';
  let member = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const asLogin = async (login: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = login;
    u.password = password;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    return c;
  };

  async function grant(scopes: string[], kind: 'company' | 'member' = 'company'): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Dy', 'client.example.com', $5::text[], $6, now(), now() + interval '30 days', $3, $7, $8)`,
      [orgA, id, owner, `client-${id}`, scopes, `oauth-${id}`, kind, kind === 'member' ? owner : null],
    );
    await q(
      `INSERT INTO crove_kernel.agent_grant_wake (org_id, grant_id, url, secret_sealed, secret_hint, created_by, enabled, schedule)
       VALUES ($1, $2, 'https://hooks.example.com/ludy', '{"keyId":"k","envelope":"e"}'::jsonb, 'whk_0123abcd', $3, true, 'off')`,
      [orgA, id, owner],
    );
    return id;
  }
  // The worker's login enters the org's system context (the shape enter_system_context seals) and stores an event, as the sweep's command does.
  async function enqueue(grantId: string, type: string, body: unknown): Promise<string> {
    const c = await asLogin('crove_worker', 'test-worker-pw');
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
      const id = (body as { id: string }).id;
      return await c
        .query<{ ok: boolean }>('SELECT crove_kernel.mcp_wake_enqueue($1::uuid, $2::uuid, $3::text, $4::jsonb, NULL) AS ok', [id, grantId, type, JSON.stringify(body)])
        .then((r) => (r.rows[0]?.ok ? 'stored' : 'not stored'), (e: Error) => e.message);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const stored = (grantId: string) => q<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.agent_wake_delivery WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0]?.n ?? 0);

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'mcp-wake-line', subject: 'owner', email: 'owner@mcp-wake-line.test', name: 'owner' });
    member = await upsertIdentity(db, { issuer: 'mcp-wake-line', subject: 'member', email: 'member@mcp-wake-line.test', name: 'member' });
    orgA = (await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' } as UserActor, 'Org A')).orgId;
    await q(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgA, member]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('has an empty catalog in the product, equal to the registry in code, written by no login and readable by the tenant role', async () => {
    expect((await q(`SELECT type FROM crove_kernel.mcp_wake_event_type ORDER BY type`)).rows.map((r) => r.type)).toEqual(Object.keys(LINE_WAKE_EVENTS).sort());
    await admin(async (c) => {
      const logins = (await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper`)).rows;
      for (const { rolname } of logins) {
        for (const right of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          expect((await c.query(`SELECT has_table_privilege($1, 'crove_kernel.mcp_wake_event_type', $2) AS ok`, [rolname, right])).rows[0]?.ok, `${rolname} ${right}`).toBe(false);
        }
      }
      expect((await c.query(`SELECT has_table_privilege('crove_tenant', 'crove_kernel.mcp_wake_event_type', 'SELECT') AS ok`)).rows[0]?.ok).toBe(true);
      expect((await c.query(`SELECT has_table_privilege('public', 'crove_kernel.mcp_wake_event_type', 'SELECT') AS ok`)).rows[0]?.ok).toBe(false);
    });
  });

  it('refuses a catalog row outside its scope\'s namespace, with a bad field or kind, with a fixed type\'s name, or with a scope that is not a write scope', async () => {
    const insert = (type: string, scope: string, fields: unknown) =>
      q(`INSERT INTO crove_kernel.mcp_wake_event_type (type, scope, fields, adr) VALUES ($1, $2, $3::jsonb, 'ADR-0051')`, [type, scope, JSON.stringify(fields)]).then(() => 'ok', (e: Error) => e.message);
    expect(await insert('ads.pace', ENGAGE, { a: 'id' })).toMatch(/violates check/);
    expect(await insert('ping', ENGAGE, { a: 'id' })).toMatch(/violates check/);
    expect(await insert('engage.x', 'ludy.read', { a: 'id' })).toMatch(/violates check/);
    expect(await insert('engage.x', ENGAGE, {})).toMatch(/violates check/);
    expect(await insert('engage.x', ENGAGE, { 'Bad Name': 'id' })).toMatch(/violates check/);
    expect(await insert('engage.x', ENGAGE, { a: 'free_text' })).toMatch(/violates check/);
    expect(await insert('engage.x', ENGAGE, { a: ['Free text'] })).toMatch(/violates check/);
    expect(await insert('engage.x', ENGAGE, { a: 'id' })).toBe('ok');
    await q(`DELETE FROM crove_kernel.mcp_wake_event_type WHERE type = 'engage.x'`);
  });

  it('accepts a line body only for a registered type with exactly its fields, however the row is written, and refuses every other', async () => {
    await q(`INSERT INTO crove_kernel.mcp_wake_event_type (type, scope, fields, adr) VALUES ($1, $2, $3::jsonb, 'ADR-0051')`, [TYPE, ENGAGE, JSON.stringify({ conversation_id: 'id', since: 'date', amount: 'amount', channel: ['facebook', 'zalo', 'email'] })]);
    try {
      const g = await grant(['ludy.read', ENGAGE]);
      const id = randomUUID();
      const good = { id, type: TYPE, created_at: '2026-11-19T03:00:00.000Z', org: orgA, grant: g, data: DATA };
      const insert = (body: unknown, type = TYPE) => q(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orgA, id, g, type, JSON.stringify(body)]);
      await insert(good);
      await q(`DELETE FROM crove_kernel.agent_wake_delivery WHERE id = $1`, [id]);
      const bad: Array<[string, unknown, string?]> = [
        ['an unlisted field', { ...good, data: { ...DATA, customer_name: 'Nguyễn Văn A' } }],
        ['a missing field', { ...good, data: { conversation_id: DATA.conversation_id, since: DATA.since, amount: DATA.amount } }],
        ['a name as the id', { ...good, data: { ...DATA, conversation_id: 'Nguyễn Văn A' } }],
        ['text as the date', { ...good, data: { ...DATA, since: 'hôm qua' } }],
        ['an account number as the amount', { ...good, data: { ...DATA, amount: '0123456789' } }],
        ['a word outside the enum', { ...good, data: { ...DATA, channel: 'xin chào' } }],
        ['a number as a field', { ...good, data: { ...DATA, amount: 12 } }],
        ['a note at the top', { ...good, note: 'gọi lại' }],
        ['another org', { ...good, org: randomUUID() }],
        ['an items array of a signal under a line type', { ...good, data: { items: [] } }],
        ['a type the catalog does not list', { ...good, type: 'engage.not_registered' }, 'engage.not_registered'],
        ['a type of another line', { ...good, type: 'ads.pace' }, 'ads.pace'],
        ['a fixed type with line data', { ...good, type: 'ping' }, 'ping'],
        ['a type outside the line shape', { ...good, type: 'note.created' }, 'ping'],
      ];
      for (const [name, body, type] of bad) await expect(insert(body, type ?? TYPE), name).rejects.toThrow();
      expect(await stored(g)).toBe(0);
    } finally {
      await q(`DELETE FROM crove_kernel.mcp_wake_event_type WHERE type = $1`, [TYPE]);
    }
  });

  it('refuses a line body once the type is no longer registered (the catalog is the only list), and keeps a fixed type\'s body as before', async () => {
    const g = await grant(['ludy.read', ENGAGE]);
    const id = randomUUID();
    const row = { id, type: TYPE, created_at: '2026-11-19T03:00:00.000Z', org: orgA, grant: g, data: DATA };
    await expect(q(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orgA, id, g, TYPE, JSON.stringify(row)])).rejects.toThrow();
    const ping = { id, type: 'ping', created_at: '2026-11-19T03:00:00.000Z', org: orgA, grant: g, data: {} };
    await q(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, 'ping', $4::jsonb)`, [orgA, id, g, JSON.stringify(ping)]);
    await q(`DELETE FROM crove_kernel.agent_wake_delivery WHERE id = $1`, [id]);
  });

  it('stores an event of a line\'s type only for a company grant that holds the type\'s scope with the read scope, in the database', async () => {
    await q(`INSERT INTO crove_kernel.mcp_wake_event_type (type, scope, fields, adr) VALUES ($1, $2, $3::jsonb, 'ADR-0051')`, [TYPE, ENGAGE, JSON.stringify({ conversation_id: 'id', since: 'date', amount: 'amount', channel: ['facebook', 'zalo', 'email'] })]);
    try {
      const body = (g: string) => ({ id: randomUUID(), type: TYPE, created_at: '2026-11-19T03:00:00.000Z', org: orgA, grant: g, data: DATA });
      const holder = await grant(['ludy.read', ENGAGE]);
      const withAll = await grant(['ludy.read', 'ludy.social.draft', ENGAGE, ADS]);
      const readOnly = await grant(['ludy.read']);
      const otherLine = await grant(['ludy.read', ADS]);
      const memberBound = await grant(['ludy.member.read'], 'member');
      expect(await enqueue(holder, TYPE, body(holder)), 'the holder of the scope').toBe('stored');
      expect(await enqueue(withAll, TYPE, body(withAll)), 'a grant with every write scope').toBe('stored');
      for (const [label, g] of [['a read-only grant', readOnly], ['a grant of another line', otherLine], ['a member-bound grant', memberBound]] as const) {
        expect(await enqueue(g, TYPE, body(g)), label).toBe('MCP_WAKE_SCOPE');
        expect(await stored(g), label).toBe(0);
      }
      // A type the catalog does not list is refused for every grant, the holder included, and so is a fixed type under a body of another shape.
      expect(await enqueue(holder, 'engage.not_registered', { ...body(holder), type: 'engage.not_registered' })).toBe('MCP_WAKE_SCOPE');
      // A fixed type behaves as before: a ping is stored for a company grant, whatever its scopes, and a signal is refused for a member-bound grant.
      const ping = (g: string) => ({ id: randomUUID(), type: 'ping', created_at: '2026-11-19T03:00:00.000Z', org: orgA, grant: g, data: {} });
      expect(await enqueue(readOnly, 'ping', ping(readOnly))).toBe('stored');
      expect(await enqueue(memberBound, 'signal.fired', { ...ping(memberBound), type: 'signal.fired', data: { items: [] } })).toBe('MCP_WAKE_INVALID');
    } finally {
      await q(`DELETE FROM crove_kernel.mcp_wake_event_type WHERE type = $1`, [TYPE]);
    }
  });
});
