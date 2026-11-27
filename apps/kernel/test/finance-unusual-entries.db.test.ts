// SPDX-License-Identifier: AGPL-3.0-only
// The monthly review of unusual posted entries (#5182) on PostgreSQL 17: known entries are written into the books and finance.unusual_entries must find exactly the entries each rule is meant to find, on both regimes
// (TT133 groups 64xx at 4 digits, TT99 at 3), at the edges of every threshold (the minimum history, the factor, the 5,000,000 floor, the spread, the 24-month window, the ranges of days off), leave out a reversed pair
// (both orders, and a reversal dated after the month) and the closing entries (911) on both regimes, never count another entity or org, rank and cap in SQL, keep reviewed hits out of the list and count them, give the
// same list with a few hundred more history rows in ONE statement, and write nothing; finance.unusual_entries.review marks a hit once (idempotent), audited, refused for a viewer and for an entry of another entity,
// and touches no ledger table. The pure parts are unit-tested in modules/finance/test/unusual-entries.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database (CI only: a run without it is skipped, not passed).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FinanceUnusualEntries, FinanceUnusualEntryReviewOutput } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// The month of the review: it and the six months before it are long past, whatever day the suite runs. July 2026 starts on a Wednesday (the 4th and 5th are a weekend, the 6th a Monday); it has no public holiday.
const MONTH = '2026-07';
// Seven earlier entries of a steady supplier: six months of history, all on a working day.
const SEVEN = ['2026-01-12', '2026-02-12', '2026-03-12', '2026-04-14', '2026-05-12', '2026-06-12', '2026-06-22'] as const;

interface Line {
  account: string;
  debit?: string;
  credit?: string;
  party?: string;
}
interface Raw {
  entity: string;
  date: string;
  description: string;
  lines: Line[];
  sourceType?: string;
  sourceId?: string;
  reverses?: string;
}

suite('monthly review of unusual entries (#5182)', () => {
  const dbName = `ludy_test_unusual_entries_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let kyselyPool: pg.Pool;
  let rt: Runtime;
  let orgId = '';
  let owner = '';
  let member = '';
  let viewer = '';
  // The entities: main is the org's default (TT133, no books row).
  let main = '';
  let reversals = '';
  let closings = '';
  let controls = '';
  let accounts = '';
  let kinds10 = '';
  let kinds9 = '';
  let offDays = '';
  let dups = '';
  let tt99 = '';
  let switched = '';
  let capped = '';
  let plain = '';
  let padded = '';
  let nothing = '';
  const seen: string[] = [];
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

  // An entry of one entity written by the database owner with triggers off (the posting function's checks are not what is under test), with its lines. A reversal names the entry it mirrors.
  async function rawIn(c: pg.Client, a: Raw): Promise<string> {
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2::date, $3, $4, $5::uuid, $6::uuid, $7::uuid) RETURNING id`,
        [orgId, a.date, a.description, a.sourceType ?? 'test.review', a.sourceId ?? randomUUID(), a.entity, a.reverses ?? null],
      )
    ).rows[0]?.id as string;
    for (const [i, l] of a.lines.entries()) {
      await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        orgId,
        id,
        i + 1,
        l.account,
        l.debit ?? '0',
        l.credit ?? '0',
        l.party ?? null,
        a.entity,
      ]);
    }
    return id;
  }
  const raw = (a: Raw) =>
    admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      return rawIn(c, a);
    });
  // A cost on an account with a supplier, against the payable.
  const spend = (a: { entity: string; date: string; account: string; amount: string; party?: string; description?: string; sourceType?: string }) =>
    raw({
      entity: a.entity,
      date: a.date,
      description: a.description ?? 'H',
      ...(a.sourceType ? { sourceType: a.sourceType } : {}),
      // As an invoice posts it (record.ts): the party is on the payable line only, the cost line has none.
      lines: [{ account: a.account, debit: a.amount }, { account: '331', credit: a.amount, ...(a.party ? { party: a.party } : {}) }],
    });
  // The reversal of an entry made by spend(): a new entry that names the original and mirrors its lines with the sides swapped.
  const unspend = (a: { entity: string; original: string; date: string; account: string; amount: string; party?: string }) =>
    raw({
      entity: a.entity,
      date: a.date,
      description: 'Đảo',
      reverses: a.original,
      lines: [{ account: a.account, credit: a.amount }, { account: '331', debit: a.amount, ...(a.party ? { party: a.party } : {}) }],
    });
  // A supplier with a steady history: one entry per date.
  const history = async (entity: string, party: string, account: string, amounts: readonly string[] | string, dates: readonly string[] = SEVEN) => {
    for (const [i, date] of dates.entries()) await spend({ entity, date, account, amount: typeof amounts === 'string' ? amounts : (amounts[i] as string), party });
  };
  // A journal voucher a person typed (or, with closingYear, the year-end one) with its entry: the voucher in normal mode (it is numbered by its trigger), then the entry and lines with triggers off.
  const voucher = (a: { entity: string; date: string; description: string; lines: Line[]; closingYear?: number }) =>
    admin(async (c) => {
      await c.query('BEGIN');
      try {
        const v = (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_finance.journal_voucher (org_id, voucher_date, description, legal_entity_id, closing_year) VALUES ($1, $2::date, $3, $4::uuid, $5) RETURNING id`,
            [orgId, a.date, a.description, a.entity, a.closingYear ?? null],
          )
        ).rows[0] as { id: string };
        await c.query('SET LOCAL session_replication_role = replica');
        await rawIn(c, { entity: a.entity, date: a.date, description: a.description, lines: a.lines, sourceType: 'finance.journal_voucher', sourceId: v.id });
        await c.query('COMMIT');
        return v.id;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });
  // A purchase document with its entry, in the books of one entity.
  const invoice = (a: { entity: string; party: string; series: string; number: string; total: string; date: string; replaces?: string }) =>
    admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const doc = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.purchase_document (org_id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, replaces_document_id)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, 0, $7, 'purchase', $8) RETURNING id`,
          [orgId, a.entity, a.party, a.series, a.number, a.date, a.total, a.replaces ?? null],
        )
      ).rows[0] as { id: string };
      const entry = await rawIn(c, {
        entity: a.entity,
        date: a.date,
        description: `HD ${a.series}/${a.number}`,
        sourceType: 'finance.purchase_document',
        sourceId: doc.id,
        lines: [{ account: '6422', debit: a.total }, { account: '331', credit: a.total, party: a.party }],
      });
      return { document: doc.id, entry };
    });
  const party = (name: string) =>
    admin(async (c) => String((await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name) VALUES ($1, $2) RETURNING id`, [orgId, name])).rows[0]?.id));
  const entity = (name: string) =>
    admin(async (c) => String((await c.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'company', $3) RETURNING id`, [orgId, name, owner])).rows[0]?.id));

  const review = (input: { month?: string; legalEntityId?: string }, user = owner) =>
    rt.query<FinanceUnusualEntries>('finance.unusual_entries', { month: MONTH, ...input }, { actor: asUser(user), orgId });
  const mark = (input: { entryId: string; rule: string; legalEntityId?: string }, user = owner) =>
    rt.execute<FinanceUnusualEntryReviewOutput>('finance.unusual_entries.review', input, { actor: asUser(user), orgId });
  const handles = (r: FinanceUnusualEntries) => r.hits.map((h) => `${h.rule}:${h.description}`);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
  const counts = () =>
    admin(async (a) => ({
      entries: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_entry')).rows[0]?.n,
      lines: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_line')).rows[0]?.n,
      marks: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.entry_review_mark')).rows[0]?.n,
      audit: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_kernel.audit_event')).rows[0]?.n,
    }));
  // Every statement the review sends is recorded, to show it reads in one.
  function tap(pool: pg.Pool) {
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const slot = client as unknown as { query: (...args: unknown[]) => unknown; tapped?: boolean };
      if (!slot.tapped) {
        const original = slot.query.bind(client);
        slot.query = (...args: unknown[]) => {
          const first = args[0];
          seen.push(typeof first === 'string' ? first : String((first as { text?: string } | undefined)?.text ?? ''));
          return original(...args);
        };
        slot.tapped = true;
      }
      return client;
    };
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
    kyselyPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    tap(kyselyPool);
    const db = createDb(kyselyPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@unusual-entries.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    viewer = await person('viewer');
    ({ orgId } = await createOrg(rt, asUser(owner), 'Rà soát bút toán'));
    main = await admin(async (a) => String((await a.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id));
    reversals = await entity('Bút toán đảo');
    closings = await entity('Bút toán kết chuyển');
    controls = await entity('Tài khoản công nợ');
    accounts = await entity('Tài khoản mới');
    kinds10 = await entity('Loại chứng từ 10');
    kinds9 = await entity('Loại chứng từ 9');
    offDays = await entity('Ngày nghỉ');
    dups = await entity('Hóa đơn lặp');
    tt99 = await entity('Công ty TT99');
    switched = await entity('Công ty đổi sổ');
    capped = await entity('Giới hạn');
    plain = await entity('Ít dữ liệu');
    padded = await entity('Nhiều dữ liệu');
    nothing = await entity('Chưa có sổ');
    await admin(async (a) => {
      await a.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [orgId, member, viewer]);
      // The member reads the TT99 entity only.
      await a.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, member, tt99, owner]);
      // The TT99 entity keeps TT99 books for all of 2026; the switching one from the start of May.
      await a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2026-01-01'), ($1, $3, 'tt99', '2026.1', '2026-05-01')`, [orgId, tt99, switched]);
    });
  }, 180_000);

  afterAll(async () => {
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('amount_outlier on a TT133 entity', () => {
    beforeAll(async () => {
      const [high, low, five, six, floor, floorOk, below, at, madPass, madBlock, steady] = await Promise.all(
        ['Nhà cung cấp cao', 'Nhà cung cấp thấp', 'Năm lần', 'Sáu lần', 'Dưới sàn', 'Đúng sàn', 'Dưới hệ số', 'Đúng hệ số', 'Biên độ nhỏ', 'Biên độ rộng', 'Đều đặn'].map(party),
      ) as [string, string, string, string, string, string, string, string, string, string, string];
      await history(main, high, '6422', '10000000');
      await history(main, low, '6421', '30000000');
      await history(main, five, '6422', '10000000', SEVEN.slice(0, 5));
      await history(main, six, '6422', '10000000', SEVEN.slice(0, 6));
      await history(main, floor, '6422', '1000000');
      await history(main, floorOk, '6422', '1000000');
      await history(main, below, '6422', '10000000');
      await history(main, at, '6422', '10000000');
      await history(main, madPass, '6422', ['8000000', '9000000', '10000000', '11000000', '12000000', '10000000', '10000000']);
      await history(main, madBlock, '6422', ['1000000', '2000000', '3000000', '10000000', '30000000', '40000000', '100000000']);
      await history(main, steady, '6422', '10000000');
      const july = (description: string, p: string, account: string, amount: string, date: string) => spend({ entity: main, date, account, amount, party: p, description });
      await july('cao', high, '6422', '50000000', '2026-07-14');
      await july('thấp', low, '6421', '8000000', '2026-07-15');
      await july('năm', five, '6422', '50000000', '2026-07-16');
      await july('sáu', six, '6422', '49000000', '2026-07-17');
      await july('dưới sàn', floor, '6422', '4000000', '2026-07-20');
      await july('đúng sàn', floorOk, '6422', '6000000', '2026-07-21');
      await july('dưới hệ số', below, '6422', '29999999', '2026-07-22');
      await july('đúng hệ số', at, '6422', '30000000', '2026-07-23');
      await july('biên độ nhỏ', madPass, '6422', '31000000', '2026-07-24');
      await july('biên độ rộng', madBlock, '6422', '31000000', '2026-07-27');
      await july('đều đặn', steady, '6422', '11000000', '2026-07-28');
    });

    it('flags exactly the amounts outside the usual range, ranked by size, and none at the edges that fall short', async () => {
      const r = await review({});
      expect(r).toMatchObject({ month: MONTH, legalEntityId: main, regime: 'tt133', chartVersion: '2026.1', historyFrom: '2026-01-01', empty: false, moreHits: 0, reviewed: 0 });
      expect(r.thresholds).toEqual({ amountFactor: 3, amountMinDiff: '5000000', madFactor: 5, historyMonths: 6, minHistory: 6, offDayMinAmount: '5000000' });
      // 50,000,000 and 49,000,000 against 10,000,000; 31,000,000 inside a narrow spread; exactly 3 times; 8,000,000 against 30,000,000; exactly the 5,000,000 floor.
      // Left out: 5 earlier entries only, a difference under the floor, one dong under 3 times, a spread too wide, a steady supplier.
      expect(handles(r)).toEqual(['amount_outlier:cao', 'amount_outlier:sáu', 'amount_outlier:biên độ nhỏ', 'amount_outlier:đúng hệ số', 'amount_outlier:thấp', 'amount_outlier:đúng sàn']);
      const [high, six, spreadOk, atFactor, low, atFloor] = r.hits;
      expect(high).toMatchObject({
        rule: 'amount_outlier',
        entryDate: '2026-07-14',
        sourceKind: 'other',
        amount: '50000000',
        partyName: 'Nhà cung cấp cao',
        accountCode: '6422',
        groupAmount: '50000000',
        usual: '10000000',
        historyCount: 7,
        ratio: '5.0',
        direction: 'high',
        basis: null,
        day: null,
        control: null,
        invoiceNumber: null,
        otherEntryId: null,
      });
      expect(high?.accountName).toEqual(expect.any(String));
      expect(six).toMatchObject({ historyCount: 6, usual: '10000000', ratio: '4.9' });
      expect(spreadOk).toMatchObject({ usual: '10000000', ratio: '3.1', direction: 'high' });
      expect(atFactor).toMatchObject({ amount: '30000000', ratio: '3.0' });
      // Below the usual range: 8,000,000 against 30,000,000 on the 4-digit line 6421.
      expect(low).toMatchObject({ accountCode: '6421', usual: '30000000', ratio: '0.3', direction: 'low', amount: '8000000' });
      expect(atFloor).toMatchObject({ amount: '6000000', usual: '1000000', ratio: '6.0' });
      // Every hit names the rule only once for an entry and carries its own ids.
      expect(new Set(r.hits.map((h) => h.entryId)).size).toBe(r.hits.length);
    });
  });

  describe('a reversed pair and the closing entries (911)', () => {
    beforeAll(async () => {
      const [rev, pair, close] = (await Promise.all(['Có bút toán đảo', 'Cặp bút toán', 'Kết chuyển'].map(party))) as [string, string, string];
      // rev: 5 steady entries and a 100,000,000 one in April that was reversed on 12 July. Without the pair there are only 5 earlier entries, so July's 50,000,000 is judged by nothing; with it counted there would be 6.
      await history(reversals, rev, '6422', '10000000', SEVEN.slice(0, 5));
      const april = await spend({ entity: reversals, date: '2026-04-20', account: '6422', amount: '100000000', party: rev, description: 'gốc' });
      await unspend({ entity: reversals, original: april, date: '2026-07-12', account: '6422', amount: '100000000', party: rev });
      await spend({ entity: reversals, date: '2026-07-14', account: '6422', amount: '50000000', party: rev, description: 'sau đảo' });
      // pair: 7 steady entries; X1 reversed inside July, X2 reversed in August (outside the month), X3 stands.
      await history(reversals, pair, '6422', '10000000');
      const x1 = await spend({ entity: reversals, date: '2026-07-13', account: '6422', amount: '50000000', party: pair, description: 'X1' });
      await unspend({ entity: reversals, original: x1, date: '2026-07-15', account: '6422', amount: '50000000', party: pair });
      const x2 = await spend({ entity: reversals, date: '2026-07-20', account: '6422', amount: '50000000', party: pair, description: 'X2' });
      await unspend({ entity: reversals, original: x2, date: '2026-08-05', account: '6422', amount: '50000000', party: pair });
      await spend({ entity: reversals, date: '2026-07-22', account: '6422', amount: '50000000', party: pair, description: 'X3' });
      // The closing entries: a year-end style entry in April (a line on 911) is no history, one in July is no candidate.
      await history(closings, close, '6422', '10000000', SEVEN.slice(0, 5));
      await raw({ entity: closings, date: '2026-04-30', description: 'kết chuyển cũ', lines: [{ account: '911', debit: '10000000' }, { account: '6422', credit: '10000000', party: close }] });
      await spend({ entity: closings, date: '2026-07-14', account: '6422', amount: '50000000', party: close, description: 'sau kết chuyển' });
      await raw({ entity: closings, date: '2026-07-31', description: 'kết chuyển mới', lines: [{ account: '911', debit: '90000000' }, { account: '6422', credit: '90000000', party: close }] });
    });

    it('drops both sides of a pair, in any order and whatever the month of the reversal, and keeps them out of every history', async () => {
      const r = await review({ legalEntityId: reversals });
      // Only X3 stands: X1 and its reversal cancel inside July, X2's reversal is dated in August (a cancelled entry is not worth a look, unlike the expense variance), the April entry and its July reversal
      // leave the history of their supplier short, and the reversal of an older entry is no hit.
      expect(handles(r)).toEqual(['amount_outlier:X3']);
    });

    it('leaves out an entry with a line on 911, as a candidate and as history', async () => {
      const r = await review({ legalEntityId: closings });
      expect(handles(r)).toEqual([]);
      expect(r.empty).toBe(false);
    });
  });

  describe('control_manual', () => {
    beforeAll(async () => {
      const supplier = await party('Phải trả người bán');
      const mk = (description: string, date: string, lines: Line[], extra: { closingYear?: number } = {}) => voucher({ entity: controls, date, description, lines, ...extra });
      await mk('phải trả', '2026-07-14', [{ account: '6422', debit: '900000' }, { account: '331', credit: '900000', party: supplier }]);
      await mk('thuế GTGT', '2026-07-15', [{ account: '1331', debit: '800000' }, { account: '111', credit: '800000' }]);
      await mk('lương', '2026-07-16', [{ account: '334', debit: '700000' }, { account: '111', credit: '700000' }]);
      await mk('phải thu', '2026-07-17', [{ account: '131', debit: '600000' }, { account: '5111', credit: '600000' }]);
      await mk('thuế phải nộp', '2026-07-20', [{ account: '111', debit: '500000' }, { account: '3331', credit: '500000' }]);
      await mk('không công nợ', '2026-07-21', [{ account: '156', debit: '400000' }, { account: '111', credit: '400000' }]);
      // A voucher the system made (the year-end one) carries a control account too, and is no manual voucher.
      await mk('kết năm', '2026-07-22', [{ account: '331', debit: '300000' }, { account: '111', credit: '300000' }], { closingYear: 2026 });
      // An entry of another kind on 331 (every cost entry is) is not a manual voucher either.
      await spend({ entity: controls, date: '2026-07-23', account: '6422', amount: '200000', description: 'chi phí' });
    });

    it('flags a manual voucher with a line on 131, 331, 133, 333 or 334 and names the group, never a system voucher or another kind of entry', async () => {
      const r = await review({ legalEntityId: controls });
      expect(handles(r)).toEqual(['control_manual:phải trả', 'control_manual:thuế GTGT', 'control_manual:lương', 'control_manual:phải thu', 'control_manual:thuế phải nộp']);
      expect(r.hits.map((h) => [h.control, h.accountCode, h.amount, h.sourceKind])).toEqual([
        ['payable', '331', '900000', 'manual'],
        ['input_vat', '133', '800000', 'manual'],
        ['employee', '334', '700000', 'manual'],
        ['receivable', '131', '600000', 'manual'],
        ['tax', '333', '500000', 'manual'],
      ]);
      expect(r.hits[0]).toMatchObject({ partyName: 'Phải trả người bán', description: 'phải trả' });
    });
  });

  describe('new_account', () => {
    beforeAll(async () => {
      const [three, two, four, old, group] = (await Promise.all(['Ba lần', 'Hai lần', 'Bốn lần', 'Dùng từ lâu', 'Cùng nhóm'].map(party))) as [string, string, string, string, string];
      const earlier = ['2026-03-10', '2026-04-10', '2026-05-10'] as const;
      await history(accounts, three, '6422', '2000000', earlier);
      await history(accounts, two, '6422', '2000000', earlier.slice(0, 2));
      await history(accounts, four, '6422', '2000000', ['2026-02-10', ...earlier]);
      // Old: 6421 was used 27 months ago (outside the 24 months read), the recent entries are on 6422 only.
      await history(accounts, old, '6421', '2000000', ['2024-03-11', '2024-04-11', '2024-05-13']);
      await history(accounts, old, '6422', '2000000', earlier);
      // Group: 7 entries on 6421 (4 digits under TT133, a different line from 6422).
      await history(accounts, group, '6421', '2000000');
      await spend({ entity: accounts, date: '2026-07-14', account: '6421', amount: '3000000', party: three, description: 'mới' });
      await spend({ entity: accounts, date: '2026-07-15', account: '6421', amount: '3000000', party: two, description: 'hai' });
      await spend({ entity: accounts, date: '2026-07-16', account: '6422', amount: '3000000', party: four, description: 'cũ' });
      await spend({ entity: accounts, date: '2026-07-17', account: '6421', amount: '3000000', party: old, description: 'lâu' });
      await spend({ entity: accounts, date: '2026-07-20', account: '6422', amount: '3000000', party: group, description: 'nhóm' });
      // Kinds: 10 and 9 cash vouchers with no supplier on 6422, then one on a new account and one on the used one.
      for (const [entityId, n] of [[kinds10, 10], [kinds9, 9]] as const) {
        for (let i = 0; i < n; i += 1) await raw({ entity: entityId, date: `2026-0${2 + (i % 5)}-${10 + i}`, description: 'phiếu', sourceType: 'finance.cash_voucher', lines: [{ account: '6422', debit: '1000000' }, { account: '111', credit: '1000000' }] });
        await raw({ entity: entityId, date: '2026-07-14', description: 'phiếu mới', sourceType: 'finance.cash_voucher', lines: [{ account: '635', debit: '1000000' }, { account: '111', credit: '1000000' }] });
        await raw({ entity: entityId, date: '2026-07-15', description: 'phiếu cũ', sourceType: 'finance.cash_voucher', lines: [{ account: '6422', debit: '1000000' }, { account: '111', credit: '1000000' }] });
      }
    });

    it('flags an account a supplier with at least 3 earlier entries has not used in 24 months, on the 4-digit line under TT133', async () => {
      const r = await review({ legalEntityId: accounts });
      // Three earlier entries and a new account; the one with 2 earlier entries is judged by nothing; the same account again is no hit; an account used only 27 months ago is new; 6421 and 6422 are two lines under TT133.
      // All of 3,000,000, so the latest day comes first.
      expect(handles(r)).toEqual(['new_account:nhóm', 'new_account:lâu', 'new_account:mới']);
      expect(r.hits.map((h) => [h.basis, h.accountCode, h.partyName])).toEqual([
        ['party', '6422', 'Cùng nhóm'],
        ['party', '6421', 'Dùng từ lâu'],
        ['party', '6421', 'Ba lần'],
      ]);
    });

    it('flags an account a kind of voucher has not used when it has at least 10 earlier entries, for a line with no supplier', async () => {
      const ten = await review({ legalEntityId: kinds10 });
      expect(handles(ten)).toEqual(['new_account:phiếu mới']);
      expect(ten.hits[0]).toMatchObject({ basis: 'kind', accountCode: '635', sourceKind: 'cash_bank', partyId: null, amount: '1000000' });
      // With 9 earlier entries the kind has too little history.
      expect(handles(await review({ legalEntityId: kinds9 }))).toEqual([]);
    });
  });

  describe('off_day', () => {
    beforeAll(async () => {
      const cash = (description: string, date: string, amount: string) =>
        raw({ entity: offDays, date, description, sourceType: 'finance.cash_voucher', lines: [{ account: '6422', debit: amount }, { account: '111', credit: amount }] });
      await cash('thứ bảy', '2026-07-04', '6000000');
      await cash('chủ nhật', '2026-07-05', '5000000');
      await cash('thứ bảy nhỏ', '2026-07-11', '4999999');
      await cash('thứ hai', '2026-07-06', '6000000');
      await voucher({ entity: offDays, date: '2026-07-12', description: 'bút toán chủ nhật', lines: [{ account: '6422', debit: '7000000' }, { account: '111', credit: '7000000' }] });
      // Another kind of entry on a Saturday is dated by someone else: no hit.
      await spend({ entity: offDays, date: '2026-07-18', account: '6422', amount: '20000000', description: 'chi phí thứ bảy' });
      // 2 September is the National Day (a Wednesday), the 3rd an ordinary day; 17 February 2026 is a day of Tết (a Tuesday), the 21st a Saturday after it.
      await cash('quốc khánh', '2026-09-02', '6000000');
      await cash('ngày sau', '2026-09-03', '6000000');
      await cash('mùng', '2026-02-17', '6000000');
      await cash('thứ bảy sau Tết', '2026-02-21', '6000000');
    });

    it('flags an entry a person keyed on a weekend day, at 5,000,000 or more, ranked by size', async () => {
      const r = await review({ legalEntityId: offDays });
      expect(handles(r)).toEqual(['off_day:bút toán chủ nhật', 'off_day:thứ bảy', 'off_day:chủ nhật']);
      expect(r.hits.map((h) => [h.day, h.sourceKind, h.amount])).toEqual([
        ['weekend', 'manual', '7000000'],
        ['weekend', 'cash_bank', '6000000'],
        ['weekend', 'cash_bank', '5000000'],
      ]);
    });

    it('flags a public holiday of the shared calendar, fixed or lunar, and tells it from a weekend day', async () => {
      const september = await review({ legalEntityId: offDays, month: '2026-09' });
      expect(handles(september)).toEqual(['off_day:quốc khánh']);
      expect(september.hits[0]).toMatchObject({ day: 'holiday', entryDate: '2026-09-02' });
      const february = await review({ legalEntityId: offDays, month: '2026-02' });
      // Same size, so the later day comes first: the Saturday after Tết is a weekend day, the 17th a day of Tết.
      expect(handles(february)).toEqual(['off_day:thứ bảy sau Tết', 'off_day:mùng']);
      expect(february.hits.map((h) => h.day)).toEqual(['weekend', 'holiday']);
    });
  });

  describe('duplicate_invoice', () => {
    beforeAll(async () => {
      const [p1, p2, p3, p4, p5] = (await Promise.all(['Nhà cung cấp một', 'Nhà cung cấp hai', 'Chữ hoa chữ thường', 'Thay thế', 'Cùng tháng'].map(party))) as [string, string, string, string, string];
      const a = await invoice({ entity: dups, party: p1, series: 'AA', number: '0012', total: '5500000', date: '2026-05-20' });
      await invoice({ entity: dups, party: p1, series: 'AB', number: '12', total: '5500000', date: '2026-07-08' });
      await invoice({ entity: dups, party: p1, series: 'AC', number: '12', total: '6000000', date: '2026-07-09' });
      await invoice({ entity: dups, party: p2, series: 'AA', number: '12', total: '5500000', date: '2026-07-10' });
      await invoice({ entity: dups, party: p3, series: 'X1', number: 'ab-1', total: '2000000', date: '2026-06-03' });
      await invoice({ entity: dups, party: p3, series: 'X2', number: 'AB-1', total: '2000000', date: '2026-07-15' });
      const g = await invoice({ entity: dups, party: p4, series: 'R1', number: '77', total: '1000000', date: '2026-05-05' });
      await invoice({ entity: dups, party: p4, series: 'R2', number: '77', total: '1000000', date: '2026-07-16', replaces: g.document });
      await invoice({ entity: dups, party: p5, series: 'S1', number: '5', total: '3000000', date: '2026-07-01' });
      await invoice({ entity: dups, party: p5, series: 'S2', number: '5', total: '3000000', date: '2026-07-02' });
      expect(a.entry).toEqual(expect.any(String));
    });

    it('flags the later copy of an invoice with the same supplier, number (as the intake compares it) and total, never a replacement, another supplier or another amount', async () => {
      const r = await review({ legalEntityId: dups });
      expect(handles(r)).toEqual(['duplicate_invoice:HD AB/12', 'duplicate_invoice:HD S2/5', 'duplicate_invoice:HD X2/AB-1']);
      const [twice, same, cased] = r.hits;
      expect(twice).toMatchObject({ amount: '5500000', invoiceNumber: '12', otherEntryDate: '2026-05-20', sourceKind: 'invoice', partyName: 'Nhà cung cấp một' });
      expect(twice?.otherEntryId).toEqual(expect.any(String));
      expect(twice?.otherEntryId).not.toBe(twice?.entryId);
      expect(same).toMatchObject({ invoiceNumber: '5', otherEntryDate: '2026-07-01' });
      expect(cased).toMatchObject({ invoiceNumber: 'AB-1', otherEntryDate: '2026-06-03' });
    });
  });

  describe('TT99', () => {
    beforeAll(async () => {
      const [t, rev, close] = (await Promise.all(['Nhà cung cấp TT99', 'Đảo TT99', 'Kết chuyển TT99'].map(party))) as [string, string, string];
      // 7 earlier entries on two level-2 accounts of the same line 642: under TT99 they are one group.
      await history(tt99, t, '6421', '10000000', SEVEN.slice(0, 4));
      await history(tt99, t, '6428', '10000000', SEVEN.slice(4));
      await spend({ entity: tt99, date: '2026-07-14', account: '6422', amount: '50000000', party: t, description: 'TT99 cao' });
      await history(tt99, rev, '6421', '10000000');
      const x = await spend({ entity: tt99, date: '2026-07-15', account: '6421', amount: '50000000', party: rev, description: 'TT99 đảo' });
      await unspend({ entity: tt99, original: x, date: '2026-07-16', account: '6421', amount: '50000000', party: rev });
      await history(tt99, close, '6421', '10000000', SEVEN.slice(0, 5));
      await raw({ entity: tt99, date: '2026-04-30', description: 'kết chuyển TT99', lines: [{ account: '911', debit: '10000000' }, { account: '6421', credit: '10000000', party: close }] });
      await spend({ entity: tt99, date: '2026-07-17', account: '6421', amount: '50000000', party: close, description: 'sau kết chuyển TT99' });
      await voucher({ entity: tt99, date: '2026-07-20', description: 'TT99 thủ công', lines: [{ account: '6422', debit: '900000' }, { account: '331', credit: '900000' }] });
    });

    it('keeps 641 and 642 as one line each: the same shape that is a new account under TT133 is an amount here, with the reversed pair and the 911 entry dropped', async () => {
      const r = await review({ legalEntityId: tt99 });
      expect(r).toMatchObject({ regime: 'tt99', chartVersion: '2026.1', historyFrom: '2026-01-01' });
      expect(handles(r)).toEqual(['control_manual:TT99 thủ công', 'amount_outlier:TT99 cao']);
      expect(r.hits[1]).toMatchObject({ accountCode: '642', usual: '10000000', historyCount: 7, ratio: '5.0', partyName: 'Nhà cung cấp TT99' });
      expect(r.hits[0]).toMatchObject({ control: 'payable', accountCode: '331' });
    });

    it('does not read history from before the chart began, because the codes do not translate', async () => {
      const s = await party('Đổi sổ');
      // Three entries before the chart (Feb to Apr) and four after it: only the four count, so 4 earlier entries are too few.
      await history(switched, s, '6422', '10000000', ['2026-02-10', '2026-03-10', '2026-04-10']);
      await history(switched, s, '6422', '10000000', ['2026-05-12', '2026-05-22', '2026-06-12', '2026-06-22']);
      await spend({ entity: switched, date: '2026-07-14', account: '6422', amount: '50000000', party: s, description: 'sau đổi sổ' });
      const r = await review({ legalEntityId: switched });
      expect(r).toMatchObject({ regime: 'tt99', historyFrom: '2026-05-01' });
      expect(handles(r)).toEqual([]);
    });
  });

  describe('ranking, the caps and the reviewed mark', () => {
    let ids: string[] = [];
    beforeAll(async () => {
      for (let i = 0; i < 8; i += 1) {
        const p = await party(`Giới hạn ${i}`);
        await history(capped, p, '6422', '10000000');
        await spend({ entity: capped, date: '2026-07-14', account: '6422', amount: String(40000000 + i * 1000000), party: p, description: `lệch ${i}` });
      }
      ids = (await review({ legalEntityId: capped })).hits.map((h) => h.entryId);
    });

    it('shows at most 6 hits per rule, the largest first, and counts the ones past the limit', async () => {
      const r = await review({ legalEntityId: capped });
      expect(handles(r)).toEqual(['amount_outlier:lệch 7', 'amount_outlier:lệch 6', 'amount_outlier:lệch 5', 'amount_outlier:lệch 4', 'amount_outlier:lệch 3', 'amount_outlier:lệch 2']);
      expect(r).toMatchObject({ moreHits: 2, reviewed: 0 });
      expect(r.hits.length).toBeLessThanOrEqual(30);
      expect(ids).toHaveLength(6);
    });

    it('marks a hit as reviewed once, audits it, changes no ledger table, and leaves it out of the list while counting it', async () => {
      const before = await counts();
      const first = await mark({ entryId: ids[0] as string, rule: 'amount_outlier', legalEntityId: capped });
      expect(first).toEqual({ entryId: ids[0], rule: 'amount_outlier', alreadyReviewed: false });
      const again = await mark({ entryId: ids[0] as string, rule: 'amount_outlier', legalEntityId: capped });
      expect(again).toEqual({ entryId: ids[0], rule: 'amount_outlier', alreadyReviewed: true });
      const after = await counts();
      expect(after.entries).toBe(before.entries);
      expect(after.lines).toBe(before.lines);
      expect(Number(after.marks) - Number(before.marks)).toBe(1);
      // Every run is audited, with the entry and the rule and no figure.
      expect(Number(after.audit) - Number(before.audit)).toBeGreaterThanOrEqual(2);
      const audit = await admin((a) => a.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.unusual_entries.review' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]));
      expect(audit.rows.map((row) => [row.detail.entry_id, row.detail.rule, row.detail.already_reviewed])).toEqual([
        [ids[0], 'amount_outlier', false],
        [ids[0], 'amount_outlier', true],
      ]);
      expect(JSON.stringify(audit.rows)).not.toMatch(/4[0-9]000000/);
      const r = await review({ legalEntityId: capped });
      // The reviewed hit no longer takes a place: the seventh largest comes in, one is still past the limit.
      expect(handles(r)).toEqual(['amount_outlier:lệch 6', 'amount_outlier:lệch 5', 'amount_outlier:lệch 4', 'amount_outlier:lệch 3', 'amount_outlier:lệch 2', 'amount_outlier:lệch 1']);
      expect(r).toMatchObject({ moreHits: 1, reviewed: 1 });
    });

    it('marks per hit: the same entry under another rule is another mark', async () => {
      const r = await review({ legalEntityId: capped });
      const entry = r.hits[0]?.entryId as string;
      expect((await mark({ entryId: entry, rule: 'off_day', legalEntityId: capped })).alreadyReviewed).toBe(false);
      // The hit it is about is still there under its own rule.
      expect((await review({ legalEntityId: capped })).hits[0]?.entryId).toBe(entry);
    });

    it('refuses a viewer, an entry of another entity, an unknown entry and an unknown rule, and writes nothing then', async () => {
      const before = await counts();
      const entry = ids[1] as string;
      expect(await refusal(mark({ entryId: entry, rule: 'amount_outlier', legalEntityId: capped }, viewer))).toMatchObject({ code: 'FORBIDDEN' });
      expect(await refusal(mark({ entryId: entry, rule: 'amount_outlier', legalEntityId: main }))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(mark({ entryId: randomUUID(), rule: 'amount_outlier', legalEntityId: capped }))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await refusal(mark({ entryId: entry, rule: 'not_a_rule', legalEntityId: capped }))).toMatchObject({ code: 'VALIDATION', status: 422 });
      expect((await counts()).marks).toBe(before.marks);
    });

    it('lets a member scoped to the entity mark, and refuses the other entities of the org', async () => {
      const own = await review({}, member);
      expect(own.legalEntityId).toBe(tt99);
      const hit = own.hits[0];
      expect(hit).toBeDefined();
      expect((await mark({ entryId: hit?.entryId as string, rule: hit?.rule as string }, member)).alreadyReviewed).toBe(false);
      expect(await refusal(mark({ entryId: ids[2] as string, rule: 'amount_outlier', legalEntityId: capped }, member))).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    });
  });

  describe('the whole review is one statement over bounded history', () => {
    it('gives the same hits with a few hundred more history rows, and reads in one statement', async () => {
      const outlierParty = await party('Lệch lớn');
      const newParty = await party('Tài khoản mới 2');
      const padParties = await Promise.all(Array.from({ length: 12 }, (_, i) => party(`Nền ${i}`)));
      const probes = async (entityId: string) => {
        await history(entityId, outlierParty, '6422', '10000000');
        await history(entityId, newParty, '6422', '2000000', ['2026-03-10', '2026-04-10', '2026-05-10']);
        await spend({ entity: entityId, date: '2026-07-14', account: '6422', amount: '50000000', party: outlierParty, description: 'lệch' });
        await spend({ entity: entityId, date: '2026-07-15', account: '6421', amount: '3000000', party: newParty, description: 'mới' });
      };
      await probes(plain);
      await probes(padded);
      // 480 more entries (2 lines each) of 12 other suppliers on a steady account, every one dated before July, written in two statements.
      await admin(async (c) => {
        await c.query('SET session_replication_role = replica');
        await c.query(
          `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id)
           SELECT $1, DATE '2026-01-05' + (g % 170), 'nền ' || g, 'test.review', gen_random_uuid(), $2::uuid FROM generate_series(1, 480) g`,
          [orgId, padded],
        );
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
           SELECT $1, e.id, l.n, CASE l.n WHEN 1 THEN '6422' ELSE '331' END, CASE l.n WHEN 1 THEN 1000000 ELSE 0 END, CASE l.n WHEN 1 THEN 0 ELSE 1000000 END,
                  CASE l.n WHEN 1 THEN ($3::uuid[])[1 + (substr(e.description, 5)::int % 12)] END, $2::uuid
           FROM ludy_finance.journal_entry e CROSS JOIN (VALUES (1), (2)) AS l (n) WHERE e.org_id = $1 AND e.legal_entity_id = $2::uuid AND e.description LIKE 'nền %'`,
          [orgId, padded, padParties],
        );
      });
      const a = await review({ legalEntityId: plain });
      const b = await review({ legalEntityId: padded });
      const shape = (r: FinanceUnusualEntries) => r.hits.map((h) => [h.rule, h.description, h.amount, h.accountCode, h.partyName, h.usual, h.ratio, h.basis]);
      expect(shape(a)).toEqual([
        ['amount_outlier', 'lệch', '50000000', '6422', 'Lệch lớn', '10000000', '5.0', null],
        ['new_account', 'mới', '3000000', '6421', 'Tài khoản mới 2', null, null, 'party'],
      ]);
      expect(shape(b)).toEqual(shape(a));
      seen.length = 0;
      await review({ legalEntityId: padded });
      // One statement finds, ranks and caps the hits (the other reads fetch the entity's books, names and chart).
      expect(seen.filter((s) => s.includes('WITH ln AS')).length).toBe(1);
    });
  });

  describe('scope, refusals and a read that writes nothing', () => {
    it('reads an entity with no entry as empty, with no hit', async () => {
      expect(await review({ legalEntityId: nothing })).toMatchObject({ legalEntityId: nothing, empty: true, hits: [], moreHits: 0, reviewed: 0 });
    });

    it('refuses a month that has not ended', async () => {
      const next = new Date();
      next.setUTCMonth(next.getUTCMonth() + 1);
      const future = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(await refusal(review({ month: future }))).toMatchObject({ code: 'MONTH_NOT_ENDED', status: 422 });
      expect(await refusal(review({ month: '2099-12' }))).toMatchObject({ code: 'MONTH_NOT_ENDED', status: 422 });
      expect(await refusal(review({ month: '2999-01' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
    });

    it('gives a member scoped to another entity a refusal, and a viewer the same hits as the owner', async () => {
      expect(await refusal(review({ legalEntityId: main }, member))).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
      expect(await refusal(review({ legalEntityId: randomUUID() }, member))).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
      const asOwner = await review({ legalEntityId: main });
      const asViewer = await review({ legalEntityId: main }, viewer);
      expect(handles(asViewer)).toEqual(handles(asOwner));
    });

    it('never counts the postings of another entity', async () => {
      // main has outliers and nothing else of the other entities' kinds: none of their hits is in it.
      const m = await review({ legalEntityId: main });
      expect(m.hits.every((h) => h.rule === 'amount_outlier' || h.rule === 'new_account')).toBe(true);
      expect(handles(m)).not.toContain('control_manual:phải trả');
      expect(handles(m)).not.toContain('amount_outlier:TT99 cao');
    });

    it('writes nothing: no entry, no line, no mark, no audit row', async () => {
      const before = await counts();
      await review({});
      await review({ legalEntityId: tt99 });
      await review({ legalEntityId: nothing });
      expect(await counts()).toEqual(before);
    });
  });
});
