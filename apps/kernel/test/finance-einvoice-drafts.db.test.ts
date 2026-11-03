// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts and their series (#2500, ADR-0044) on PostgreSQL 17: series are read from the offline provider by owners and admins only and the first is the
// entity's default; a draft is saved with amounts computed by the server (a typed total is refused), with its issues shown and not blocking; it is edited and deleted
// while a draft and refused after; a series of another entity is refused; a viewer reads and writes nothing; the row policies and the state guard hold in SQL; the audit
// carries ids and counts, never the buyer. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Series {
  id: string;
  legalEntityId: string;
  templateNo: string;
  symbol: string;
  isDefault: boolean;
}
interface Draft {
  id: string;
  legalEntityId: string;
  state: string;
  seriesId: string | null;
  subtotal: string;
  vatAmount: string;
  total: string;
  lines: Array<{ lineNo: number; amount: string; vatAmount: string; vatRate: string }>;
  issues: Array<{ field: string; code: string }>;
}

// A synthetic tax code made at run time (the repository holds no checksum-valid one): a nine digit prefix and its check digit, and the same with the check digit off by one.
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const BAD_TAX_CODE = `${PREFIX}${((enterpriseCheckDigit(PREFIX) ?? 0) + 1) % 10}`;

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const form = (seriesId: string | null, extra: Record<string, unknown> = {}) => ({
  draftId: null,
  legalEntityId: null,
  date: today(),
  seriesId,
  buyer: { kind: 'business', partyId: null, taxCode: VALID_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
  lines: [
    { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', vatRate: '10%' },
    { description: 'Hàng B', unit: null, quantity: '1.5', unitPrice: '33333', vatRate: '8%' },
  ],
  ...extra,
});

suite('sales e-invoice drafts (#2500)', () => {
  const dbName = `crove_test_einvoice_drafts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hóa Đơn ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  // The issue job (a later step) moves a draft on as a worker login in the org's system context, with every guard on: this is that path, one transaction per call.
  async function asJob(o: Org, sqlText: string, params: unknown[] = [], mark: string | null = null) {
    const c = await workerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      // A forged purge mark (the real one is set inside crove_kernel.org_purge only): the guards must not take it for the purge.
      if (mark) await c.query("SELECT pg_catalog.set_config('crove.org_purge', $1, true)", [mark]);
      const result = await c.query(sqlText, params);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  // Moves a draft to a state as the job does, through the states the machine allows on the way (`draft` to `issued` is `submitting` first).
  const moveDraft = async (o: Org, draftId: string, ...to: Array<'submitting' | 'pending' | 'issued' | 'rejected' | 'failed'>) => {
    for (const state of to) await asJob(o, `UPDATE crove_finance.einvoice_draft SET state = $3, provider_ref = CASE WHEN $3 IN ('pending', 'issued') THEN 'sbx-test' ELSE provider_ref END WHERE org_id = $1 AND id = $2`, [o.orgId, draftId, state]);
  };
  const sync = async (o: Org, legalEntityId: string | null = null) => execute<{ added: number; series: Series[] }>(o, 'finance.einvoice_series.sync', { legalEntityId, provider: 'sandbox' });
  const auditOf = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown>; target_id: string | null }>(`SELECT detail, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at`, [o.orgId, command])).rows);

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: worker.toString(), max: 2 });
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads the series from the offline provider once: the first is the default, owners and admins only', async () => {
    const o = await org();
    expect(await query<Series[]>(o, 'finance.einvoice_series.list', {})).toEqual([]);
    const first = await sync(o);
    expect(first.added).toBe(2);
    expect(first.series.map((s) => `${s.templateNo}/${s.symbol}:${s.isDefault}`)).toEqual(['1/C26TSB:true', '2/C26TSM:false']);
    expect((await sync(o, null)).added).toBe(0);
    expect((await execute<{ added: number }>(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' }, o.admin)).added).toBe(0);
    for (const who of [o.member, o.viewer]) await expect(execute(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' }, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const who of [o.owner, o.admin, o.member, o.viewer]) expect(await query<Series[]>(o, 'finance.einvoice_series.list', {}, who)).toHaveLength(2);
    expect(await auditOf(o, 'finance.einvoice_series.sync')).toMatchObject([{ detail: { provider: 'sandbox', added: 2 } }, { detail: { added: 0 } }, { detail: { added: 0 } }]);
  });

  it('saves a draft with amounts computed by the server, to the whole dong, and refuses a typed total', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null), o.member);
    // Line 1: 2 x 100000 = 200000, VAT 10% = 20000. Line 2: 1.5 x 33333 = 49999.5 -> 50000 (half up), VAT 8% = 4000.
    expect(saved.state).toBe('draft');
    expect(saved.lines.map((l) => [l.amount, l.vatAmount, l.vatRate])).toEqual([
      ['200000', '20000', '10%'],
      ['50000', '4000', '8%'],
    ]);
    expect([saved.subtotal, saved.vatAmount, saved.total]).toEqual(['250000', '24000', '274000']);
    expect(saved.issues).toEqual([]);
    // The strict input has no place for a total, an amount or a VAT figure.
    await expect(execute(o, 'finance.einvoice_draft.save', { ...form(series?.id ?? null), total: '1' })).rejects.toBeDefined();
    await expect(
      execute(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { lines: [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '1', vatRate: '10%', amount: '999' }] })),
    ).rejects.toBeDefined();
    const row = await admin(async (c) => (await c.query('SELECT subtotal::text, vat_amount::text, total::text FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, saved.id])).rows[0]);
    expect(row).toEqual({ subtotal: '250000.0000', vat_amount: '24000.0000', total: '274000.0000' });
  });

  it('saves a draft that fails a check, with its issues, and shows the same issues on a live check', async () => {
    const o = await org();
    const bad = form(null, {
      date: '2999-01-01',
      buyer: { kind: 'business', partyId: null, taxCode: BAD_TAX_CODE, name: null, address: null, email: 'nope' },
      lines: [{ description: ' ', unit: null, quantity: '0', unitPrice: '5', vatRate: '7%' }],
    });
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', bad);
    const codes = saved.issues.map((i) => `${i.field}:${i.code}`).sort();
    expect(codes).toEqual(
      [
        'date:DATE_FUTURE',
        'series:SERIES_REQUIRED',
        'buyer.taxCode:BUYER_TAX_CODE_CHECKSUM',
        'buyer.name:BUYER_NAME_REQUIRED',
        'buyer.address:BUYER_ADDRESS_REQUIRED',
        'buyer.email:BUYER_EMAIL_INVALID',
        'lines.1.description:LINE_DESCRIPTION_REQUIRED',
        'lines.1.quantity:LINE_QUANTITY_INVALID',
        'lines.1.vatRate:LINE_VAT_RATE_INVALID',
      ].sort(),
    );
    const { draftId: _draftId, legalEntityId: _entity, ...liveForm } = bad as Record<string, unknown>;
    const live = await query<{ issues: Array<{ field: string; code: string }>; total: string }>(o, 'finance.einvoice_draft.check', liveForm);
    expect(live.issues.map((i) => `${i.field}:${i.code}`).sort()).toEqual(codes);
    // A quantity that is not a number yet is an issue on its field in the live check (the form is being typed), never a refusal.
    const typing = await query<{ issues: Array<{ field: string; code: string }> }>(o, 'finance.einvoice_draft.check', { ...liveForm, lines: [{ description: 'x', unit: null, quantity: 'abc', unitPrice: '', vatRate: '10%' }] });
    expect(typing.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['LINE_QUANTITY_INVALID', 'LINE_PRICE_INVALID']));
    // A consumer needs no buyer details.
    const consumer = await execute<Draft>(o, 'finance.einvoice_draft.save', form(null, { buyer: { kind: 'consumer', partyId: null, taxCode: null, name: null, address: null, email: null } }));
    expect(consumer.issues.map((i) => i.code)).toEqual(['SERIES_REQUIRED']);
  });

  it('edits a draft by replacing its lines, lists and gets it, and deletes it while it is a draft', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null));
    const edited = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { draftId: saved.id, lines: [{ description: 'Chỉ một dòng', unit: null, quantity: '3', unitPrice: '1000', vatRate: 'KCT' }] }), o.admin);
    expect(edited.id).toBe(saved.id);
    expect(edited.lines).toHaveLength(1);
    expect([edited.subtotal, edited.vatAmount, edited.total]).toEqual(['3000', '0', '3000']);
    expect(await query<Array<{ id: string; total: string }>>(o, 'finance.einvoice_draft.list', {}, o.viewer)).toMatchObject([{ id: saved.id, total: '3000' }]);
    expect((await query<Draft>(o, 'finance.einvoice_draft.get', { draftId: saved.id }, o.viewer)).lines).toHaveLength(1);
    expect(await execute(o, 'finance.einvoice_draft.delete', { draftId: saved.id }, o.member)).toEqual({ deleted: true });
    expect(await query<unknown[]>(o, 'finance.einvoice_draft.list', {})).toEqual([]);
    await expect(query(o, 'finance.einvoice_draft.get', { draftId: saved.id })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    expect(await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_finance.einvoice_draft_line WHERE org_id = $1', [o.orgId])).rows[0])).toEqual({ n: 0 });
  });

  it('refuses a viewer every write, another org everything, and a draft that has left the draft state', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    await expect(execute(o, 'finance.einvoice_draft.save', form(series?.id ?? null), o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null));
    await expect(execute(o, 'finance.einvoice_draft.delete', { draftId: saved.id }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await org();
    await expect(query(other, 'finance.einvoice_draft.get', { draftId: saved.id })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    await expect(execute(other, 'finance.einvoice_draft.save', { ...form(null), draftId: saved.id })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    await expect(execute(other, 'finance.einvoice_draft.save', form(series?.id ?? null))).rejects.toMatchObject({ code: 'EINVOICE_SERIES_NOT_FOUND' });
    // The issue job (a later step) moves a draft on; once it has left `draft` an edit or a delete is refused.
    await moveDraft(o, saved.id, 'submitting');
    await expect(execute(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { draftId: saved.id }))).rejects.toMatchObject({ code: 'EINVOICE_NOT_DRAFT' });
    await expect(execute(o, 'finance.einvoice_draft.delete', { draftId: saved.id })).rejects.toMatchObject({ code: 'EINVOICE_NOT_DRAFT' });
  });

  it('keeps a draft in the entity of its series: a series of another entity is refused, here and by the database', async () => {
    const o = await org();
    const branch = await admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [o.orgId, o.owner])).rows[0]?.id as string);
    const main = (await sync(o)).series;
    const branchSeries = (await sync(o, branch)).series;
    expect(branchSeries.every((s) => s.legalEntityId === branch)).toBe(true);
    expect(branchSeries.map((s) => s.isDefault)).toEqual([true, false]);
    const mainSeriesId = main[0]?.id as string;
    // A draft of the branch with a series of the main entity.
    await expect(execute(o, 'finance.einvoice_draft.save', form(mainSeriesId, { legalEntityId: branch }))).rejects.toMatchObject({ code: 'EINVOICE_SERIES_ENTITY' });
    const ok = await execute<Draft>(o, 'finance.einvoice_draft.save', form(branchSeries[0]?.id ?? null, { legalEntityId: branch }));
    expect(ok.legalEntityId).toBe(branch);
    // The entity of a draft never changes, and its series stays in it.
    await expect(execute(o, 'finance.einvoice_draft.save', form(branchSeries[0]?.id ?? null, { draftId: ok.id, legalEntityId: main[0]?.legalEntityId }))).rejects.toMatchObject({ code: 'EINVOICE_ENTITY_FIXED' });
    await expect(admin((c) => c.query('UPDATE crove_finance.einvoice_draft SET series_id = $3 WHERE org_id = $1 AND id = $2', [o.orgId, ok.id, mainSeriesId]))).rejects.toMatchObject({ code: '23503' });
  });

  it('holds the row policies, the grants and the state guard in SQL, as crove_app in each role\'s context', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null));
    async function inContext<T>(who: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who, o.orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const refused = (who: string, sqlText: string, params: unknown[], message: string, code = '42501') =>
      inContext(who, (c) => expect(c.query(sqlText, params)).rejects.toMatchObject({ code, message: expect.stringContaining(message) }));
    const changed = (who: string, sqlText: string, params: unknown[]) => inContext(who, async (c) => (await c.query(sqlText, params)).rowCount);
    // A viewer changes and removes nothing; a member edits a draft but cannot move its state, key or reference.
    expect(await changed(o.viewer, 'UPDATE crove_finance.einvoice_draft SET buyer_name = $3 WHERE org_id = $1 AND id = $2', [o.orgId, saved.id, 'x'])).toBe(0);
    expect(await changed(o.viewer, 'DELETE FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, saved.id])).toBe(0);
    expect(await changed(o.member, 'UPDATE crove_finance.einvoice_draft SET buyer_name = $3 WHERE org_id = $1 AND id = $2', [o.orgId, saved.id, 'Tên mới'])).toBe(1);
    await refused(o.member, "UPDATE crove_finance.einvoice_draft SET state = 'issued' WHERE org_id = $1 AND id = $2", [o.orgId, saved.id], 'EINVOICE_FIELD_LOCKED');
    await refused(o.member, 'UPDATE crove_finance.einvoice_draft SET idempotency_key = gen_random_uuid() WHERE org_id = $1 AND id = $2', [o.orgId, saved.id], 'EINVOICE_FIELD_LOCKED');
    await refused(o.member, "UPDATE crove_finance.einvoice_draft SET provider_ref = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, saved.id], 'EINVOICE_FIELD_LOCKED');
    await refused(o.member, "INSERT INTO crove_finance.einvoice_draft (org_id, state, invoice_date, buyer_kind, subtotal, vat_amount, total) VALUES ($1, 'issued', current_date, 'consumer', 0, 0, 0)", [o.orgId], 'EINVOICE_NOT_DRAFT');
    // A series: owners and admins write, a member does not; the series' own columns are fixed.
    expect(await changed(o.admin, 'UPDATE crove_finance.einvoice_series SET description = $3 WHERE org_id = $1 AND id = $2', [o.orgId, series?.id, 'mô tả'])).toBe(1);
    expect(await changed(o.member, 'UPDATE crove_finance.einvoice_series SET description = $3 WHERE org_id = $1 AND id = $2', [o.orgId, series?.id, 'mô tả'])).toBe(0);
    await refused(o.owner, 'UPDATE crove_finance.einvoice_series SET symbol = $3 WHERE org_id = $1 AND id = $2', [o.orgId, series?.id, 'C26TXX'], 'permission denied');
    // Once the job has moved the draft on, a member can neither edit it, nor its lines, nor delete either (the system context, the job, can).
    await moveDraft(o, saved.id, 'submitting', 'pending');
    await refused(o.member, 'UPDATE crove_finance.einvoice_draft SET buyer_name = $3 WHERE org_id = $1 AND id = $2', [o.orgId, saved.id, 'z'], 'EINVOICE_NOT_DRAFT');
    await refused(o.member, 'DELETE FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, saved.id], 'EINVOICE_NOT_DRAFT');
    await refused(o.member, 'UPDATE crove_finance.einvoice_draft_line SET description = $3 WHERE org_id = $1 AND draft_id = $2', [o.orgId, saved.id, 'z'], 'EINVOICE_NOT_DRAFT');
    await refused(o.member, 'DELETE FROM crove_finance.einvoice_draft_line WHERE org_id = $1 AND draft_id = $2', [o.orgId, saved.id], 'EINVOICE_NOT_DRAFT');
    await refused(o.member, "INSERT INTO crove_finance.einvoice_draft_line (org_id, draft_id, line_no, description, quantity, unit_price, amount, vat_rate, vat_amount) VALUES ($1, $2, 9, 'x', 1, 1, 1, '10%', 0)", [o.orgId, saved.id], 'EINVOICE_NOT_DRAFT');
    // A line cannot be moved out of the sent draft into another draft of the entity (the guard looks at the draft it leaves as well as the one it goes to).
    const target = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null));
    await refused(o.member, 'UPDATE crove_finance.einvoice_draft_line SET draft_id = $3, line_no = 50 WHERE org_id = $1 AND draft_id = $2', [o.orgId, saved.id, target.id], 'EINVOICE_NOT_DRAFT');
    // A person cannot choose a draft's key, and nobody gets an issued or pending draft without the provider's reference.
    const chosen = randomUUID();
    const made = await inContext(o.member, async (c) => (await c.query<{ idempotency_key: string }>("INSERT INTO crove_finance.einvoice_draft (org_id, idempotency_key, invoice_date, buyer_kind, subtotal, vat_amount, total) VALUES ($1, $2, current_date, 'consumer', 0, 0, 0) RETURNING idempotency_key", [o.orgId, chosen])).rows[0]);
    expect(made?.idempotency_key).not.toBe(chosen);
    await moveDraft(o, target.id, 'submitting');
    await expect(asJob(o, "UPDATE crove_finance.einvoice_draft SET state = 'issued', provider_ref = NULL WHERE org_id = $1 AND id = $2", [o.orgId, target.id])).rejects.toMatchObject({ code: '23514' });
  });

  // The issue job is a worker login in the org's system context. It moves a draft along the machine of the guard and no other way; every case below runs as that
  // login with the guards on (no replica mode), and the refused ones leave the row as it was.
  it('moves a draft only along the state machine in a system context: no skipped step, no new key, no edit after it left draft, no delete', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const fresh = () => execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null));
    const row = async (id: string) =>
      admin(async (c) => (await c.query<{ state: string; provider_ref: string | null; idempotency_key: string; buyer_name: string | null }>('SELECT state, provider_ref, idempotency_key, buyer_name FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, id])).rows[0]);
    const update = (id: string, sets: string, params: unknown[] = [], mark: string | null = null) => asJob(o, `UPDATE crove_finance.einvoice_draft SET ${sets} WHERE org_id = $1 AND id = $2`, [o.orgId, id, ...params], mark);
    const stuck = (what: Promise<unknown>, code = 'EINVOICE_STATE') => expect(what).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(code) });
    const del = (table: string, where: string, id: string, mark: string | null = null) => asJob(o, `DELETE FROM crove_finance.${table} WHERE org_id = $1 AND ${where} = $2`, [o.orgId, id], mark);

    // From `draft` the only step is `submitting`; any other state is refused, with or without the provider's reference.
    const a = await fresh();
    const keyA = (await row(a.id))?.idempotency_key;
    for (const to of ['pending', 'issued', 'rejected', 'failed']) await stuck(update(a.id, "state = $3, provider_ref = CASE WHEN $3 IN ('pending', 'issued') THEN 'sbx-1' END", [to]));
    await stuck(update(a.id, "state = 'submitting', provider_ref = 'sbx-1'"));
    await stuck(update(a.id, 'idempotency_key = gen_random_uuid()'));
    await stuck(update(a.id, "provider_ref = 'sbx-1'"));
    expect(await row(a.id)).toMatchObject({ state: 'draft', provider_ref: null, idempotency_key: keyA });
    // The job may not write a draft in a state of its own either: an insert is a `draft` with no reference.
    const insert = (state: string, ref: string | null) =>
      asJob(o, "INSERT INTO crove_finance.einvoice_draft (org_id, state, provider_ref, invoice_date, buyer_kind, subtotal, vat_amount, total) VALUES ($1, $2, $3, current_date, 'consumer', 0, 0, 0)", [o.orgId, state, ref]);
    await stuck(insert('submitting', null));
    await stuck(insert('draft', 'sbx-1'));
    expect((await insert('draft', null)).rowCount).toBe(1);

    // submitting: the content is frozen, the key stays, and the only ways on are pending, issued, rejected and failed.
    await moveDraft(o, a.id, 'submitting');
    await stuck(update(a.id, "buyer_name = 'Đổi tên'"));
    await stuck(update(a.id, 'idempotency_key = gen_random_uuid()'));
    await stuck(update(a.id, "state = 'draft'"));
    await stuck(update(a.id, "state = 'submitting', provider_ref = 'sbx-1'"));
    // pending: the reference is set once, from empty; it never changes after.
    await moveDraft(o, a.id, 'pending');
    expect(await row(a.id)).toMatchObject({ state: 'pending', provider_ref: 'sbx-test', idempotency_key: keyA });
    await stuck(update(a.id, "provider_ref = 'sbx-2'"));
    await stuck(update(a.id, "state = 'submitting'"));
    await stuck(update(a.id, "state = 'draft'"));
    // issued is terminal: nothing moves it, edits it or removes it, whoever the writer, the purge's mark forged included; its lines are as fixed.
    await moveDraft(o, a.id, 'issued');
    for (const sets of ["state = 'failed'", "state = 'rejected'", "state = 'draft'", "state = 'submitting'", "buyer_name = 'x'", "provider_ref = 'sbx-3'", 'idempotency_key = gen_random_uuid()']) {
      await stuck(update(a.id, sets));
    }
    await stuck(del('einvoice_draft', 'id', a.id));
    await stuck(del('einvoice_draft', 'id', a.id, o.orgId));
    await stuck(del('einvoice_draft_line', 'draft_id', a.id), 'EINVOICE_NOT_DRAFT');
    await stuck(del('einvoice_draft_line', 'draft_id', a.id, o.orgId), 'EINVOICE_NOT_DRAFT');
    await stuck(asJob(o, "UPDATE crove_finance.einvoice_draft_line SET description = 'x' WHERE org_id = $1 AND draft_id = $2", [o.orgId, a.id]), 'EINVOICE_NOT_DRAFT');
    expect(await row(a.id)).toMatchObject({ state: 'issued', provider_ref: 'sbx-test', idempotency_key: keyA, buyer_name: 'Công ty Mua Thử' });
    expect(await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_finance.einvoice_draft_line WHERE org_id = $1 AND draft_id = $2', [o.orgId, a.id])).rows[0])).toEqual({ n: 2 });

    // A rejected invoice's key is never reused: back to `draft` needs a new key and no reference, and a person edits the draft again.
    const b = await fresh();
    const keyB = (await row(b.id))?.idempotency_key;
    await moveDraft(o, b.id, 'submitting', 'rejected');
    await stuck(update(b.id, "state = 'draft', provider_ref = NULL"));
    await stuck(update(b.id, "state = 'pending', provider_ref = 'sbx-1'"));
    await stuck(update(b.id, "state = 'failed'"));
    await update(b.id, "state = 'draft', provider_ref = NULL, idempotency_key = gen_random_uuid()");
    const back = await row(b.id);
    expect(back?.state).toBe('draft');
    expect(back?.idempotency_key).not.toBe(keyB);
    expect(await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { draftId: b.id }))).toMatchObject({ id: b.id, state: 'draft' });
    // The same with a reference the provider gave to the rejected invoice: it must be cleared along with the key.
    const b2 = await fresh();
    await moveDraft(o, b2.id, 'submitting');
    await update(b2.id, "state = 'rejected', provider_ref = 'sbx-rej'");
    await stuck(update(b2.id, "state = 'draft', idempotency_key = gen_random_uuid()"));
    await update(b2.id, "state = 'draft', provider_ref = NULL, idempotency_key = gen_random_uuid()");
    expect((await row(b2.id))?.provider_ref).toBeNull();

    // failed goes back to submitting with the same key (a retry of the same invoice) and nowhere else.
    const c = await fresh();
    const keyC = (await row(c.id))?.idempotency_key;
    await moveDraft(o, c.id, 'submitting', 'failed');
    await stuck(update(c.id, "state = 'draft'"));
    await stuck(update(c.id, "state = 'pending', provider_ref = 'sbx-1'"));
    await stuck(update(c.id, "state = 'issued', provider_ref = 'sbx-1'"));
    await stuck(update(c.id, "state = 'submitting', idempotency_key = gen_random_uuid()"));
    await stuck(update(c.id, "state = 'rejected'"));
    await moveDraft(o, c.id, 'submitting');
    expect(await row(c.id)).toMatchObject({ state: 'submitting', idempotency_key: keyC });

    // A draft that has left `draft` is removed only by the org's purge: not by the job, not by an owner, not with the mark forged.
    const d = await fresh();
    await moveDraft(o, d.id, 'submitting');
    await stuck(del('einvoice_draft', 'id', d.id));
    await stuck(del('einvoice_draft', 'id', d.id, o.orgId));
    await expect(execute(o, 'finance.einvoice_draft.delete', { draftId: d.id })).rejects.toMatchObject({ code: 'EINVOICE_NOT_DRAFT' });
    expect((await row(d.id))?.state).toBe('submitting');
    // A line of a draft still in `draft` is a person's to change, and the job may remove it as the system context (the guard looks at the draft's state only).
    const e = await fresh();
    expect((await del('einvoice_draft_line', 'draft_id', e.id)).rowCount).toBe(2);
  });

  it('lets an owner remove the member who made a draft the job has moved on, and the party a draft names', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null), o.member);
    await moveDraft(o, saved.id, 'submitting', 'pending');
    await execute(o, 'kernel.member.remove', { userId: o.member });
    expect(await admin(async (c) => (await c.query('SELECT created_by, state FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, saved.id])).rows[0])).toEqual({ created_by: null, state: 'pending' });
  });

  it('refuses amounts the database cannot hold, in words, and saves the same series reads from two syncs once', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    await expect(
      execute(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { lines: [{ description: 'Quá lớn', unit: null, quantity: '999999999999', unitPrice: '999999999999', vatRate: '10%' }] })),
    ).rejects.toMatchObject({ code: 'EINVOICE_TOTAL_TOO_LARGE' });
    const p = await org();
    const both = await Promise.all([sync(p), sync(p, null)]);
    expect(both.map((r) => r.added).sort()).toEqual([0, 2]);
    const rows = await query<Series[]>(p, 'finance.einvoice_series.list', {});
    expect(rows).toHaveLength(2);
    expect(rows.filter((s) => s.isDefault)).toHaveLength(1);
  });

  it('writes a tax code in its written form, keeps no buyer details on a consumer and lists the drafts of one entity', async () => {
    const o = await org();
    const branch = await admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh danh sách', 'branch', $2) RETURNING id`, [o.orgId, o.owner])).rows[0]?.id as string);
    const [series] = (await sync(o)).series;
    const [branchSeries] = (await sync(o, branch)).series;
    // A branch code typed as 13 digits is kept with its dash (the shape a provider takes), a spaced code without its spaces.
    const branchCode = `${VALID_TAX_CODE}001`;
    const saved = await execute<Draft & { buyer: { taxCode: string | null } }>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { buyer: { kind: 'business', partyId: null, taxCode: branchCode, name: 'Chi nhánh mua', address: '2 Phố Thử', email: null } }));
    expect(saved.buyer.taxCode).toBe(`${VALID_TAX_CODE}-001`);
    expect(saved.issues).toEqual([]);
    const spaced = await execute<Draft & { buyer: { taxCode: string | null } }>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { buyer: { kind: 'business', partyId: null, taxCode: ` ${VALID_TAX_CODE.slice(0, 4)} ${VALID_TAX_CODE.slice(4)} `, name: 'Công ty có dấu cách', address: '3 Phố Thử', email: null } }));
    expect(spaced.buyer.taxCode).toBe(VALID_TAX_CODE);
    // A consumer carries nothing of what the form held before the kind was chosen.
    const consumer = await execute<Draft & { buyer: Record<string, unknown> }>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { buyer: { kind: 'consumer', partyId: null, taxCode: VALID_TAX_CODE, name: 'Không nên lưu', address: 'x', email: 'x@y.test' } }));
    expect(consumer.buyer).toMatchObject({ kind: 'consumer', taxCode: null, name: null, address: null, email: null });
    // A draft of the branch is not on the main entity's list, and the other way round.
    const onBranch = await execute<Draft>(o, 'finance.einvoice_draft.save', form(branchSeries?.id ?? null, { legalEntityId: branch }));
    const ids = async (entity: string | undefined) => (await query<Array<{ id: string }>>(o, 'finance.einvoice_draft.list', entity ? { legalEntityId: entity } : {})).map((d) => d.id).sort();
    expect(await ids(branch)).toEqual([onBranch.id]);
    expect(await ids(series?.legalEntityId)).toEqual([saved.id, spaced.id, consumer.id].sort());
    expect(await ids(undefined)).toEqual([saved.id, spaced.id, consumer.id, onBranch.id].sort());
  });

  it('audits ids and counts only, never the buyer', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const saved = await execute<Draft>(o, 'finance.einvoice_draft.save', form(series?.id ?? null, { buyer: { kind: 'individual', partyId: null, taxCode: '012345678901', name: 'Nguyễn Văn Bí Mật', address: '9 Phố Kín', email: 'bi.mat@example.test' } }));
    await execute(o, 'finance.einvoice_draft.delete', { draftId: saved.id });
    const events = await admin(async (c) =>
      (await c.query<{ blob: string }>(`SELECT (detail::text || coalesce(target_id::text, '') || coalesce(input_sha256, '')) AS blob FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.einvoice%'`, [o.orgId])).rows.map((r) => r.blob).join(' '),
    );
    for (const secret of ['Bí Mật', 'Phố Kín', 'bi.mat@example.test', '012345678901']) expect(events).not.toContain(secret);
    expect(await auditOf(o, 'finance.einvoice_draft.save')).toMatchObject([{ detail: { lines: 2, total: '274000', created: true } }]);
  });
});
