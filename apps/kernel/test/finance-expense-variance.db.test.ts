// SPDX-License-Identifier: AGPL-3.0-only
// The expense variance of the Kế toán Tổng quan (#4392) on PostgreSQL 17: known entries are posted through the posting function and finance.expense_variance must flag exactly the lines that moved, on both
// regimes (an entity with no books row keeps TT133 and splits 64xx at 4 digits; an entity under TT99 keeps 641 and 642 as one line each), leave out revenue and the year-end closing entries, name the supplier or
// voucher behind each line, refuse a month that has not ended, give a member scoped to another entity the same refusal as the overview, never count another entity's postings, and write nothing.
// The rules themselves are unit-tested in modules/finance/test/expense-variance.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database (CI only: a run without it is skipped, not passed).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FinanceExpenseVariance, FinanceOverview } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// The month of the report: it and the three before it are long past, whatever day the suite runs.
const MONTH = '2026-07';

suite('expense variance of the Kế toán Tổng quan (#4392)', () => {
  const dbName = `crove_test_expense_variance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let rt: Runtime;
  let orgId = '';
  let owner = '';
  let member = '';
  let viewer = '';
  let main = '';
  let branch = '';
  let empty = '';
  let reversals = '';
  let supplierA = '';
  let supplierB = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  // One transaction as ludy_app in the owner's context, committed.
  async function asApp<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  // A balanced entry on two accounts of one entity: the expense side (debit) and the payable side (credit), with an optional supplier on the expense line and a description.
  const spend = (a: { entity: string; date: string; account: string; amount: string; party?: string; description?: string; sourceType?: string }) =>
    asApp(owner, (c) =>
      c
        .query<{ id: string }>(`SELECT ludy_finance.post_journal_entry($1::date, $2, $3, $4::uuid, $5::jsonb, NULL, 1, $6::uuid) AS id`, [
          a.date,
          a.description ?? 'Chi phí thử',
          a.sourceType ?? 'test.variance',
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: a.account, debit: a.amount, credit: '0', ...(a.party ? { party_id: a.party } : {}) },
            { line_no: 2, account_code: '331', debit: '0', credit: a.amount },
          ]),
          a.entity,
        ])
        .then((r) => r.rows[0]?.id as string),
    );
  // The reversal of an entry made by spend(): a new entry that names the original and mirrors its lines with the sides swapped (same line numbers, accounts and party), as the ledger demands.
  const reverse = (a: { entity: string; original: string; date: string; account: string; amount: string; party?: string }) =>
    asApp(owner, (c) =>
      c
        .query<{ id: string }>(`SELECT ludy_finance.post_journal_entry($1::date, 'Đảo chi phí thử', 'test.variance', $2::uuid, $3::jsonb, $4::uuid, 1, $5::uuid) AS id`, [
          a.date,
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: a.account, debit: '0', credit: a.amount, ...(a.party ? { party_id: a.party } : {}) },
            { line_no: 2, account_code: '331', debit: a.amount, credit: '0' },
          ]),
          a.original,
          a.entity,
        ])
        .then((r) => r.rows[0]?.id as string),
    );
  // Revenue, and a year-end style closing entry (a line on 911).
  const sale = (entity: string, date: string, amount: string) =>
    asApp(owner, (c) =>
      c.query(`SELECT ludy_finance.post_journal_entry($1::date, 'Doanh thu thử', 'test.variance', $2::uuid, $3::jsonb, NULL, 1, $4::uuid)`, [
        date,
        randomUUID(),
        JSON.stringify([
          { line_no: 1, account_code: '131', debit: amount, credit: '0' },
          { line_no: 2, account_code: '5111', debit: '0', credit: amount },
        ]),
        entity,
      ]),
    );
  const closing = (entity: string, date: string, account: string, amount: string) =>
    asApp(owner, (c) =>
      c.query(`SELECT ludy_finance.post_journal_entry($1::date, 'Kết chuyển thử', 'test.variance', $2::uuid, $3::jsonb, NULL, 1, $4::uuid)`, [
        date,
        randomUUID(),
        JSON.stringify([
          { line_no: 1, account_code: '911', debit: amount, credit: '0' },
          { line_no: 2, account_code: account, debit: '0', credit: amount },
        ]),
        entity,
      ]),
    );

  const variance = (input: { month?: string; legalEntityId?: string }, user = owner) =>
    rt.query<FinanceExpenseVariance>('finance.expense_variance', { month: MONTH, ...input }, { actor: asUser(user), orgId });
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
  const counts = () =>
    admin(async (a) => ({
      entries: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_entry')).rows[0]?.n,
      lines: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_line')).rows[0]?.n,
      audit: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_kernel.audit_event')).rows[0]?.n,
    }));

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
    appPool = new pg.Pool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    kyselyPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    const db = createDb(kyselyPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@expense-variance.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    viewer = await person('viewer');
    ({ orgId } = await createOrg(rt, asUser(owner), 'Biến động chi phí'));
    await admin(async (a) => {
      main = (await a.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      const entity = async (name: string) =>
        (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'company', $3) RETURNING id`, [orgId, name, owner])).rows[0]?.id as string;
      branch = await entity('Công ty con TT99');
      empty = await entity('Pháp nhân chưa có sổ');
      reversals = await entity('Pháp nhân có bút toán đảo');
      await a.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [orgId, member, viewer]);
      // The member reads the branch only.
      await a.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, member, branch, owner]);
      const party = async (name: string, taxCode: string) =>
        String((await a.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, $2, $3) RETURNING id`, [orgId, name, taxCode])).rows[0]?.id);
      supplierA = await party('Công ty A', '0101234564');
      supplierB = await party('Công ty B', '0301234567');
      // The branch keeps TT99 books for all of 2026, set before it has any entry.
      await a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2026-01-01')`, [orgId, branch]);
    });

    // The main entity (TT133, no books row: its chart has 6421 selling, 6422 administration and 635, 632, 811, 821, and no 641 or 6411 to 6418). 6422: 10,000,000 a month from supplier A; in July supplier B adds
    // 20,000,000. 6421 is steady at 3,000,000. 635 has 9,000,000 in July only (no supplier).
    // 632 is 40,000,000 a month and 10,000,000 in July, and a closing entry in July moves 10,000,000 of it to 911, which must not count. Revenue is posted in July and must not count either.
    for (const [month, day] of [['04', '10'], ['05', '10'], ['06', '10']] as const) {
      await spend({ entity: main, date: `2026-${month}-${day}`, account: '6422', amount: '10000000', party: supplierA });
      await spend({ entity: main, date: `2026-${month}-${day}`, account: '6421', amount: '3000000' });
      await spend({ entity: main, date: `2026-${month}-2${month === '06' ? '8' : '5'}`, account: '632', amount: '40000000', description: `Giá vốn ${month}` });
    }
    await spend({ entity: main, date: '2026-07-10', account: '6422', amount: '10000000', party: supplierA });
    await spend({ entity: main, date: '2026-07-12', account: '6422', amount: '20000000', party: supplierB });
    await spend({ entity: main, date: '2026-07-10', account: '6421', amount: '3000000' });
    await spend({ entity: main, date: '2026-07-15', account: '635', amount: '9000000', description: 'Chi phí mới' });
    await spend({ entity: main, date: '2026-07-20', account: '632', amount: '10000000', description: 'Giá vốn 07' });
    await closing(main, '2026-07-31', '632', '10000000');
    await sale(main, '2026-07-05', '100000000');

    // The branch (TT99): 6417 (a 641 account) and 6421 (a 642 account), 5,000,000 each a month; in July 6417 is 14,000,000.
    for (const date of ['2026-04-10', '2026-05-10', '2026-06-10']) {
      await spend({ entity: branch, date, account: '6417', amount: '5000000' });
      await spend({ entity: branch, date, account: '6421', amount: '5000000' });
    }
    await spend({ entity: branch, date: '2026-07-10', account: '6417', amount: '14000000', description: 'Dịch vụ mua ngoài' });
    await spend({ entity: branch, date: '2026-07-10', account: '6421', amount: '5000000' });

    // The entity of the reversals (TT133). Its books begin on 2026-04-01 with a small cost, so every month compared with is there. In July: a voucher of 8,000,000 on 6422; a voucher V1 of 50,000,000 on 6422
    // and its reversal R1 on 15 July (a pair that cancels inside the window); a voucher V2 of 6,000,000 on 811 on 25 July whose reversal R2 is dated 5 August (outside the window of July).
    await spend({ entity: reversals, date: '2026-04-01', account: '6421', amount: '1000' });
    await spend({ entity: reversals, date: '2026-07-08', account: '6422', amount: '8000000', description: 'Chi phí còn lại' });
    const v1 = await spend({ entity: reversals, date: '2026-07-10', account: '6422', amount: '50000000', description: 'Chi phí nhập nhầm' });
    await reverse({ entity: reversals, original: v1, date: '2026-07-15', account: '6422', amount: '50000000' });
    const v2 = await spend({ entity: reversals, date: '2026-07-25', account: '811', amount: '6000000', description: 'Chi phí khác sau đó đảo' });
    await reverse({ entity: reversals, original: v2, date: '2026-08-05', account: '811', amount: '6000000' });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('flags the lines that moved on a TT133 entity, largest change first, and leaves out revenue and the closing entry', async () => {
    const v = await variance({});
    expect(v).toMatchObject({ month: MONTH, legalEntityId: main, regime: 'tt133', chartVersion: '2026.1', booksStart: '2026-04-10', previousMonth: '2026-06', averageMonths: ['2026-04', '2026-05', '2026-06'], missing: { previous: false, average: false }, empty: false, moreFlagged: 0 });
    expect(v.thresholds).toEqual({ amount: '5000000', percent: '30' });
    // 632 fell by 30,000,000, 6422 rose by 20,000,000, 635 is new at 9,000,000; 6421 is steady and no revenue line is there.
    expect(v.lines.map((l) => l.code)).toEqual(['632', '6422', '635']);
    const [cost, staff, fresh] = v.lines;
    expect(cost).toMatchObject({ amount: '10000000', direction: 'down', against: 'previous', isNew: false });
    expect(cost?.previous).toEqual({ basis: '40000000', change: '-30000000', percent: '75.0', flagged: true });
    expect(cost?.average).toEqual({ basis: '40000000', change: '-30000000', percent: '75.0', flagged: true });
    expect(staff).toMatchObject({ amount: '30000000', direction: 'up', against: 'previous', isNew: false, vouchers: 2 });
    expect(staff?.previous).toEqual({ basis: '10000000', change: '20000000', percent: '200.0', flagged: true });
    expect(fresh).toMatchObject({ amount: '9000000', direction: 'up', isNew: true, vouchers: 1 });
    expect(fresh?.previous).toEqual({ basis: '0', change: '9000000', percent: null, flagged: true });
    // Names come from the TT133 chart.
    for (const line of v.lines) expect(typeof line.name, line.code).toBe('string');
  });

  it('names the supplier or the voucher behind each flagged line, measured against the basis that flagged it', async () => {
    const v = await variance({});
    const staff = v.lines.find((l) => l.code === '6422');
    // Supplier A paid the same as before (no change); supplier B is the whole rise.
    expect(staff?.contributors).toHaveLength(1);
    expect(staff?.contributors[0]).toMatchObject({ kind: 'supplier', partyId: supplierB, name: 'Công ty B', amount: '20000000', basis: '0', change: '20000000', vouchers: 1, entryId: null, description: null });
    // 635 has no supplier: the voucher itself, with the member's own description and its kind from the closed list.
    const fresh = v.lines.find((l) => l.code === '635');
    expect(fresh?.contributors).toHaveLength(1);
    expect(fresh?.contributors[0]).toMatchObject({ kind: 'voucher', partyId: null, name: null, entryDate: '2026-07-15', description: 'Chi phí mới', sourceKind: 'other', amount: '9000000', basis: '0', change: '9000000', vouchers: 1 });
    expect(fresh?.contributors[0]?.entryId).toEqual(expect.any(String));
    // 632 fell: the contributor is the voucher of last month that is not there again.
    const cost = v.lines.find((l) => l.code === '632');
    expect(cost?.contributors).toHaveLength(1);
    expect(cost?.contributors[0]).toMatchObject({ kind: 'voucher', amount: '0', basis: '40000000', change: '-40000000', vouchers: 0, description: 'Giá vốn 06' });
  });

  it('keeps 641 and 642 as one line each on a TT99 entity and counts nothing of the other entity', async () => {
    const v = await variance({ legalEntityId: branch });
    expect(v).toMatchObject({ legalEntityId: branch, regime: 'tt99', chartVersion: '2026.1', empty: false });
    expect(v.lines.map((l) => l.code)).toEqual(['641']);
    expect(v.lines[0]).toMatchObject({ amount: '14000000', direction: 'up', against: 'previous', isNew: false });
    expect(v.lines[0]?.previous).toEqual({ basis: '5000000', change: '9000000', percent: '180.0', flagged: true });
    expect(v.lines[0]?.name).toEqual(expect.any(String));
    expect(v.lines[0]?.contributors[0]).toMatchObject({ kind: 'voucher', description: 'Dịch vụ mua ngoài', amount: '14000000' });
    // The main entity's figures are its own: nothing of the branch is in them, and the other way round.
    const m = await variance({ legalEntityId: main });
    expect(m.lines.map((l) => l.code)).toEqual(['632', '6422', '635']);
  });

  it('does not count a month before the first entry as 0, and compares with what is there', async () => {
    // The main entity's first entry is 2026-04-10. For May the month before (April) is there, but the average reaches into February and March, which are not.
    const may = await variance({ month: '2026-05' });
    expect(may).toMatchObject({ booksStart: '2026-04-10', missing: { previous: false, average: true }, lines: [] });
    // For April the month before (March) is not there either.
    const april = await variance({ month: '2026-04' });
    expect(april).toMatchObject({ missing: { previous: true, average: true }, lines: [] });
    // A month a long time before the books: nothing at all to compare, and no entry in the window.
    expect(await variance({ month: '2026-01' })).toMatchObject({ empty: true, lines: [] });
  });

  it('leaves a pair that cancels out of the contributors and the voucher counts, and keeps a voucher whose reversal is in another month', async () => {
    const v = await variance({ legalEntityId: reversals });
    // 6422: V1 and its reversal net to 0 and are both inside the window, so the line is the one voucher of 8,000,000; 811: V2 stands, its reversal is dated in August.
    expect(v.lines.map((l) => l.code)).toEqual(['6422', '811']);
    const [admin6422, other811] = v.lines;
    expect(admin6422).toMatchObject({ amount: '8000000', vouchers: 1 });
    expect(admin6422?.contributors).toHaveLength(1);
    expect(admin6422?.contributors[0]).toMatchObject({ kind: 'voucher', description: 'Chi phí còn lại', amount: '8000000', vouchers: 1 });
    expect(other811).toMatchObject({ amount: '6000000', vouchers: 1, isNew: true });
    expect(other811?.contributors).toHaveLength(1);
    expect(other811?.contributors[0]).toMatchObject({ kind: 'voucher', description: 'Chi phí khác sau đó đảo', amount: '6000000' });
    // For August the entry (July) and its reversal (August) are both inside the window: the line falls by the reversal, and neither is a contributor nor counted.
    const august = await variance({ month: '2026-08', legalEntityId: reversals });
    const line811 = august.lines.find((l) => l.code === '811');
    expect(line811).toMatchObject({ amount: '-6000000', direction: 'down', vouchers: 0 });
    expect(line811?.contributors).toEqual([]);
  });

  it('reads an entity with no entry in the four months as empty, with no flagged line', async () => {
    const v = await variance({ legalEntityId: empty });
    expect(v).toMatchObject({ legalEntityId: empty, empty: true, booksStart: null, lines: [], moreFlagged: 0 });
  });

  it('refuses a month that has not ended', async () => {
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1);
    const future = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(await refusal(variance({ month: future }))).toMatchObject({ code: 'MONTH_NOT_ENDED', status: 422 });
    expect(await refusal(variance({ month: '2099-12' }))).toMatchObject({ code: 'MONTH_NOT_ENDED', status: 422 });
    // A month outside this century is not a month of any book: the input is refused before the read.
    expect(await refusal(variance({ month: '2999-01' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
    expect(await refusal(variance({ month: '1999-12' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
  });

  it('gives a member scoped to another entity the same refusal as the overview, and reads what the member may', async () => {
    const asked = await refusal(variance({ legalEntityId: main }, member));
    const overview = await refusal(rt.query<FinanceOverview>('finance.overview', { range: 'last_month', legalEntityId: main }, { actor: asUser(member), orgId }));
    expect(asked).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    expect(overview).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    expect(asked?.code).toBe(overview?.code);
    expect(asked?.status).toBe(overview?.status);
    // An entity that does not exist answers the same.
    expect(await refusal(variance({ legalEntityId: randomUUID() }, member))).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    // The entity the member may see is the one they get when they name none, and its figures are the branch's own.
    const own = await variance({}, member);
    expect(own.legalEntityId).toBe(branch);
    expect(own.lines.map((l) => l.code)).toEqual(['641']);
  });

  it('is open to a viewer, who reads the same figures', async () => {
    const asViewer = await variance({ legalEntityId: main }, viewer);
    expect(asViewer.lines.map((l) => l.code)).toEqual(['632', '6422', '635']);
  });

  it('writes nothing: no entry, no line, no audit row', async () => {
    const before = await counts();
    await variance({});
    await variance({ legalEntityId: branch });
    await variance({ legalEntityId: empty });
    expect(await counts()).toEqual(before);
  });
});
