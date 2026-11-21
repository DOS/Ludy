// SPDX-License-Identifier: AGPL-3.0-only
// The delivery side of an MCP grant's wake-up webhook (ADR-0051 decision 4, issue #3024, step b), through the runtime and the catalog:
// - the delivery tables are reachable by no login role, and their functions only by the delivery worker's login (the lists and the system's own writes), never by the API's;
// - the body the database accepts is the body the builder makes: ids equal to the row's, the pinned keys, the pinned shape of every value; a name, a note, a message or an
//   account number is refused whatever key it comes in, however the row is written;
// - the delivery steps are the system actor's alone: a user, an agent and an MCP grant are refused each of them, and a user context cannot call the definers.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { makeWakeSecret } from '../../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up delivery of an MCP grant (#3024, step b)', () => {
  const dbName = `crove_test_mcp_wake_delivery_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', memberA: '', ownerB: '' };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  // A token planted in the receiver's path: the URL is read back to an owner or admin only, so it must reach no other table.
  const TOKEN = `tok_${randomBytes(9).toString('hex')}`;
  const URL_OK = `https://hooks.example.com/ludy/${TOKEN}`;

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read'] } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function insertGrant(orgId: string, userId: string, extra = ''): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now() ${extra}, now() ${extra} + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
      ),
    );
    return id;
  }

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    url.username = dbIds ? dbIds.roleName('crove_worker') : 'crove_worker';
    url.password = 'test-worker-pw';
    workerUrl = url.toString();
    const pool = createDbPool({ connectionString: appUrl, max: 6 }, dbIds);
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries],
    });
    const db = createDb(pool);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-wake', subject: key, email: `${key}@mcp-wake.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('is reachable by no login role: not the tables, and the functions only by the delivery worker', async () => {
    await admin(async (c) => {
      const roles = (await c.query(`SELECT rolname FROM pg_catalog.pg_roles WHERE ((rolname LIKE 'crove\\_%' OR rolname LIKE 'ludy\\_%') AND rolname NOT LIKE '%\\_test\\_%' AND rolname NOT LIKE 'crove\\_test%' AND rolname NOT LIKE 'ludy\\_test%' AND rolname <> 'ludy_migrate_test')`)).rows.map((r: { rolname: string }) => r.rolname);
      for (const table of ['crove_kernel.agent_wake_delivery', 'crove_kernel.agent_wake_signal_seen']) {
        for (const role of roles) {
          for (const right of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
            expect((await c.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, table, right])).rows[0].ok, `${role} ${right} on ${table}`).toBe(false);
          }
        }
        expect((await c.query(`SELECT has_table_privilege('public', $1, 'SELECT') AS ok`, [table])).rows[0].ok).toBe(false);
        expect((await c.query(`SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = $1::regclass`, [table])).rows[0].relrowsecurity, `${table} row-level security`).toBe(true);
      }
      const worker = [
        'crove_kernel.mcp_wake_due(integer)',
        'crove_kernel.mcp_wake_open(integer)',
        'crove_kernel.mcp_wake_delivery_get(uuid, uuid)',
        'crove_kernel.mcp_wake_enqueue(uuid, uuid, text, jsonb, text[])',
        'crove_kernel.mcp_wake_touch(uuid)',
        'crove_kernel.mcp_wake_record(uuid, text, integer)',
        'crove_kernel.mcp_wake_signals_check(uuid, text[], text[])',
      ];
      const nobody = ['crove_kernel.mcp_wake_body_ok(jsonb, uuid, uuid, uuid, text)', 'crove_kernel.mcp_wake_system()'];
      // The test ping is asked for by a person through the API's login (step c2), never by the worker.
      const app = ['crove_kernel.mcp_wake_test(uuid)'];
      const grants: Array<[string, string[]]> = [
        ...worker.map((f): [string, string[]] => [f, ['crove_worker']]),
        ...app.map((f): [string, string[]] => [f, ['crove_app']]),
        ...nobody.map((f): [string, string[]] => [f, []]),
      ];
      for (const [fn, allowed] of grants) {
        for (const role of roles) {
          expect((await c.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok, `${role} execute ${fn}`).toBe(allowed.includes(role));
        }
        expect((await c.query(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [fn])).rows[0].ok, `public ${fn}`).toBe(false);
        const meta = (await c.query(`SELECT proconfig FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0];
        expect(JSON.stringify(meta.proconfig), fn).toContain('search_path=pg_catalog, pg_temp');
      }
    });
    // Through the real logins: the API cannot list or write a delivery, and the worker's lists carry ids, never a body or a URL.
    const asApp = createDbClient({ connectionString: appUrl }, dbIds);
    const asWorker = createDbClient({ connectionString: workerUrl }, dbIds);
    await asApp.connect();
    await asWorker.connect();
    try {
      await expect(asApp.query(`SELECT * FROM crove_kernel.mcp_wake_due(10)`)).rejects.toThrow(/permission denied/);
      await expect(asApp.query(`SELECT * FROM crove_kernel.agent_wake_delivery`)).rejects.toThrow(/permission denied/);
      await expect(asWorker.query(`SELECT * FROM crove_kernel.agent_wake_delivery`)).rejects.toThrow(/permission denied/);
      const due = await asWorker.query(`SELECT * FROM crove_kernel.mcp_wake_due(10)`);
      expect(due.fields.map((f) => f.name)).toEqual(['org_id', 'grant_id', 'user_id', 'schedule_due', 'due_day', 'signals_due']);
      const open = await asWorker.query(`SELECT * FROM crove_kernel.mcp_wake_open(10)`);
      expect(open.fields.map((f) => f.name)).toEqual(['org_id', 'id', 'kind']);
      // A write outside a system context in an org is refused whoever calls: the worker without a context has none.
      await expect(asWorker.query(`SELECT crove_kernel.mcp_wake_touch($1)`, [randomUUID()])).rejects.toThrow(/NO_CONTEXT/);
    } finally {
      await asApp.end();
      await asWorker.end();
    }
  });

  it('accepts only the body the builder makes: the pinned keys and shapes, with the ids of its own row, however the row is written', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const made = makeWakeSecret(vault, orgA, grant);
    await runtime.execute('kernel.mcp.wake.set', { grantId: grant, url: URL_OK, credential: made.credential }, { actor: browser(users.ownerA), orgId: orgA });
    const id = randomUUID();
    const itemOk = { rule: 'kernel.signals.deal_without_invoice', key: `deal_without_invoice:${randomUUID()}`, severity: 'warn', deal_id: randomUUID(), amount: '1250000.5', due_on: '2026-11-19', days: 7 };
    const head = { id, type: 'signal.fired', created_at: '2026-11-12T03:00:00.000Z', org: orgA, grant };
    const good = { ...head, data: { items: [itemOk] } };
    const bodies: Array<[string, unknown, boolean]> = [
      ['the body the builder makes', good, true],
      ['a schedule', { ...head, type: 'schedule.due', data: { date: '2026-11-12' } }, true],
      ['a ping', { ...head, type: 'ping', data: {} }, true],
      ['an amount with its currency', { ...good, data: { items: [{ ...itemOk, currency: 'USD' }] } }, true],
      ['a currency without an amount', { ...good, data: { items: [{ rule: itemOk.rule, key: itemOk.key, severity: 'warn', currency: 'USD' }] } }, false],
      ['a currency that is text', { ...good, data: { items: [{ ...itemOk, currency: 'dong' }] } }, false],
      ['a name beside the ids', { ...good, data: { items: [{ ...itemOk, party_name: 'Công ty TNHH Nguyễn Văn A' }] } }, false],
      ['a note at the top', { ...good, note: 'gọi lại khách' }, false],
      ['text in the rule', { ...good, data: { items: [{ ...itemOk, rule: 'Hợp đồng chưa có hóa đơn' }] } }, false],
      ['text in the key', { ...good, data: { items: [{ ...itemOk, key: ['Nguyen', 'Van', 'A', '0912345678'].join('_') }] } }, false],
      ['an account number as the amount', { ...good, data: { items: [{ ...itemOk, amount: '0123456789' }] } }, false],
      ['an amount as a number', { ...good, data: { items: [{ ...itemOk, amount: 1250000 }] } }, false],
      ['an email as an id', { ...good, data: { items: [{ ...itemOk, deal_id: 'khach@example.com' }] } }, false],
      ['text as the due day', { ...good, data: { items: [{ ...itemOk, due_on: 'thứ hai' }] } }, false],
      ['a day count out of range', { ...good, data: { items: [{ ...itemOk, days: 99999 }] } }, false],
      ['no items', { ...good, data: { items: [] } }, false],
      ['twenty-one items', { ...good, data: { items: Array.from({ length: 21 }, () => itemOk) } }, false],
      ['free text beside the items', { ...good, data: { items: [itemOk], summary: 'Hai khoản cần xem' } }, false],
      ['a ping with data', { ...head, type: 'ping', data: { note: 'x' } }, false],
      ['another org\'s id', { ...good, org: orgB }, false],
      ['another grant\'s id', { ...good, grant: randomUUID() }, false],
      ['another event id', { ...good, id: randomUUID() }, false],
      ['an unknown type', { ...head, type: 'note.created', data: {} }, false],
    ];
    for (const [name, body, ok] of bodies) {
      const type = (body as { type: string }).type;
      const row = admin((c) => c.query(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orgA, id, grant, type === 'note.created' ? 'ping' : type, JSON.stringify(body)]));
      if (ok) {
        await row;
        await admin((c) => c.query(`DELETE FROM crove_kernel.agent_wake_delivery WHERE id = $1`, [id]));
      } else {
        await expect(row, name).rejects.toThrow();
      }
    }
    // The type that may join the set (#3803: sent to a company grant when the minutes of an org-visible meeting are published): optional here so each side can land on its own. When the database accepts
    // it, it accepts exactly two data keys, an id and an instant, with the ids of its own row; whatever it does or does not accept yet, it never stores a title, a summary, a name, the camelCase keys or
    // another row's ids.
    const minutes = { ...head, type: 'meetings.minutes_published' };
    const minutesData = { meeting_id: randomUUID(), published_at: '2026-11-12T02:59:58.123Z' };
    const insertMinutes = (body: unknown) =>
      admin((c) => c.query(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, 'meetings.minutes_published', $4::jsonb)`, [orgA, id, grant, JSON.stringify(body)]));
    await insertMinutes({ ...minutes, data: minutesData }).then(
      () => admin((c) => c.query(`DELETE FROM crove_kernel.agent_wake_delivery WHERE id = $1`, [id])),
      () => undefined,
    );
    const hostileMinutes: Array<[string, unknown]> = [
      ['a title beside the meeting id', { ...minutes, data: { ...minutesData, title: 'Nguyen Van A họp giá' } }],
      ['a summary in the minutes event', { ...minutes, data: { ...minutesData, summary: 'Hai khoản cần xem' } }],
      ['the camelCase keys', { ...minutes, data: { meetingId: minutesData.meeting_id, publishedAt: minutesData.published_at } }],
      ['a name for the meeting id', { ...minutes, data: { meeting_id: 'Nguyen Van A', published_at: minutesData.published_at } }],
      ['text for the published instant', { ...minutes, data: { meeting_id: minutesData.meeting_id, published_at: 'thứ hai' } }],
      ['a date for the published instant', { ...minutes, data: { meeting_id: minutesData.meeting_id, published_at: '2026-11-12' } }],
      ['no meeting id', { ...minutes, data: { published_at: minutesData.published_at } }],
      ['items in the minutes event', { ...minutes, data: { items: [] } }],
      ['a note at the top', { ...minutes, data: minutesData, note: 'gọi lại khách' }],
      ['another org\'s id', { ...minutes, org: orgB, data: minutesData }],
      ['another grant\'s id', { ...minutes, grant: randomUUID(), data: minutesData }],
      ['another event id', { ...minutes, id: randomUUID(), data: minutesData }],
    ];
    for (const [name, body] of hostileMinutes) await expect(insertMinutes(body), name).rejects.toThrow();
    // The signal keys table holds only a rule's short name and ids.
    for (const key of ['Nguyen Van A', 'deal_without_invoice', 'deal_without_invoice:not-an-id', `Deal:${randomUUID()}`, 'x'.repeat(300)]) {
      await expect(admin((c) => c.query(`INSERT INTO crove_kernel.agent_wake_signal_seen (org_id, grant_id, key) VALUES ($1, $2, $3)`, [orgA, grant, key])), key).rejects.toThrow();
    }
  });

  it('runs the delivery steps for the system alone: a user, an agent and an MCP grant are each refused every one', async () => {
    const grant = await insertGrant(orgA, users.ownerA);
    const id = randomUUID();
    const body = { id, type: 'ping', created_at: '2026-11-12T03:00:00.000Z', org: orgA, grant, data: {} };
    const steps: Array<[string, unknown]> = [
      ['kernel.mcp.wake.enqueue', { id, grantId: grant, type: 'ping', body }],
      ['kernel.mcp.wake.queued', { id }],
      ['kernel.mcp.wake.record', { id, outcome: 'sent' }],
      ['kernel.mcp.wake.signals_check', { grantId: grant, keys: [], complete: [] }],
    ];
    const reads: Array<[string, unknown]> = [['kernel.mcp.wake.delivery', { id }], ['kernel.mcp.wake.target', { grantId: grant }]];
    const actors: Array<[string, UserActor]> = [
      ['an owner', browser(users.ownerA)],
      ['an admin', browser(users.adminA)],
      ['the MCP grant', mcp(users.ownerA, grant)],
      ['an agent', { type: 'agent', agentId: randomUUID(), runId: randomUUID() } as never],
    ];
    for (const [who, actor] of actors) {
      for (const [name, input] of steps) {
        const error = await refusal(runtime.execute(name, input, { actor, orgId: orgA }));
        expect(error.status, `${who} ${name}`).toBeGreaterThanOrEqual(401);
        expect(error.status, `${who} ${name}`).toBeLessThanOrEqual(403);
      }
      for (const [name, input] of reads) {
        const error = await refusal(runtime.query(name, input, { actor, orgId: orgA }));
        expect(error.status, `${who} ${name}`).toBeGreaterThanOrEqual(401);
        expect(error.status, `${who} ${name}`).toBeLessThanOrEqual(403);
      }
    }
    expect(await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_wake_delivery WHERE grant_id = $1`, [grant]).then((r) => r.rows[0].n))).toBe(0);
  });
});
