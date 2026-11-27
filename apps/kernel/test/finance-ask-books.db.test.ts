// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181) on PostgreSQL 17, against a real ledger: each entry of the catalogue gives the figures the screen's own read gives, the coworker's kept choice is never an answer (the owner asks,
// then a viewer asks the same question, then a member limited to another entity: each gets what their own read gives, or its own refusal), a poisoned choice reads nothing, and nothing is written. The model is a fake.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AskBooksCoworker, type AiConfig } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday, zAskBooksAnswer } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries, type FinancialStatements, type LedgerReport } from '@ludy/mod-finance';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { askBooks, askBooksAi, type AskBooksQuery } from '../src/finance-ask-books.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const MONTH = TODAY.slice(0, 7);
const STUB_CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'stub', maxRetries: 0 };
const LEAD = 'Đây là báo cáo kết quả kinh doanh của kỳ được chọn.';

suite('ask the books in plain words (#5181)', () => {
  const dbName = `ludy_test_ask_books_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@askbooks.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string; scoped: string; entity: string; branch: string };

  // An org with its default entity, a branch, an owner, a viewer, and a member limited to the branch.
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hỏi sổ ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    const scoped = await identity('scoped');
    const { entity, branch } = await admin(async (c) => {
      const entity = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      const branch = (await c.query<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner])).rows[0]?.id as string;
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]);
      await c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, scoped]);
      await c.query("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, scoped, branch, owner]);
      return { entity, branch };
    });
    return { orgId, owner, viewer, scoped, entity, branch };
  }
  const queryAs = (o: Org, userId: string): AskBooksQuery => async <T>(name: string, input: Record<string, unknown>): Promise<T> => rt.query<T>(name, input, { actor: asUser(userId), orgId: o.orgId });
  const party = async (o: Org, name: string) => {
    const id = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, id, name]));
    return id;
  };
  // One balanced journal entry of the default entity, dated today.
  async function entry(o: Org, lines: Array<{ account: string; debit?: string; credit?: string; party?: string | null }>): Promise<void> {
    await admin(async (c) => {
      await c.query('BEGIN');
      const id = randomUUID();
      await c.query("INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'ask books test', 'finance.journal_voucher', $4, $5)", [o.orgId, id, TODAY, randomUUID(), o.entity]);
      let n = 1;
      for (const l of lines) await c.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [o.orgId, id, n++, l.account, l.debit ?? '0', l.credit ?? '0', l.party ?? null, o.entity]);
      await c.query('COMMIT');
    });
  }
  const counts = (o: Org) =>
    admin(async (c) => ({
      entries: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_entry WHERE org_id = $1', [o.orgId])).rows[0]?.n),
      lines: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_line WHERE org_id = $1', [o.orgId])).rows[0]?.n),
    }));
  // The coworker with a fake model that answers the given choice for every question.
  const fakeAi = (output: Record<string, unknown>, budget = new DraftBudget()) => {
    const coworker = new AskBooksCoworker(STUB_CONFIG, async () => ({ output, usage: { inputTokens: 1, outputTokens: 1 } }));
    return askBooksAi({ askBooksPick: (redacted, language, onUsage) => coworker.pick(redacted, language, onUsage) }, budget);
  };

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives each entry the figures of the screen\'s own read, in the period code resolved, and writes nothing', async () => {
    const o = await org();
    const customer = await party(o, 'Khách hàng A');
    await entry(o, [{ account: '112', debit: '5000000' }, { account: '411', credit: '5000000' }]);
    await entry(o, [{ account: '131', debit: '3000000', party: customer }, { account: '511', credit: '3000000' }]);
    // A customer who paid ahead (131 on the credit side) and a supplier we advanced money to (331 on the debit side), beside a supplier we really owe.
    const prepaying = await party(o, 'Khách trả trước');
    const advanced = await party(o, 'Nhà cung cấp nhận tiền ứng');
    const owedSupplier = await party(o, 'Nhà cung cấp còn nợ');
    await entry(o, [{ account: '112', debit: '2000000' }, { account: '131', credit: '2000000', party: prepaying }]);
    await entry(o, [{ account: '331', debit: '1500000', party: advanced }, { account: '112', credit: '1500000' }]);
    await entry(o, [{ account: '6422', debit: '7000000' }, { account: '331', credit: '7000000', party: owedSupplier }]);
    const before = await counts(o);
    const ask = (question: string, output: Record<string, unknown>) => askBooks(fakeAi(output), queryAs(o, o.owner), o.orgId, o.owner, { question, lang: 'vi' });

    const profit = await ask('Tháng này lãi bao nhiêu?', { entry: 'profit_loss', period: 'this_month', lead: LEAD });
    expect(zAskBooksAnswer.safeParse(profit).success).toBe(true);
    const statements = await rt.query<FinancialStatements>('finance.statements.period', { period: MONTH }, { actor: asUser(o.owner), orgId: o.orgId });
    const line = (code: string) => statements.b02.lines.find((l) => l.code === code)?.amount;
    expect(profit.card?.period.value).toBe(MONTH);
    expect(profit.card?.figures.find((f) => f.key === 'revenue')?.amount).toBe(line('10'));
    expect(profit.card?.figures.find((f) => f.key === 'profit_before_tax')?.amount).toBe(line('50'));
    expect(line('10')).toBe('3000000');
    expect(profit.lead).toBe(LEAD);

    const cash = await ask('Còn bao nhiêu tiền?', { entry: 'cash_balance', period: 'as_of_today', lead: '' });
    expect(cash.card?.figures).toEqual([{ key: 'cash', amount: statements.b01.lines.find((l) => l.code === '110')?.amount }]);
    // 5,000,000 booked first, 2,000,000 more from the customer who paid ahead, 1,500,000 less to the supplier advanced.
    expect(cash.card?.figures[0]?.amount).toBe('5500000');

    const owed = await ask('Ai còn nợ mình nhiều nhất?', { entry: 'receivables_top', period: 'as_of_today', lead: '' });
    const ledger = await rt.query<LedgerReport>('finance.ledger.period', { period: MONTH }, { actor: asUser(o.owner), orgId: o.orgId });
    // The screen's own total nets the customer who paid ahead (3,000,000 - 2,000,000); the card ranks and totals what is owed only and shows the other side on its own line.
    expect(ledger.receivables.totals.closing).toBe('1000000');
    expect(owed.card?.figures).toEqual([
      { key: 'total', amount: '3000000' },
      { key: 'advances', amount: '2000000' },
    ]);
    expect(owed.card?.top).toEqual([{ name: 'Khách hàng A', amount: '3000000' }]);
    expect(owed.card?.partyCount).toBe(1);

    const owe = await ask('Mình còn nợ ai nhiều nhất?', { entry: 'payables_top', period: 'as_of_today', lead: '' });
    expect(owe.card?.figures).toEqual([
      { key: 'total', amount: '7000000' },
      { key: 'advances', amount: '1500000' },
    ]);
    expect(owe.card?.top).toEqual([{ name: 'Nhà cung cấp còn nợ', amount: '7000000' }]);

    for (const [entryKey, period] of [['vat_position', 'last_month'], ['stock_value', 'as_of_today']] as const) {
      const answer = await ask(`câu hỏi ${entryKey}`, { entry: entryKey, period, lead: '' });
      expect(zAskBooksAnswer.safeParse(answer).success, entryKey).toBe(true);
      expect(answer.state, entryKey).toBe('card');
      expect(answer.card?.entry, entryKey).toBe(entryKey);
    }
    // Read only: not one entry or line more.
    expect(await counts(o)).toEqual(before);
  });

  it('keeps only the coworker\'s choice: the owner asks, then a viewer asks the same question, then a member limited to another entity, and each gets what their own read gives', async () => {
    const o = await org();
    const customer = await party(o, 'Khách hàng bí mật');
    await entry(o, [{ account: '131', debit: '9000000', party: customer }, { account: '511', credit: '9000000' }]);
    const ai = fakeAi({ entry: 'receivables_top', period: 'as_of_today', lead: LEAD });
    const question = { question: 'Ai còn nợ mình nhiều nhất?', lang: 'vi' as const };

    const owner = await askBooks(ai, queryAs(o, o.owner), o.orgId, o.owner, question);
    expect(owner.card?.top).toEqual([{ name: 'Khách hàng bí mật', amount: '9000000' }]);
    expect(owner.lead).toBe(LEAD);

    // The viewer may read the books too (every role may open the ledger), through their own read; the sentence is not repeated to them.
    const viewer = await askBooks(ai, queryAs(o, o.viewer), o.orgId, o.viewer, question);
    expect(viewer.card?.top).toEqual([{ name: 'Khách hàng bí mật', amount: '9000000' }]);
    expect(viewer.lead).toBeNull();

    // A member limited to the branch is given the branch's books, never the default entity's figures the owner was given.
    const scoped = await askBooks(ai, queryAs(o, o.scoped), o.orgId, o.scoped, question);
    expect(scoped.card?.top).toEqual([]);
    expect(scoped.card?.figures).toEqual([{ key: 'total', amount: '0' }]);
    expect(JSON.stringify(scoped)).not.toContain('Khách hàng bí mật');

    // And asking for the default entity by name gets the refusal the report itself gives, not an answer kept for the owner.
    await expect(askBooks(ai, queryAs(o, o.scoped), o.orgId, o.scoped, { ...question, legalEntityId: o.entity })).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    await expect(askBooks(ai, queryAs(o, o.scoped), o.orgId, o.scoped, { pick: { entry: 'cash_balance', period: { kind: 'relative', token: 'as_of_today' } }, legalEntityId: o.entity })).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });

    // What was kept is the choice and nothing else.
    const kept = [...ai.kept.values()].map((k) => k.choice);
    expect(kept).toEqual([{ entry: 'receivables_top', period: 'as_of_today' }]);
    expect(JSON.stringify([...ai.kept.entries()])).not.toContain('9000000');
  });

  it('reads nothing for a choice outside the catalogue and shows no card', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = await org();
    const reads: string[] = [];
    const spy: AskBooksQuery = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
      reads.push(name);
      return queryAs(o, o.owner)<T>(name, input);
    };
    for (const output of [
      { entry: 'payroll', period: 'last_month', lead: '' },
      { entry: 'profit_loss', period: '2020-01', lead: '' },
      { entry: 'profit_loss', period: 'last_month', lead: '', sql: 'select 1' },
      { entry: 'none', period: 'none', lead: '' },
    ]) {
      const answer = await askBooks(fakeAi(output), spy, o.orgId, o.owner, { question: 'Cho tôi xem lương', lang: 'vi' });
      expect(answer.state).toBe('none');
      expect(answer.card).toBeNull();
    }
    expect(reads).toEqual([]);
  });

  it('shows a period the entry\'s read does not take as a list to pick from, and reads nothing until one is picked', async () => {
    const o = await org();
    const reads: string[] = [];
    const spy: AskBooksQuery = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
      reads.push(name);
      return queryAs(o, o.owner)<T>(name, input);
    };
    const asked = await askBooks(fakeAi({ entry: 'vat_position', period: 'this_year', lead: '' }), spy, o.orgId, o.owner, { question: 'Thuế GTGT năm nay', lang: 'vi' });
    expect(asked.state).toBe('pick_period');
    expect(asked.pick?.options.every((option) => option.kind !== 'year')).toBe(true);
    expect(reads).toEqual([]);
    const picked = await askBooks(fakeAi({}), spy, o.orgId, o.owner, { pick: { entry: 'vat_position', period: { kind: 'period', value: MONTH } }, lang: 'vi' });
    expect(picked).toMatchObject({ ai: 'picked', state: 'card' });
    expect(reads).toEqual(['finance.vat.period']);
  });
});
