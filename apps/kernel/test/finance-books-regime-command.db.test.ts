// SPDX-License-Identifier: AGPL-3.0-only
// Choosing Circular 99 for an entity's books (issue #1403, slice B1) on PostgreSQL 17, through the commands: only an owner chooses (R3, fresh second factor), an owner or an admin takes a choice back, a member and a
// viewer cannot, the date must be a 1 January from 2026 and the org's fiscal year must end in December, a repeat of the choice writes nothing, an entry on or after the date refuses it, a 31 December opening entry
// keeps that 1 January unavailable whether or not it was reversed (and the guard under it is not loosened), a choice for a year nobody has posted in is taken back, and the state says where each entity stands.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import type { BooksRegimeState } from '@ludy/kernel-contract';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('an owner chooses Circular 99 for an entity (#1403 slice B1)', () => {
  const dbName = `ludy_test_books_switch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let orgId = '';
  const who = { owner: '', admin: '', member: '', viewer: '' };
  const session = randomUUID();
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: session });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: session, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const newEntity = (name: string) =>
    admin(
      async (a) =>
        (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'company', $3) RETURNING id`, [orgId, name, who.owner])).rows[0]?.id as string,
    );
  const setRegime = (entity: string, effectiveFrom: string, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asMfa(who.owner), extra: Record<string, unknown> = {}) =>
    rt.execute<{ legalEntityId: string; regime: string; chartVersion: string; effectiveFrom: string }>(
      'finance.books.set_regime',
      { legalEntityId: entity, effectiveFrom, taxAuthorityNotified: true, ...extra },
      { actor, orgId, idempotencyKey: randomUUID() },
    );
  const cancel = (entity: string, effectiveFrom: string, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asMfa(who.admin)) =>
    rt.execute('finance.books.cancel_regime', { legalEntityId: entity, effectiveFrom }, { actor, orgId, idempotencyKey: randomUUID() });
  const detailOf = (id: string) => rt.query<{ payload: Record<string, unknown> | null }>('kernel.inbox.get', { id }, { actor: asUser(who.owner), orgId });
  const stateOf = async (entity: string) =>
    (await rt.query<BooksRegimeState>('finance.books.regime_state', {}, { actor: asUser(who.owner), orgId })).entities.find((e) => e.legalEntityId === entity);
  const rowsOf = (entity: string) =>
    admin(async (a) => (await a.query<{ regime: string; effective_from: string; created_by: string | null }>(`SELECT regime, effective_from::text AS effective_from, created_by FROM ludy_finance.legal_entity_books WHERE org_id = $1 AND legal_entity_id = $2 ORDER BY effective_from`, [orgId, entity])).rows);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number; details?: Record<string, unknown> });

  // An entry written as the superuser, with two balanced lines; reverses an entry when it names one (a mirror, on the date of the entry).
  async function entry(entity: string, date: string, sourceType: string, reverses: string | null = null): Promise<string> {
    return admin(async (c) => {
      await c.query('BEGIN');
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.journal_entry (org_id, legal_entity_id, entry_date, description, source_type, source_id, reverses_entry_id) VALUES ($1, $2, $3, 'Thử', $4, $5, $6) RETURNING id`,
          [orgId, entity, date, sourceType, randomUUID(), reverses],
        )
      ).rows[0]?.id as string;
      const [debit, credit] = reverses ? ['0', '500'] : ['500', '0'];
      await c.query(
        `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', $3, $4), ($1, $2, 2, '511', $4, $3)`,
        [orgId, id, debit, credit],
      );
      await c.query('COMMIT');
      return id;
    });
  }

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
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    for (const key of Object.keys(who) as Array<keyof typeof who>) {
      who[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@books-switch.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(who.owner), 'Công ty chọn Thông tư 99'));
    await admin((a) =>
      a.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, who.admin, who.member, who.viewer]),
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only an owner choose, with a fresh second factor, and says the tax authority was told', async () => {
    const entity = await newEntity('Chỉ chủ sở hữu chọn');
    for (const user of [who.admin, who.member, who.viewer]) {
      expect(await refusal(setRegime(entity, '2027-01-01', asMfa(user))), user).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    expect(await refusal(setRegime(entity, '2027-01-01', asUser(who.owner)))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await refusal(setRegime(entity, '2027-01-01', asMfa(who.owner), { taxAuthorityNotified: false }))).not.toBeNull();
    expect(await rowsOf(entity)).toEqual([]);
  });

  it('refuses a date that is not a 1 January, or is before 2026, and an org whose fiscal year does not end in December', async () => {
    const entity = await newEntity('Ngày không hợp lệ');
    for (const date of ['2027-07-01', '2027-01-02', '2025-01-01']) {
      expect(await refusal(setRegime(entity, date)), date).toMatchObject({ code: 'BOOKS_DATE_INVALID', status: 422 });
    }
    await admin((a) => a.query(`INSERT INTO ludy_kernel.tax_profile (org_id, fiscal_year_end_month, updated_by) VALUES ($1, 6, $2)`, [orgId, who.owner]));
    try {
      expect(await refusal(setRegime(entity, '2027-01-01'))).toMatchObject({ code: 'BOOKS_FISCAL_YEAR_UNSUPPORTED', status: 422 });
      expect((await stateOf(entity))?.blockers).toEqual([{ code: 'FISCAL_YEAR_UNSUPPORTED', fiscalYearEndMonth: 6 }]);
    } finally {
      await admin((a) => a.query(`DELETE FROM ludy_kernel.tax_profile WHERE org_id = $1`, [orgId]));
    }
    expect(await rowsOf(entity)).toEqual([]);
  });

  it('writes the row, keeps who chose it and the acknowledgement, answers a repeat without a second row, and takes the choice back', async () => {
    const entity = await newEntity('Chọn rồi hủy');
    expect(await setRegime(entity, '2040-01-01')).toEqual({ legalEntityId: entity, regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2040-01-01' });
    await setRegime(entity, '2040-01-01');
    expect(await rowsOf(entity)).toEqual([{ regime: 'tt99', effective_from: '2040-01-01', created_by: who.owner }]);
    expect(await stateOf(entity)).toMatchObject({ regime: 'tt133', since: null, scheduled: { effectiveFrom: '2040-01-01', cancellable: true }, nextSwitchDate: null, blockers: [{ code: 'ALREADY_TT99', effectiveFrom: '2040-01-01' }] });
    // The audit row keeps what was said, and the activity the choice.
    const audit = await admin(async (a) =>
      (await a.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.books.set_regime' AND outcome = 'ok' AND detail::text LIKE '%taxAuthorityNotified%' AND detail::text LIKE '%2040-01-01%'`, [orgId])).rows[0]?.n,
    );
    expect(Number(audit)).toBeGreaterThanOrEqual(1);
    // A member cannot take it back; an admin can, once.
    expect(await refusal(cancel(entity, '2040-01-01', asMfa(who.member)))).toMatchObject({ code: 'FORBIDDEN' });
    await cancel(entity, '2040-01-01');
    expect(await rowsOf(entity)).toEqual([]);
    expect(await refusal(cancel(entity, '2040-01-01'))).toMatchObject({ code: 'BOOKS_NOT_FOUND', status: 404 });
    expect(await stateOf(entity)).toMatchObject({ regime: 'tt133', scheduled: null, nextSwitchDate: '2026-01-01', blockers: [] });
  });

  it('refuses a date an entry falls on or after, offers the next 1 January, and takes no choice back once its year has an entry', async () => {
    const entity = await newEntity('Có bút toán');
    await entry(entity, '2041-02-01', 'test.sale');
    expect(await refusal(setRegime(entity, '2041-01-01'))).toMatchObject({ code: 'BOOKS_REGIME_IN_USE', status: 409 });
    expect(await stateOf(entity)).toMatchObject({ nextSwitchDate: '2042-01-01', blockers: [{ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2041-02-01', nextSwitchDate: '2042-01-01' }] });
    await setRegime(entity, '2042-01-01');
    expect(await refusal(setRegime(entity, '2043-01-01'))).toMatchObject({ code: 'BOOKS_ALREADY_TT99', status: 409 });
    // An entry in the year of a choice makes it final: the guard refuses to delete the row.
    await entry(entity, '2042-03-01', 'test.sale');
    expect(await refusal(cancel(entity, '2042-01-01'))).toMatchObject({ code: 'BOOKS_REGIME_IN_USE' });
    expect(await rowsOf(entity)).toHaveLength(1);
  });

  it('keeps 1 January unavailable behind a 31 December opening entry, reversed or not, and names the next free year', async () => {
    const entity = await newEntity('Số dư đầu kỳ 31/12');
    const opening = await entry(entity, '2040-12-31', 'finance.opening_balance');
    const blocked = await refusal(setRegime(entity, '2041-01-01'));
    expect(blocked).toMatchObject({ code: 'BOOKS_OPENING_ENTRY_BLOCKS', status: 409, details: { entryId: opening, entryDate: '2040-12-31', reversed: false, nextEffectiveFrom: '2042-01-01' } });
    // Reversing it (on its own date, as the app requires) does not free the date.
    await entry(entity, '2040-12-31', 'kernel.proposal', opening);
    expect(await refusal(setRegime(entity, '2041-01-01'))).toMatchObject({ code: 'BOOKS_OPENING_ENTRY_BLOCKS', details: { entryId: opening, reversed: true } });
    expect(await stateOf(entity)).toMatchObject({
      nextSwitchDate: '2042-01-01',
      blockers: [{ code: 'ENTRIES_ON_OR_AFTER' }, { code: 'OPENING_ENTRY_BLOCKS', entryId: opening, entryDate: '2040-12-31', reversed: true, nextSwitchDate: '2042-01-01' }],
    });
    expect(await rowsOf(entity)).toEqual([]);
    // The next year is free.
    await setRegime(entity, '2042-01-01');
    expect(await rowsOf(entity)).toHaveLength(1);
  });

  it('holds the switch while a posting proposal dated on or after it waits for approval, or carries no date, and lets one dated before it be', async () => {
    const proposal = (entity: string, payload: Record<string, unknown>) =>
      admin(
        async (a) =>
          (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.proposal (org_id, kind, command, title, payload, legal_entity_id) VALUES ($1, 'finance.cash_voucher', 'finance.voucher.record', 'Phiếu thử', $2::jsonb, $3) RETURNING id`, [orgId, JSON.stringify(payload), entity])).rows[0]?.id as string,
      );
    const dated = await newEntity('Đề xuất đề ngày sau');
    const waiting = await proposal(dated, { date: '2041-03-01' });
    expect(await refusal(setRegime(dated, '2041-01-01'))).toMatchObject({ code: 'BOOKS_PENDING_PROPOSALS', status: 409, details: { proposalIds: [waiting] } });
    expect(await rowsOf(dated)).toEqual([]);
    // The state says so before the owner tries, instead of offering the date.
    expect((await stateOf(dated))?.blockers).toEqual([{ code: 'PENDING_PROPOSALS', proposalIds: [waiting], nextSwitchDate: '2026-01-01' }]);
    const undated = await newEntity('Đề xuất không có ngày');
    await proposal(undated, {});
    expect(await refusal(setRegime(undated, '2041-01-01'))).toMatchObject({ code: 'BOOKS_PENDING_PROPOSALS' });
    const before = await newEntity('Đề xuất đề ngày trước');
    await proposal(before, { date: '2040-06-01' });
    await setRegime(before, '2041-01-01');
    expect(await rowsOf(before)).toHaveLength(1);
  });

  // A journal voucher asked for by a member, approved by the owner (four-eyes, fresh MFA): the two steps a switch of books can come between.
  const askVoucher = async (entity: string, date: string) => {
    const { proposalId } = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      {
        command: 'finance.journal_voucher.record',
        input: { date, description: 'Trích trước chi phí', lines: [{ account: '6422', debit: '450000', credit: '0' }, { account: '3388', debit: '0', credit: '450000' }], legalEntityId: entity },
      },
      { actor: asUser(who.member), orgId, idempotencyKey: randomUUID() },
    );
    return proposalId;
  };
  const approveVoucher = async (proposalId: string) => {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(who.owner), orgId });
    return rt.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(who.owner), orgId });
  };

  it('refuses a voucher prepared under TT133 and approved after the entity switched, and one prepared under TT99 and approved after the choice was taken back', async () => {
    // The switch is written as the superuser, as it would be by one that commits in the instant after a voucher was prepared (the function itself holds the switch while a proposal waits).
    const before = await newEntity('Phiếu lập trước khi chuyển');
    const early = await askVoucher(before, '2041-03-01');
    await admin((a) => a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2041-01-01')`, [orgId, before]));
    expect(await refusal(approveVoucher(early))).toMatchObject({ code: 'BOOKS_REGIME_CHANGED', status: 409 });

    const after = await newEntity('Phiếu lập khi đã chuyển');
    await setRegime(after, '2041-01-01');
    const late = await askVoucher(after, '2041-03-01');
    expect((await detailOf(late)).payload).toMatchObject({ regime: 'tt99', chartVersion: '2026.1' });
    await admin((a) => a.query(`DELETE FROM ludy_finance.legal_entity_books WHERE org_id = $1 AND legal_entity_id = $2`, [orgId, after]));
    expect(await refusal(approveVoucher(late))).toMatchObject({ code: 'BOOKS_REGIME_CHANGED', status: 409 });
  });

  it('refuses to take a choice back while a posting proposal is dated from it on', async () => {
    const entity = await newEntity('Hủy khi còn phiếu chờ');
    await setRegime(entity, '2041-01-01');
    const waiting = await askVoucher(entity, '2041-05-01');
    expect(await refusal(cancel(entity, '2041-01-01'))).toMatchObject({ code: 'BOOKS_PENDING_PROPOSALS', status: 409, details: { proposalIds: [waiting] } });
    expect(await rowsOf(entity)).toHaveLength(1);
  });

  it('keeps the books an asset was registered under, so a switch added later holds its depreciation back', async () => {
    const entity = await newEntity('Tài sản đăng ký trước khi chuyển');
    await rt.execute(
      'finance.fixed_asset.create',
      { kind: 'prepaid_cost', name: 'Bản quyền phần mềm', cost: '12000000', assetAccount: '242', expenseAccount: '6421', startMonth: '2041-02', months: 12, legalEntityId: entity },
      { actor: asUser(who.owner), orgId },
    );
    const stored = await admin(async (a) => (await a.query<{ regime: string; chart_version: string }>(`SELECT regime, chart_version FROM ludy_finance.fixed_asset WHERE org_id = $1 AND legal_entity_id = $2`, [orgId, entity])).rows);
    expect(stored).toEqual([{ regime: 'tt133', chart_version: '2026.1' }]);
    // The switch starts before the asset's first month, after it was registered: no entry is under it, so it is accepted.
    await setRegime(entity, '2041-01-01');
    const request = (month: string) =>
      rt.execute('kernel.proposal.request', { command: 'finance.depreciation.record', input: { month, legalEntityId: entity } }, { actor: asUser(who.owner), orgId, idempotencyKey: randomUUID() });
    expect(await refusal(request('2041-02'))).toMatchObject({ code: 'DEPRECIATION_BOOKS_CHANGED', status: 409 });
  });

  it('keeps the books table closed to every login role: no one writes it but through the two functions', async () => {
    const entity = await newEntity('Không ghi trực tiếp');
    const write = (sql: string) =>
      new Promise<string>((resolve) => {
        const url = new URL(adminUrl);
        url.username = 'ludy_app';
        url.password = 'test-app-pw';
        const client = new pg.Client({ connectionString: url.toString() });
        client
          .connect()
          .then(() => client.query(sql, [orgId, entity]))
          .then(() => resolve('ok'), (error: { code?: string }) => resolve(error.code ?? '?'))
          .finally(() => void client.end());
      });
    expect(await write(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2027-01-01')`)).toBe('42501');
    expect(await write(`DELETE FROM ludy_finance.legal_entity_books WHERE org_id = $1 AND legal_entity_id = $2`)).toBe('42501');
  });
});
