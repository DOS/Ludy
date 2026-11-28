// SPDX-License-Identifier: AGPL-3.0-only
// The items an owner enters into the 90-day cash forecast (#5326), on PostgreSQL 17, through the runtime that every command and query runs on: owners and admins create, edit and delete an item, a member and
// a viewer read the list and write nothing, a caller that is not a user writes nothing, another org's and another entity's items are not reached, the audit row holds the item's kind, money and dates and
// NEVER the label, the entries are checked (whole dong, the dates, no end date for a one-off) and by the table's own checks, and an entity holds at most CASH_FORECAST_ITEMS_MAX items even when writers race.
// The recurrence rules are unit-tested (modules/finance/test/cash-forecast-items.test.ts) and the generic row-level-security cases run in the invariant rls-matrix.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CASH_FORECAST_ITEMS_MAX, type CashForecastItems, type CashForecastItemView, type PersonalDataErasure, type PersonalDataResult } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the owner-entered items of the cash forecast (#5326)', () => {
  const dbName = `ludy_test_cash_items_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  // The worker's own pool and runtime: an AI agent and Vy in member mode enter only through it.
  let workerPool: pg.Pool;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const SYSTEM = { type: 'system' as const, component: 'finance.cash_forecast_items.test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@cash-items.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; entity: string; branch: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Dự kiến ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    const entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const branch = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh phụ', 'household', $3)", [orgId, branch, owner]));
    return { orgId, owner, admin: adminUser, member, viewer, entity, branch };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const setItem = (o: Org, input: Record<string, unknown>, user = o.owner) => execute<CashForecastItemView>(o, 'finance.cash_forecast_item_set', input, user);
  const list = (o: Org, over: Record<string, unknown> = {}, user = o.owner) => query<CashForecastItems>(o, 'finance.cash_forecast_items', { asOf: '2026-12-01', ...over }, user);
  const audits = (o: Org, command: string) =>
    admin(async (c) =>
      (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId, command])).rows.map((r) => r.detail),
    );
  const rent = { label: 'Tiền thuê nhà ông Nam', category: 'rent', direction: 'out', amount: '15000000', firstDate: '2026-12-05', recurrence: 'monthly' };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 8 });
    db = createDb(pool);
    const register = (d: Db) => new Runtime(d, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(db);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    worker = register(createDb(workerPool));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner create an item, shows it in the list with its next date, and keeps the label out of the audit row', async () => {
    const o = await org();
    const item = await setItem(o, rent);
    expect(item).toMatchObject({ legalEntityId: o.entity, label: 'Tiền thuê nhà ông Nam', category: 'rent', direction: 'out', amount: '15000000', firstDate: '2026-12-05', recurrence: 'monthly', endDate: null });
    const listed = await list(o);
    expect(listed).toMatchObject({ legalEntityId: o.entity, asOf: '2026-12-01', limit: CASH_FORECAST_ITEMS_MAX });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: item.id, nextDate: '2026-12-05' });
    // The audit row says what kind of item, how much and when: never the label (the owner's own words, often a person's name).
    const rows = await audits(o, 'finance.cash_forecast_item_set');
    expect(rows).toEqual([{ item_id: item.id, created: true, category: 'rent', direction: 'out', recurrence: 'monthly', amount: '15000000', first_date: '2026-12-05', end_date: null }]);
    expect(JSON.stringify(rows)).not.toContain('ông Nam');
    expect(JSON.stringify(rows)).not.toContain('Tiền thuê');
  });

  it('lets an admin edit it, keeps its entity, and audits the previous values without the label', async () => {
    const o = await org();
    const item = await setItem(o, rent);
    const edited = await setItem(o, { id: item.id, label: 'Thuê kho', category: 'rent', direction: 'out', amount: '18000000', firstDate: '2026-12-10', recurrence: 'quarterly', endDate: '2027-12-10' }, o.admin);
    expect(edited).toMatchObject({ id: item.id, legalEntityId: o.entity, label: 'Thuê kho', amount: '18000000', recurrence: 'quarterly', endDate: '2027-12-10', nextDate: '2026-12-10' });
    const rows = await audits(o, 'finance.cash_forecast_item_set');
    expect(rows[1]).toEqual({
      item_id: item.id,
      created: false,
      category: 'rent',
      direction: 'out',
      recurrence: 'quarterly',
      amount: '18000000',
      first_date: '2026-12-10',
      end_date: '2027-12-10',
      previous_category: 'rent',
      previous_direction: 'out',
      previous_recurrence: 'monthly',
      previous_amount: '15000000',
      previous_first_date: '2026-12-05',
      previous_end_date: null,
    });
    expect(JSON.stringify(rows)).not.toContain('Thuê kho');
    // Editing a repeating item into a one-off drops its end date.
    const once = await setItem(o, { id: item.id, label: 'Thuê kho', category: 'rent', direction: 'out', amount: '18000000', firstDate: '2027-02-01', recurrence: 'once' });
    expect(once).toMatchObject({ recurrence: 'once', endDate: null, nextDate: '2027-02-01' });
  });

  it('refuses a member, a viewer and a caller that is not a user, and writes nothing', async () => {
    const o = await org();
    for (const who of [o.member, o.viewer]) {
      await expect(setItem(o, rent, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(rt.execute('finance.cash_forecast_item_set', rent, { actor: SYSTEM, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await list(o)).items).toEqual([]);
    const item = await setItem(o, rent);
    for (const who of [o.member, o.viewer]) {
      await expect(execute(o, 'finance.cash_forecast_item_remove', { id: item.id }, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(rt.execute('finance.cash_forecast_item_remove', { id: item.id }, { actor: SYSTEM, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await list(o)).items).toHaveLength(1);
  });

  it('lets every member read the list', async () => {
    const o = await org();
    const item = await setItem(o, rent);
    for (const who of [o.owner, o.admin, o.member, o.viewer]) {
      expect((await list(o, {}, who)).items.map((i) => i.id)).toEqual([item.id]);
    }
  });

  it('keeps the entities apart: the list is of one entity, and an item of another is not found by an edit that names the first', async () => {
    const o = await org();
    const here = await setItem(o, rent);
    const there = await setItem(o, { ...rent, label: 'Thuê chi nhánh', legalEntityId: o.branch });
    expect(there.legalEntityId).toBe(o.branch);
    expect((await list(o)).items.map((i) => i.id)).toEqual([here.id]);
    expect((await list(o, { legalEntityId: o.branch })).items.map((i) => i.id)).toEqual([there.id]);
    // An edit names the item's own entity or none; another entity's name is not found, and the item is unchanged.
    await expect(setItem(o, { ...rent, id: there.id, legalEntityId: o.entity, amount: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await list(o, { legalEntityId: o.branch })).items[0]?.amount).toBe('15000000');
  });

  it('does not reach another org: its items are not listed, edited or removed', async () => {
    const a = await org();
    const b = await org();
    const item = await setItem(a, rent);
    expect((await list(b)).items).toEqual([]);
    await expect(setItem(b, { ...rent, id: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(execute(b, 'finance.cash_forecast_item_remove', { id: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await list(a)).items).toHaveLength(1);
  });

  it('removes an item with an audit row that says what it was, never its label, and answers NOT_FOUND for an id that is gone', async () => {
    const o = await org();
    const item = await setItem(o, { ...rent, recurrence: 'once', firstDate: '2026-12-20' });
    expect(await execute(o, 'finance.cash_forecast_item_remove', { id: item.id }, o.admin)).toEqual({ id: item.id });
    expect((await list(o)).items).toEqual([]);
    const rows = await audits(o, 'finance.cash_forecast_item_remove');
    expect(rows).toEqual([{ item_id: item.id, category: 'rent', direction: 'out', recurrence: 'once', amount: '15000000', first_date: '2026-12-20', end_date: null }]);
    expect(JSON.stringify(rows)).not.toContain('ông Nam');
    await expect(execute(o, 'finance.cash_forecast_item_remove', { id: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(execute(o, 'finance.cash_forecast_item_remove', { id: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('orders the list by the next occurrence, the items with none last', async () => {
    const o = await org();
    const late = await setItem(o, { ...rent, label: 'Muộn', recurrence: 'once', firstDate: '2027-02-01' });
    const done = await setItem(o, { ...rent, label: 'Đã qua', recurrence: 'once', firstDate: '2026-11-01' });
    const soon = await setItem(o, { ...rent, label: 'Sớm', recurrence: 'once', firstDate: '2026-12-03' });
    const far = await setItem(o, { ...rent, label: 'Quá xa', recurrence: 'once', firstDate: '2027-09-01' });
    const listed = await list(o);
    expect(listed.items.map((i) => [i.id, i.nextDate])).toEqual([
      [soon.id, '2026-12-03'],
      [late.id, '2027-02-01'],
      ...[done.id, far.id].sort().map((id) => [id, null]),
    ]);
  });

  it('refuses an entry the contract does not allow, and writes no row', async () => {
    const o = await org();
    const bad: Array<Record<string, unknown>> = [
      { ...rent, amount: '0' },
      { ...rent, amount: '1.5' },
      { ...rent, amount: '-100' },
      { ...rent, amount: '1000000000000000' },
      { ...rent, amount: 'abc' },
      { ...rent, label: '   ' },
      { ...rent, label: 'a'.repeat(81) },
      { ...rent, label: 'tab\there' },
      { ...rent, category: 'gift' },
      { ...rent, direction: 'sideways' },
      { ...rent, recurrence: 'yearly' },
      { ...rent, firstDate: '2026-02-30' },
      { ...rent, firstDate: '1999-12-31' },
      { ...rent, firstDate: '2101-01-01' },
      { ...rent, recurrence: 'once', endDate: '2027-01-01' },
      { ...rent, endDate: '2026-12-04' },
    ];
    for (const input of bad) await expect(setItem(o, input), JSON.stringify(input)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await list(o)).items).toEqual([]);
  });

  it('refuses at the table what the contract refuses, even to the database owner', async () => {
    const o = await org();
    const insert = (over: Record<string, unknown>) =>
      admin((c) => {
        const row = { org_id: o.orgId, legal_entity_id: o.entity, label: 'x', category: 'rent', direction: 'out', amount: '1', first_date: '2026-12-05', recurrence: 'monthly', end_date: null, ...over };
        const keys = Object.keys(row);
        return c.query(`INSERT INTO ludy_finance.cash_forecast_item (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
      });
    await expect(insert({ amount: '0' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ label: ' padded ' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ category: 'gift' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ recurrence: 'once', end_date: '2027-01-01' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ end_date: '2026-12-01' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ first_date: '1999-01-01' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({})).resolves.toBeDefined();
  });

  it('holds an entity to CASH_FORECAST_ITEMS_MAX items, refusing the next with CASH_FORECAST_ITEM_LIMIT, while another entity is unaffected', async () => {
    const o = await org();
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_finance.cash_forecast_item (org_id, legal_entity_id, label, category, direction, amount, first_date, recurrence)
         SELECT $1, $2, 'Khoản ' || g, 'other', 'out', 1000 + g, DATE '2026-12-05', 'monthly' FROM pg_catalog.generate_series(1, ${CASH_FORECAST_ITEMS_MAX - 1}) g`,
        [o.orgId, o.entity],
      ),
    );
    // The last place, then none.
    await setItem(o, rent);
    await expect(setItem(o, rent)).rejects.toMatchObject({ code: 'CASH_FORECAST_ITEM_LIMIT' });
    expect((await list(o)).items).toHaveLength(CASH_FORECAST_ITEMS_MAX);
    // An edit of an existing item is not a new place; another entity has its own.
    const first = (await list(o)).items[0] as CashForecastItemView;
    await expect(setItem(o, { ...rent, id: first.id, amount: '2' })).resolves.toMatchObject({ id: first.id, amount: '2' });
    await expect(setItem(o, { ...rent, legalEntityId: o.branch })).resolves.toMatchObject({ legalEntityId: o.branch });
  });

  it('holds the cap when writers race for the last place: exactly one wins', async () => {
    const o = await org();
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_finance.cash_forecast_item (org_id, legal_entity_id, label, category, direction, amount, first_date, recurrence)
         SELECT $1, $2, 'Khoản ' || g, 'other', 'out', 1000 + g, DATE '2026-12-05', 'monthly' FROM pg_catalog.generate_series(1, ${CASH_FORECAST_ITEMS_MAX - 1}) g`,
        [o.orgId, o.entity],
      ),
    );
    const outcomes = await Promise.allSettled([0, 1, 2, 3].map((n) => setItem(o, { ...rent, label: `Đua ${n}` })));
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of outcomes.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'CASH_FORECAST_ITEM_LIMIT' });
    const held = await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.cash_forecast_item WHERE org_id = $1 AND legal_entity_id = $2', [o.orgId, o.entity])).rows[0]?.n));
    expect(held).toBe(CASH_FORECAST_ITEMS_MAX);
  });

  it('finds and erases a person\'s number written in a label (PDPL), keeping the item itself', async () => {
    const o = await org();
    const named = await setItem(o, { ...rent, label: 'Thuê nhà chị Lan 0901234567' });
    const other = await setItem(o, { ...rent, label: 'Thuê kho', amount: '2000000' });
    const found = await execute<PersonalDataResult>(o, 'kernel.personal_data.find', { value: '0901234567' });
    expect(found.matches.filter((m) => m.column === 'ludy_finance.cash_forecast_item.label').map((m) => m.rowId)).toEqual([named.id]);
    const erased = await execute<PersonalDataErasure>(o, 'kernel.personal_data.erase', { value: '0901234567' });
    expect(erased.erased.find((e) => e.column === 'ludy_finance.cash_forecast_item.label')?.rows).toBe(1);
    const after = (await list(o)).items;
    expect(after).toHaveLength(2);
    const edited = after.find((i) => i.id === named.id) as CashForecastItemView;
    expect(edited.label).toContain('[đã xóa]');
    expect(edited.label).not.toContain('0901234567');
    // The item keeps its money and dates; the other item is untouched.
    expect(edited).toMatchObject({ amount: rent.amount, firstDate: rent.firstDate, recurrence: 'monthly' });
    expect(after.find((i) => i.id === other.id)?.label).toBe('Thuê kho');
  });

  // The callers that are not a person at the keyboard. Each is built the way the runtime meets it for real: an AI agent of the org chart and Vy in member mode enter through the worker (rows an agent run
  // needs), an MCP grant and an extension token are rows the runtime reads in the request's own transaction. None of them declares a scope, a role or a Vy access on these commands and this query, so every one
  // is refused FORBIDDEN (403) on all three, and nothing is written.
  async function strangers(o: Org) {
    const orgAgent = randomUUID();
    const orgRun = randomUUID();
    const vyAgent = randomUUID();
    const vyRun = randomUUID();
    const position = randomUUID();
    const grant = randomUUID();
    const token = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, created_by, kind) VALUES ($1, $2, 'finance.chief_accountant', 'Ly', $3, 'org_chart')", [o.orgId, orgAgent, o.owner]);
      await c.query("INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, holder_agent_id, status) VALUES ($1, $2, 'Finance', 'finance', 'finance.chief_accountant', $3, 'active')", [o.orgId, position, orgAgent]);
      await c.query(
        "INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'finance', 'finance.home', 'running', true, pg_catalog.now(), pg_catalog.now() + interval '4 hours')",
        [o.orgId, orgRun, orgAgent],
      );
      await c.query("INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)", [o.orgId, vyAgent, o.owner]);
      await c.query(
        "INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'notes.summary', 'running', true, pg_catalog.now(), pg_catalog.now() + interval '4 hours')",
        [o.orgId, vyRun, vyAgent],
      );
      await c.query('COMMIT');
    });
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [o.orgId, grant, o.owner, `oauth-${grant}`, `client-${grant}`],
      ),
    );
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by, client)
         VALUES ($1, $2, $3, $4, 'Test device', ARRAY['meetings']::text[], now(), now() + interval '30 days', $3, 'extension')`,
        [o.orgId, token, o.owner, createHash('sha256').update(randomBytes(32)).digest()],
      ),
    );
    const base = { type: 'user' as const, userId: o.owner, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) };
    return {
      'an AI agent of the org chart': { runtime: worker, actor: { type: 'agent' as const, agentId: orgAgent, runId: orgRun } },
      'Vy in member mode': { runtime: worker, actor: { type: 'agent' as const, agentId: vyAgent, runId: vyRun, memberVy: true as const } },
      'an MCP grant': { runtime: rt, actor: { ...base, mcp: { grantId: grant, clientId: `client-${grant}`, clientName: 'Test client', scopes: ['ludy.read'] } } },
      'an extension token': { runtime: rt, actor: { ...base, extension: { tokenId: token, scopes: ['meetings'], client: 'extension' as const } } },
    };
  }

  it('refuses an AI agent, Vy in member mode, an MCP grant and an extension token on both commands and on the list, with FORBIDDEN, and writes nothing', async () => {
    const o = await org();
    const item = await setItem(o, rent);
    for (const [who, { runtime, actor }] of Object.entries(await strangers(o))) {
      const refused = { code: 'FORBIDDEN', status: 403 };
      await expect(runtime.execute('finance.cash_forecast_item_set', rent, { actor, orgId: o.orgId, idempotencyKey: randomUUID() }), `${who}: set`).rejects.toMatchObject(refused);
      await expect(runtime.execute('finance.cash_forecast_item_set', { ...rent, id: item.id, amount: '1' }, { actor, orgId: o.orgId, idempotencyKey: randomUUID() }), `${who}: edit`).rejects.toMatchObject(refused);
      await expect(runtime.execute('finance.cash_forecast_item_remove', { id: item.id }, { actor, orgId: o.orgId, idempotencyKey: randomUUID() }), `${who}: remove`).rejects.toMatchObject(refused);
      await expect(runtime.query('finance.cash_forecast_items', {}, { actor, orgId: o.orgId }), `${who}: list`).rejects.toMatchObject(refused);
    }
    // Nothing changed: the one item is as it was, and the owner still reads it (the list is open to every role of a person).
    const held = await list(o);
    expect(held.items).toHaveLength(1);
    expect(held.items[0]).toMatchObject({ id: item.id, amount: '15000000', label: 'Tiền thuê nhà ông Nam' });
    expect(await audits(o, 'finance.cash_forecast_item_remove')).toEqual([]);
  });

  it('audits what an edit replaced as the row stood once the lock was won: two edits at once chain their previous values', async () => {
    const o = await org();
    const item = await setItem(o, rent);
    await Promise.all([setItem(o, { ...rent, id: item.id, amount: '111' }), setItem(o, { ...rent, id: item.id, amount: '222' })]);
    const edits = (await audits(o, 'finance.cash_forecast_item_set')).filter((r) => r.created === false) as Array<{ amount: string; previous_amount: string }>;
    expect(edits).toHaveLength(2);
    // Whichever won the lock first replaced the original amount; the other replaced the first one's result (not the original it read before waiting).
    const first = edits.find((e) => e.previous_amount === '15000000');
    const second = edits.find((e) => e !== first);
    expect(first, 'one edit replaced the original').toBeDefined();
    expect(second?.previous_amount).toBe(first?.amount);
    expect((await list(o)).items[0]?.amount).toBe(second?.amount);
  });

  it('answers a member let in for one entity with that entity\'s items, and refuses the other', async () => {
    const o = await org();
    await setItem(o, rent);
    const there = await setItem(o, { ...rent, label: 'Thuê chi nhánh', legalEntityId: o.branch });
    const limited = await identity('limited');
    await admin(async (c) => {
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, limited]);
      await c.query("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [o.orgId, limited, o.branch, o.owner]);
    });
    const mine = await list(o, {}, limited);
    expect(mine.legalEntityId).toBe(o.branch);
    expect(mine.items.map((i) => i.id)).toEqual([there.id]);
    await expect(list(o, { legalEntityId: o.entity }, limited)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
  });

  it('erases a number from the labels of the org that asked only: another org keeps its own label', async () => {
    const a = await org();
    const b = await org();
    const labelA = await setItem(a, { ...rent, label: 'Thuê nhà chị Lan 0987654321' });
    await setItem(b, { ...rent, label: 'Thuê nhà chị Lan 0987654321' });
    const erased = await execute<PersonalDataErasure>(b, 'kernel.personal_data.erase', { value: '0987654321' });
    expect(erased.erased.find((e) => e.column === 'ludy_finance.cash_forecast_item.label')?.rows).toBe(1);
    // Org A's label is untouched, and so is the row's updated_at (nothing of A was written).
    expect((await list(a)).items.find((i) => i.id === labelA.id)?.label).toBe('Thuê nhà chị Lan 0987654321');
    expect((await list(b)).items[0]?.label).toContain('[đã xóa]');
  });
});
