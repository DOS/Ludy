// SPDX-License-Identifier: AGPL-3.0-only
// The confirmed mapping of a marketplace report's columns (#4037, slice 2 of #3850) on PostgreSQL 17, through the runtime: a person confirms a mapping once per org and platform (the same mapping
// again adds nothing, a different one is a new row and the latest wins), a mapping the header row refuses is never stored, an agent or the system cannot confirm, an org reads only its own profile,
// the table keeps the shape (a sample or a cell value does not fit), and no header text reaches the audit row.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const DIGEST = 'a'.repeat(64);
// A header text no other test uses, so a search of the audit rows finds only what this test wrote.
const PLANTED_HEADER = `Marker-${randomUUID().slice(0, 8)}`;
const mapping = (extra: Array<{ index: number; header: string; field: string }> = []) => [
  { index: 0, header: 'Order ID', field: 'orderNo' },
  { index: 3, header: 'Quantity', field: 'quantity' },
  ...extra,
];

suite('the confirmed column mapping (#4037)', () => {
  const dbName = `crove_test_column_profile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let worker: Runtime;
  let member = '';
  let viewer = '';
  let agent: AgentActor;
  let owner = '';
  let orgId = '';
  let otherOwner = '';
  let otherOrg = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const confirm = (platform: string, columns: unknown, who = owner, org = orgId, headerRow = 1, headerDigest = DIGEST) =>
    rt.execute<{ id: string; added: boolean }>('finance.marketplace.columns_confirm', { platform, headerRow, columns, headerDigest }, { actor: asUser(who), orgId: org });
  const latest = (platform: string, who = owner, org = orgId) => rt.query<null | { id: string; columns: Array<{ index: number; header: string; field: string }>; headerRow: number }>('finance.marketplace.columns_profile', { platform }, { actor: asUser(who), orgId: org });
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = (text: string, values: unknown[] = []) => admin(async (c) => (await c.query(text, values)).rows);
  const stored = async (org = orgId) => Number((await rows('SELECT count(*) AS n FROM crove_finance.marketplace_column_profile WHERE org_id = $1', [org]))[0]?.n);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (db: Db) => new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(createDb(pool));
    worker = register(createDb(workerPool));
    const person = async (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@columns.test`, name: null });
    owner = await person('owner');
    orgId = (await createOrg(rt, asUser(owner), `Columns ${randomUUID().slice(0, 6)}`)).orgId;
    otherOwner = await person('other');
    otherOrg = (await createOrg(rt, asUser(otherOwner), `Columns other ${randomUUID().slice(0, 6)}`)).orgId;
    // A member and a viewer of the first org (the roles that may read but never confirm).
    member = await person('member');
    viewer = await person('viewer');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    // A live agent of the first org: installed from the template, holding its own position, with a run started through a task that wakes it (so its actor is a real one, and the call reaches the command's own gate).
    const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'finance.chief_accountant', reportsTo: null }, { actor: asMfa(owner), orgId });
    await rt.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId });
    if (!started.runId) throw new Error('the agent run did not start');
    agent = { type: 'agent', agentId, runId: started.runId };
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads null until a person confirms, then the confirmed mapping in the order of the header row', async () => {
    expect(await latest('shopee')).toBeNull();
    const first = await confirm('shopee', [...mapping().reverse(), { index: 5, header: 'Product', field: 'itemName' }]);
    expect(first.added).toBe(true);
    const profile = await latest('shopee');
    expect(profile).toMatchObject({ id: first.id, headerRow: 1 });
    expect(profile?.columns.map((c) => c.index)).toEqual([0, 3, 5]);
    expect(profile?.columns[0]).toEqual({ index: 0, header: 'Order ID', field: 'orderNo' });
    // Another platform of the same org has none.
    expect(await latest('tiktok_shop')).toBeNull();
  });

  it('adds nothing for the same mapping of the same header again, and a different one is a new row that wins', async () => {
    const before = await stored();
    const again = await confirm('shopee', [...mapping(), { index: 5, header: 'Product', field: 'itemName' }]);
    expect(again.added).toBe(false);
    expect(await stored()).toBe(before);
    const changed = await confirm('shopee', [...mapping(), { index: 6, header: 'Product name', field: 'itemName' }]);
    expect(changed.added).toBe(true);
    expect(changed.id).not.toBe(again.id);
    expect(await stored()).toBe(before + 1);
    expect((await latest('shopee'))?.id).toBe(changed.id);
    // The earlier confirmation is still there, never edited.
    expect(await rows('SELECT 1 FROM crove_finance.marketplace_column_profile WHERE org_id = $1 AND id = $2', [orgId, again.id])).toHaveLength(1);
  });

  it('refuses a mapping the header row refuses, and stores nothing for it', async () => {
    const before = await stored();
    const refused = async (columns: unknown, reason: string, platform = 'shopee') => {
      await expect(confirm(platform, columns)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_REFUSED', status: 422, details: { reason } });
    };
    await refused([...mapping(), { index: 7, header: 'Tên người mua', field: 'variation' }], 'buyer_column');
    await refused([{ index: 3, header: 'Quantity', field: 'quantity' }, { index: 5, header: 'Product', field: 'itemName' }], 'no_order_no');
    await refused([{ index: 0, header: 'Order ID', field: 'orderNo' }, { index: 5, header: 'Product', field: 'itemName' }], 'no_line');
    await refused([...mapping(), { index: 8, header: 'Qty again', field: 'quantity' }], 'field_twice');
    await refused([...mapping(), { index: 3, header: 'Same place', field: 'sku' }], 'column_twice');
    await refused([...mapping(), { index: 9, header: 'Return', field: 'returnStatus' }], 'return_without_status');
    // Lazada's file has a row per unit: a quantity does not stand for the line key.
    await refused(mapping(), 'no_line', 'lazada');
    expect(await stored()).toBe(before);
  });

  it('is refused for an agent and for the system, and stores nothing', async () => {
    const before = await stored();
    const body = { platform: 'shopee', headerRow: 1, columns: mapping([{ index: 9, header: 'Another', field: 'sku' }]), headerDigest: 'b'.repeat(64) };
    await expect(rt.execute('finance.marketplace.columns_confirm', body, { actor: { type: 'system', component: 'test' }, orgId })).rejects.toMatchObject({ status: 403 });
    // A real agent of the org with a live run: the call gets past the agent context and meets a refusal of the command's own, not a refusal of a made-up run.
    await expect(rt.execute('finance.marketplace.columns_confirm', body, { actor: agent, orgId })).rejects.toMatchObject({ status: 403 });
    expect(await stored()).toBe(before);
  });

  it('is refused for a member and a viewer of the org, which store nothing, and both still read the profile', async () => {
    const before = await stored();
    const body = { platform: 'shopee', headerRow: 1, columns: mapping([{ index: 12, header: 'Member tried', field: 'variation' }]), headerDigest: 'c'.repeat(64) };
    for (const who of [member, viewer]) {
      await expect(rt.execute('finance.marketplace.columns_confirm', body, { actor: asUser(who), orgId })).rejects.toMatchObject({ status: 403 });
    }
    expect(await stored()).toBe(before);
    // Every member reads the latest profile (a viewer included).
    const seen = await latest('shopee', viewer);
    expect(seen).not.toBeNull();
    expect((await latest('shopee', member))?.id).toBe(seen?.id);
  });

  it("keeps an org's profile to itself", async () => {
    expect(await latest('shopee', otherOwner, otherOrg)).toBeNull();
    const own = await confirm('shopee', mapping(), otherOwner, otherOrg);
    expect(own.added).toBe(true);
    expect((await latest('shopee', otherOwner, otherOrg))?.id).toBe(own.id);
    expect((await latest('shopee'))?.id).not.toBe(own.id);
    expect(await stored(otherOrg)).toBe(1);
  });

  it('does not carry a header text into the audit row of the command', async () => {
    await confirm('lazada', [{ index: 0, header: PLANTED_HEADER, field: 'orderNo' }, { index: 1, header: 'Order Item ID', field: 'lineKey' }]);
    const audit = await rows("SELECT detail::text AS detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace.columns_confirm'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((r) => String(r.detail).includes(PLANTED_HEADER))).toBe(false);
    // It is in the profile row itself, which is where it belongs.
    expect(await rows('SELECT 1 FROM crove_finance.marketplace_column_profile WHERE org_id = $1 AND columns::text LIKE $2', [orgId, `%${PLANTED_HEADER}%`])).toHaveLength(1);
  });

  it('keeps the shape in the table itself: no sample, no extra key, no field or column twice, bounded text', async () => {
    const insert = (columns: unknown, over: { platform?: string; digest?: string; row?: number } = {}) =>
      admin((c) =>
        c.query(
          'INSERT INTO crove_finance.marketplace_column_profile (org_id, platform, header_row, columns, header_digest) VALUES ($1, $2, $3, $4::jsonb, $5)',
          [orgId, over.platform ?? 'shopee', over.row ?? 1, JSON.stringify(columns), over.digest ?? DIGEST],
        ),
      );
    await expect(insert(mapping())).resolves.toBeDefined();
    await expect(insert([{ index: 0, header: 'Order ID', field: 'orderNo', sample: '9999' }, mapping()[1]])).rejects.toThrow(/check constraint/);
    await expect(insert([{ index: 0, header: 'Order ID', field: 'orderNo' }])).rejects.toThrow(/check constraint/);
    await expect(insert([...mapping(), { index: 9, header: 'Dup', field: 'quantity' }])).rejects.toThrow(/check constraint/);
    await expect(insert([...mapping(), { index: 3, header: 'Dup place', field: 'sku' }])).rejects.toThrow(/check constraint/);
    await expect(insert([...mapping(), { index: 9, header: 'x'.repeat(81), field: 'sku' }])).rejects.toThrow(/check constraint/);
    await expect(insert([...mapping(), { index: 9, header: 'Buyer', field: 'buyerName' }])).rejects.toThrow(/check constraint/);
    await expect(insert([...mapping(), 'a cell value'])).rejects.toThrow(/check constraint/);
    await expect(insert({ index: 0 })).rejects.toThrow(/check constraint/);
    await expect(insert(mapping(), { platform: 'amazon' })).rejects.toThrow(/check constraint/);
    await expect(insert(mapping(), { digest: 'xyz' })).rejects.toThrow(/check constraint/);
  });
});
