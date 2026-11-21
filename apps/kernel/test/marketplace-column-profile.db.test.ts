// SPDX-License-Identifier: AGPL-3.0-only
// The confirmed mapping of a marketplace report's columns (#4037) on PostgreSQL 17, through the runtime: a person saves the mapping of a PASSED check of a file (the full-check receipt: the file's check is
// done, has parsed lines and the header digest, and is for the same platform and mapping), the profile's headers, header row and digest come from what the worker recorded and not from the caller, the file's
// check row is deleted with it, the same mapping again adds nothing and a different one is a new row that wins, a mapping the header row refuses or a check that did not pass is never stored, an agent, the
// system, a member and a viewer cannot save, an org reads only its own profile, the table keeps the shape, and no header text reaches the audit row.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
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
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SYSTEM = { type: 'system' as const, component: 'finance.marketplace_columns' };
// The columns of a file as the worker records its sheet (shapes, a buyer column an empty shell). Columns 7 to 10 are what a hand-made sheet can hold that the sandbox would not let through: a buyer-looking
// header on a column not flagged, a header word of a field already used.
const COLUMNS = [
  { index: 0, header: 'Order ID', samples: ['9999'], buyer: false },
  { index: 1, header: '', samples: [], buyer: true },
  { index: 3, header: 'Quantity', samples: ['9'], buyer: false },
  { index: 5, header: 'Product', samples: ['aaaa'], buyer: false },
  { index: 6, header: 'Product name', samples: ['aaaa'], buyer: false },
  { index: 7, header: 'Buyer Name', samples: ['aaaa'], buyer: false },
  { index: 8, header: 'Qty again', samples: ['9'], buyer: false },
  { index: 9, header: 'Return', samples: ['aaaa'], buyer: false },
];
const SIGNED_SHEET = { headerRow: 1, headerDigest: DIGEST, columns: COLUMNS };
const PREVIEW = { lines: [{ rowNo: 2, orderNo: '9001', lineKey: 'Bút', sku: null, itemName: 'Bút', quantity: '2', amount: '100000', status: 'Hoàn thành' }], total: 1, skipped: 0 };
const ASSIGN = [
  { index: 0, field: 'orderNo' },
  { index: 3, field: 'quantity' },
  { index: 5, field: 'itemName' },
];
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
  const confirm = (fileId: string, platform: string, assignments: unknown, who = owner, org = orgId) =>
    rt.execute<{ id: string; added: boolean }>('finance.marketplace.columns_confirm', { fileId, platform, assignments }, { actor: asUser(who), orgId: org });
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

  // An org's own spreadsheet that no reader of the worker took, and the check a person asked for and the worker recorded as done (the sheet and the preview), as the screen leaves them.
  async function fileOf(org: string): Promise<string> {
    const id = randomUUID();
    const sha256 = randomBytes(32).toString('hex');
    await rows('INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [org, id, sha256, `org/${org}/${sha256}`, 'bao-cao.xlsx', XLSX, 1000, 'upload']);
    await rows("INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, 'unsupported', 'failed', NULL, '[]')", [org, id]);
    return id;
  }
  const requestedAt = async (fileId: string, org = orgId) => new Date((await rows('SELECT requested_at FROM crove_finance.marketplace_column_check WHERE org_id = $1 AND file_id = $2', [org, fileId]))[0]?.requested_at).toISOString();
  async function checked(
    assignments: unknown,
    opts: { platform?: string; sheet?: unknown; refusal?: string; noMapping?: boolean; noPreview?: boolean; org?: string; who?: string; record?: boolean } = {},
  ): Promise<string> {
    const org = opts.org ?? orgId;
    const fileId = await fileOf(org);
    await rt.execute('finance.marketplace.columns_check', { fileId, ...(opts.noMapping ? {} : { mapping: { platform: opts.platform ?? 'shopee', assignments } }) }, { actor: asUser(opts.who ?? owner), orgId: org });
    if (opts.record === false) return fileId;
    const sheet = opts.sheet === undefined ? SIGNED_SHEET : opts.sheet;
    const result = opts.refusal
      ? { state: 'done', sheet, refusal: opts.refusal, preview: null }
      : { state: 'done', sheet, refusal: null, preview: opts.noMapping || opts.noPreview ? null : PREVIEW };
    await worker.execute('finance.marketplace.columns_record', { fileId, requestedAt: await requestedAt(fileId, org), result }, { actor: SYSTEM, orgId: org });
    return fileId;
  }
  const checkRows = async (fileId: string) => Number((await rows('SELECT count(*) AS n FROM crove_finance.marketplace_column_check WHERE file_id = $1', [fileId]))[0]?.n);

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

  it('reads null until a person saves a passed check, then the mapping: the headers and the digest are the worker\'s, in the order of the header row', async () => {
    expect(await latest('shopee')).toBeNull();
    const fileId = await checked([...ASSIGN].reverse());
    const first = await confirm(fileId, 'shopee', ASSIGN);
    expect(first.added).toBe(true);
    const profile = await latest('shopee');
    expect(profile).toMatchObject({ id: first.id, headerRow: 1 });
    expect(profile?.columns).toEqual([
      { index: 0, header: 'Order ID', field: 'orderNo' },
      { index: 3, header: 'Quantity', field: 'quantity' },
      { index: 5, header: 'Product', field: 'itemName' },
    ]);
    expect((await rows('SELECT header_digest FROM crove_finance.marketplace_column_profile WHERE org_id = $1 AND id = $2', [orgId, first.id]))[0]?.header_digest).toBe(DIGEST);
    // The file's check row (its sheet and its preview lines, personal data) is gone with the decision.
    expect(await checkRows(fileId)).toBe(0);
    // Another platform of the same org has none.
    expect(await latest('tiktok_shop')).toBeNull();
  });

  it('adds nothing for the same mapping of the same header row again, and a different one is a new row that wins; either way the file\'s check row goes', async () => {
    // The mapping is saved here too (a no-op when an earlier case did it), so this case does not depend on the profile another one left.
    await confirm(await checked(ASSIGN), 'shopee', ASSIGN);
    const before = await stored();
    const same = await checked(ASSIGN);
    const again = await confirm(same, 'shopee', ASSIGN);
    expect(again.added).toBe(false);
    expect(await stored()).toBe(before);
    expect(await checkRows(same)).toBe(0);
    const other = await checked([...ASSIGN.slice(0, 2), { index: 6, field: 'itemName' }]);
    const changed = await confirm(other, 'shopee', [...ASSIGN.slice(0, 2), { index: 6, field: 'itemName' }]);
    expect(changed.added).toBe(true);
    expect(changed.id).not.toBe(again.id);
    expect(await stored()).toBe(before + 1);
    expect((await latest('shopee'))?.id).toBe(changed.id);
    expect(await checkRows(other)).toBe(0);
    // The earlier confirmation is still there, never edited.
    expect(await rows('SELECT 1 FROM crove_finance.marketplace_column_profile WHERE org_id = $1 AND id = $2', [orgId, again.id])).toHaveLength(1);
    // Another header row of the same mapping is another layout: a new row too.
    const moved = await checked(ASSIGN, { sheet: { ...SIGNED_SHEET, headerDigest: 'd'.repeat(64) } });
    expect((await confirm(moved, 'shopee', ASSIGN)).added).toBe(true);
  });

  it('refuses unless the file\'s check passed: no check, one still waiting, a refusal, a sheet alone, no parsed lines, no header digest', async () => {
    const before = await stored();
    const missing = await fileOf(orgId);
    await expect(confirm(missing, 'shopee', ASSIGN)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_NOT_FOUND', status: 404 });
    const notChecked = async (fileId: string, reason: string) => {
      await expect(confirm(fileId, 'shopee', ASSIGN)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_NOT_CHECKED', status: 409, details: { reason } });
      // The check row is kept: the person looks at it again.
      expect(await checkRows(fileId)).toBe(1);
    };
    await notChecked(await checked(ASSIGN, { record: false }), 'not_checked');
    await notChecked(await checked(ASSIGN, { refusal: 'nothing_read' }), 'not_checked');
    await notChecked(await checked(ASSIGN, { noMapping: true }), 'not_checked');
    await notChecked(await checked(ASSIGN, { noPreview: true }), 'not_checked');
    await notChecked(await checked(ASSIGN, { sheet: { headerRow: 1, columns: COLUMNS } }), 'no_digest');
    expect(await stored()).toBe(before);
  });

  it('refuses a mapping other than the one that was checked (the screen is out of date), and keeps the check', async () => {
    const before = await stored();
    const fileId = await checked(ASSIGN);
    const stale = (platform: string, assignments: unknown) => expect(confirm(fileId, platform, assignments)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_STALE', status: 409 });
    await stale('shopee', [...ASSIGN.slice(0, 2), { index: 6, field: 'itemName' }]);
    await stale('shopee', [...ASSIGN.slice(0, 2), { index: 5, field: 'sku' }]);
    await stale('shopee', ASSIGN.slice(0, 2));
    await stale('tiktok_shop', ASSIGN);
    expect(await checkRows(fileId)).toBe(1);
    expect(await stored()).toBe(before);
    // The checked one still saves.
    expect((await confirm(fileId, 'shopee', ASSIGN)).added).toBeDefined();
  });

  it('refuses an assignment to a buyer column or to a column the sheet does not show, whatever the check says', async () => {
    const before = await stored();
    for (const index of [1, 2, 40]) {
      const assignments = [...ASSIGN.slice(0, 2), { index, field: 'sku' }];
      const fileId = await checked(assignments);
      await expect(confirm(fileId, 'shopee', assignments)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_REFUSED', status: 422, details: { reason: 'bad_column' } });
      expect(await checkRows(fileId)).toBe(1);
    }
    expect(await stored()).toBe(before);
  });

  it('re-checks what the header row decides, by the refusal names of the full check, and stores nothing for it', async () => {
    const before = await stored();
    const refused = async (assignments: Array<{ index: number; field: string }>, reason: string, platform = 'shopee') => {
      const fileId = await checked(assignments, { platform });
      await expect(confirm(fileId, platform, assignments)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_REFUSED', status: 422, details: { reason } });
      expect(await checkRows(fileId)).toBe(1);
    };
    await refused([...ASSIGN.slice(0, 2), { index: 7, field: 'variation' }], 'buyer_column');
    await refused([ASSIGN[1]!, ASSIGN[2]!], 'no_order_no');
    await refused([ASSIGN[0]!, ASSIGN[2]!], 'no_line');
    await refused([...ASSIGN.slice(0, 2), { index: 8, field: 'quantity' }], 'field_twice');
    await refused([...ASSIGN.slice(0, 2), { index: 3, field: 'sku' }], 'column_twice');
    await refused([...ASSIGN.slice(0, 2), { index: 9, field: 'returnStatus' }], 'return_without_status');
    // Lazada's file has a row per unit: a quantity does not stand for the line key.
    await refused(ASSIGN.slice(0, 2), 'no_line', 'lazada');
    expect(await stored()).toBe(before);
  });

  it('is refused for an agent and for the system, and stores nothing', async () => {
    const before = await stored();
    const fileId = await checked(ASSIGN);
    const body = { fileId, platform: 'shopee', assignments: ASSIGN };
    await expect(rt.execute('finance.marketplace.columns_confirm', body, { actor: { type: 'system', component: 'test' }, orgId })).rejects.toMatchObject({ status: 403 });
    // A real agent of the org with a live run: the call gets past the agent context and meets a refusal of the command's own, not a refusal of a made-up run.
    await expect(rt.execute('finance.marketplace.columns_confirm', body, { actor: agent, orgId })).rejects.toMatchObject({ status: 403 });
    expect(await stored()).toBe(before);
    expect(await checkRows(fileId)).toBe(1);
  });

  it('is refused for a member and a viewer of the org, which store nothing and keep the check, and both still read the profile', async () => {
    // The owner's mapping is saved here too (a no-op when an earlier test did it), so the reads below do not depend on the profile another test left.
    await confirm(await checked(ASSIGN), 'shopee', ASSIGN);
    const before = await stored();
    const fileId = await checked(ASSIGN);
    for (const who of [member, viewer]) {
      await expect(confirm(fileId, 'shopee', ASSIGN, who)).rejects.toMatchObject({ status: 403 });
    }
    expect(await stored()).toBe(before);
    expect(await checkRows(fileId)).toBe(1);
    // Every member reads the latest profile (a viewer included).
    const seen = await latest('shopee', viewer);
    expect(seen).not.toBeNull();
    expect((await latest('shopee', member))?.id).toBe(seen?.id);
  });

  it("keeps an org's profile and its checks to itself", async () => {
    expect(await latest('shopee', otherOwner, otherOrg)).toBeNull();
    // The other org cannot save with this org's file: its check is not found there.
    const ours = await checked(ASSIGN);
    await expect(confirm(ours, 'shopee', ASSIGN, otherOwner, otherOrg)).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_NOT_FOUND', status: 404 });
    expect(await checkRows(ours)).toBe(1);
    const theirs = await checked(ASSIGN, { org: otherOrg, who: otherOwner });
    const own = await confirm(theirs, 'shopee', ASSIGN, otherOwner, otherOrg);
    expect(own.added).toBe(true);
    expect((await latest('shopee', otherOwner, otherOrg))?.id).toBe(own.id);
    expect((await latest('shopee'))?.id).not.toBe(own.id);
    expect(await stored(otherOrg)).toBe(1);
  });

  it('does not carry a header text into the audit row of the command, and not a preview line', async () => {
    const sheet = { ...SIGNED_SHEET, columns: COLUMNS.map((c) => (c.index === 5 ? { ...c, header: PLANTED_HEADER } : c)) };
    const lazada = await checked([...ASSIGN.slice(0, 1), { index: 5, field: 'lineKey' }], { platform: 'lazada', sheet });
    await confirm(lazada, 'lazada', [...ASSIGN.slice(0, 1), { index: 5, field: 'lineKey' }]);
    const audit = await rows("SELECT detail::text AS detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace.columns_confirm'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((r) => String(r.detail).includes(PLANTED_HEADER) || String(r.detail).includes('Bút'))).toBe(false);
    // The header text is in the profile row itself, which is where it belongs.
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
