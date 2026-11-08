// SPDX-License-Identifier: AGPL-3.0-only
// The payment vouchers of an approved and posted pay run (#2532, payroll plan 6.4, ADR-0046) on a real PostgreSQL 17, through the finance proposal path:
// - an owner or an admin asks for the payment of the net pay or of a remittance (kernel.proposal.request, `finance.payroll_payment.record`), the HR module builds the voucher from the frozen run, an owner
//   or an admin approves it, and approving records one voucher that names the run and the kind of payment, with its entry (Dr the payable, Cr the bank or cash account);
// - one voucher per run and kind (the command and the database both hold it), only after the run was posted, never while the account map is unconfirmed, never for a draft run;
// - a payment of the net pay in cash is flagged when a net pay is 5 million or more, a bank payment is not, and the flag keeps the proposal out of bulk approval;
// - a stored proposal that differs from the run is refused at approval; no person's name is stored anywhere.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrRunSheet, HrRunWritten, HrWritten } from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { PAYROLL_POSTING_MAPS, PAYROLL_RULES, money } from '@crove/l10n-vn';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

// Every rule of the shipped set, and every account map of the posting, is `commentary` until the accountant confirms it (#2535), so a real approval or posting cannot pass yet: the tests confirm the
// rows for themselves (see hr-payroll-run), and one test leaves the maps as shipped to show the posting is refused.
vi.mock('@crove/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@crove/l10n-vn')>();
  return {
    ...real,
    PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })),
    PAYROLL_POSTING_MAPS: Object.fromEntries(Object.entries(real.PAYROLL_POSTING_MAPS).map(([regime, map]) => [regime, { ...map }])) as typeof real.PAYROLL_POSTING_MAPS,
  };
});
const setMapStatus = (status: 'confirmed' | 'commentary') => {
  for (const map of Object.values(PAYROLL_POSTING_MAPS)) (map as { status: string }).status = status;
};

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MONTH = '2026-03';
const TEAM: { name: string; wage: string; payFunction?: string }[] = [
  { name: 'Nguyễn Thị Hằng Canary', wage: '15000000' },
  { name: 'Trần Văn Hai Canary', wage: '9000000', payFunction: 'sales' },
  { name: 'Lê Thu Cúc Canary', wage: '30000000', payFunction: 'production' },
];

suite('the payment of a pay run on PostgreSQL (#2532)', () => {
  const dbName = `crove_test_hrpayment_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => withAdmin(async (c) => (await c.query<T>(sql, params)).rows);

  async function org(regime: 'tt133' | 'tt99' = 'tt133', people: 'standard' | 'trio' | 'solo' = 'standard') {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `Hạch toán lương ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    // Three people may approve a posting (an owner and two admins), or the owner alone.
    const admin2 = await person('admin2');
    if (people === 'trio') await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, admin2]));
    if (people === 'solo') await withAdmin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = ANY ($2::uuid[])`, [orgId, [admin, member]]));
    if (regime === 'tt99') {
      await withAdmin((c) =>
        c.query(
          `INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from)
           SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`,
          [orgId],
        ),
      );
    }
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId, idempotencyKey: randomUUID() });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    for (const t of TEAM) {
      await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: t.name,
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: t.wage, ...(t.payFunction ? { payFunction: t.payFunction } : {}) },
      });
    }
    return { orgId, owner, admin, admin2, member, exec, query };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // Opens, calculates and approves a month (the rules confirmed for the test), returning the run and its totals as approved.
  async function approvedRun(o: Org, month = MONTH, beforeApprove?: (runId: string) => Promise<void>) {
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'confirmed';
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month });
    await beforeApprove?.(run.runId as string);
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: sheet.fingerprint, acceptFlags: true }, asMfa(o.owner));
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'commentary';
    return { runId: run.runId as string, totals: sheet.totals };
  }
  const ask = (o: Org, runId: string, user = o.admin) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.payroll_posting.record', input: { runId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function approve(o: Org, proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ voucherId: string; journalEntryId: string; code: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  }
  const entry = async (o: Org, entryId: string) =>
    Object.fromEntries(
      (
        await rows<{ account_code: string; debit: string; credit: string }>(
          'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2',
          [o.orgId, entryId],
        )
      ).map((l) => [l.account_code, l.debit !== '0' ? `Dr ${l.debit}` : `Cr ${l.credit}`]),
    );

  beforeEach(() => setMapStatus('confirmed'));
  afterEach(() => setMapStatus('commentary'));

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...financeQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  // The posting of the run first (the payments rest on it), by a lone owner in the one-person path.
  async function postedRun(o: Org, people: 'solo' | 'trio' = 'solo', month = MONTH) {
    const approved = await approvedRun(o, month);
    // The owner froze the run, so in a trio the admin asks and the other admin approves (the owner is a co-author, the admin an author).
    const { proposalId } = await ask(o, approved.runId, people === 'trio' ? o.admin : o.owner);
    await approve(o, proposalId, people === 'trio' ? o.admin2 : o.owner);
    return approved;
  }
  type Kind = 'net_pay' | 'insurance' | 'union' | 'tax';
  const pay = (o: Org, runId: string, kind: Kind, extra: Record<string, unknown> = {}, user = o.owner) =>
    rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.payroll_payment.record', input: { runId, kind, type: 'bank_debit', date: '2026-03-31', cashAccount: '1121', ...extra } },
      { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
  const voucherOf = (o: Org, runId: string, kind: Kind) =>
    rows<{ id: string; voucher_type: string; cash_account: string; amount: string; proposal_id: string }>(
      'SELECT id, voucher_type, cash_account, amount::bigint::text AS amount, proposal_id FROM crove_finance.cash_voucher WHERE org_id = $1 AND payroll_run_id = $2 AND payroll_payment_kind = $3',
      [o.orgId, runId, kind],
    );

  it('records the net pay of a posted run: one voucher naming the run, Dr 334 and Cr the bank, the amount equal to the approved net', async () => {
    const o = await org('tt133', 'solo');
    const { runId, totals } = await postedRun(o);
    const { proposalId } = await pay(o, runId, 'net_pay');
    const done = await approve(o, proposalId);
    const lines = await entry(o, done.journalEntryId);
    expect(lines['334']).toBe(`Dr ${money(totals.net).toFixed(0)}`);
    expect(lines['1121']).toBe(`Cr ${money(totals.net).toFixed(0)}`);
    const [voucher] = await voucherOf(o, runId, 'net_pay');
    expect(voucher).toMatchObject({ voucher_type: 'bank_debit', cash_account: '1121', amount: money(totals.net).toFixed(0), proposal_id: proposalId });
    // The proposal is shown as a voucher in the Inbox, and names the run.
    const detail = await rt.query<{ voucher: { type: string; total: string } | null }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(detail.voucher).toMatchObject({ type: 'bank_debit', total: money(totals.net).toFixed(0) });
  });

  it('records each remittance with the payables it clears, and nothing else: insurance, union fee and tax, each once', async () => {
    const o = await org('tt133', 'solo');
    const { runId, totals } = await postedRun(o);
    const expected: Record<Exclude<Kind, 'net_pay'>, { accounts: string[]; total: string }> = {
      insurance: { accounts: ['3383', '3384', '3385'], total: money(totals.employeeInsurance).plus(totals.employerInsurance).toFixed(0) },
      union: { accounts: ['3382'], total: money(totals.unionFee).toFixed(0) },
      tax: { accounts: ['3335'], total: money(totals.pit).toFixed(0) },
    };
    for (const kind of ['insurance', 'union', 'tax'] as const) {
      const { proposalId } = await pay(o, runId, kind);
      const done = await approve(o, proposalId);
      const lines = await entry(o, done.journalEntryId);
      expect(Object.keys(lines).sort(), kind).toEqual([...expected[kind].accounts, '1121'].sort());
      const [voucher] = await voucherOf(o, runId, kind);
      expect(voucher?.amount, kind).toBe(expected[kind].total);
    }
    // One of a kind: asking again is refused, and so is a second voucher of the run and kind written straight into the table.
    await expect(pay(o, runId, 'tax')).rejects.toMatchObject({ code: 'HR_PAYMENT_DONE' });
    await expect(
      rows(
        `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, proposal_id, payroll_run_id, payroll_payment_kind)
         SELECT org_id, voucher_type, 0, voucher_date, cash_account, description, amount, proposal_id, payroll_run_id, payroll_payment_kind FROM crove_finance.cash_voucher WHERE org_id = $1 AND payroll_run_id = $2 AND payroll_payment_kind = 'tax'`,
        [o.orgId, runId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a payment before the run is posted, for a draft run and an unknown run; a member cannot ask', async () => {
    const o = await org('tt133', 'standard');
    const draft = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-02' });
    await expect(pay(o, draft.runId, 'net_pay')).rejects.toMatchObject({ code: 'HR_RUN_NOT_APPROVED' });
    await expect(pay(o, randomUUID(), 'net_pay')).rejects.toMatchObject({ code: 'HR_RUN_NOT_FOUND' });
    const { runId } = await approvedRun(o);
    await expect(pay(o, runId, 'net_pay')).rejects.toMatchObject({ code: 'HR_PAYMENT_NOT_POSTED' });
    await expect(pay(o, runId, 'net_pay', {}, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets two requests for the same run and kind take turns, keeps another kind free, and holds the account map gate', async () => {
    const o = await org('tt133', 'trio');
    const { runId } = await postedRun(o, 'trio');
    const results = await Promise.allSettled([pay(o, runId, 'net_pay', {}, o.admin), pay(o, runId, 'net_pay', {}, o.owner)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'HR_PAYMENT_OPEN' });
    // The id written in capitals is the same run; another kind is a different payment.
    await expect(pay(o, runId.toUpperCase(), 'net_pay')).rejects.toMatchObject({ code: 'HR_PAYMENT_OPEN' });
    await expect(pay(o, runId, 'tax')).resolves.toMatchObject({ proposalId: expect.any(String) });
    // While the accountant has not confirmed the map (#2535), nothing is asked for.
    setMapStatus('commentary');
    await expect(pay(o, runId, 'union')).rejects.toMatchObject({ code: 'HR_POSTING_MAP_UNCONFIRMED' });
  });

  it('flags a net pay paid in cash at 5 million or more, not a bank payment or a remittance, and keeps the flag out of bulk approval', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const cash = await pay(o, runId, 'net_pay', { type: 'cash_payment', cashAccount: '1111' });
    const flagged = await rows<{ checks: { id: string; status: string; code: string; params: { count: string } }[] }>('SELECT payload -> \'checks\' AS checks FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, cash.proposalId]);
    // The three people of the test are paid 5 million or more net: the flag counts them and names nobody.
    expect(flagged[0]?.checks).toEqual([expect.objectContaining({ id: 'anomaly_cash', status: 'warn', code: 'anomaly_cash.payroll_limit', params: { count: '3' } })]);
    const detail = await rt.query<{ checks: { code?: string }[] }>('kernel.inbox.get', { id: cash.proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(JSON.stringify(detail)).not.toMatch(/Canary/);
    const bank = await pay(o, runId, 'tax', { type: 'cash_payment', cashAccount: '1111' });
    const none = await rows<{ checks: unknown }>('SELECT payload -> \'checks\' AS checks FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, bank.proposalId]);
    expect(none[0]?.checks ?? null).toBeNull();
  });

  it('stores no person: no name in any proposal, voucher, entry, audit row or event of the payments', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    for (const kind of ['net_pay', 'insurance', 'union', 'tax'] as const) await approve(o, (await pay(o, runId, kind)).proposalId);
    for (const table of ['crove_kernel.proposal', 'crove_finance.cash_voucher', 'crove_finance.journal_entry', 'crove_kernel.audit_event', 'crove_kernel.outbox_event']) {
      const hit = await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text ILIKE '%canary%'`, [o.orgId]);
      expect(hit, table).toHaveLength(0);
    }
  });

  it('rebuilds the obligation from the frozen run when it records, and refuses a stored proposal that differs from it', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const { proposalId } = await pay(o, runId, 'net_pay');
    // A proposal row written some other way than by the preparer (raw SQL, staff here): the amount of the first line is raised, still a valid voucher.
    await rows(
      `UPDATE crove_kernel.proposal
          SET payload = jsonb_set(jsonb_set(payload, '{lines,0,amount}', to_jsonb((((payload #>> '{lines,0,amount}')::bigint) + 1)::text)), '{total}', to_jsonb((((payload ->> 'total')::bigint) + 1)::text))
        WHERE org_id = $1 AND id = $2`,
      [o.orgId, proposalId],
    );
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
    expect(await voucherOf(o, runId, 'net_pay')).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
  });

  it('lets only an owner or an admin approve a payment: a member who holds the approval permission is told so, and the proposal stays pending', async () => {
    const o = await org('tt133', 'trio');
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, chief]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    const approved = await approvedRun(o);
    const posting = await ask(o, approved.runId, o.admin);
    await approve(o, posting.proposalId, o.admin2);
    const { proposalId } = await pay(o, approved.runId, 'tax', {}, o.admin);
    await expect(approve(o, proposalId, chief)).rejects.toMatchObject({ code: 'HR_POSTING_APPROVER_ROLE', status: 403 });
    expect(await voucherOf(o, approved.runId, 'tax')).toHaveLength(0);
    // The owner froze the run, so they are a co-author of its payment and held back while another may approve (the chief counts as eligible); the other admin approves.
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    await expect(approve(o, proposalId, o.admin2)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('counts the person who approved the run as a co-author of its payment, and refuses a stored proposal that lost it', async () => {
    const o = await org('tt133', 'trio');
    const { runId } = await postedRun(o, 'trio');
    const { proposalId } = await pay(o, runId, 'union', {}, o.admin);
    const [stored] = await rows<{ co_authors: string[] }>('SELECT co_authors FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]);
    expect(stored?.co_authors).toEqual([o.owner]);
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    // A proposal row written some other way without the co-author (raw SQL, staff here) is refused when it records, even by the other admin.
    await rows('UPDATE crove_kernel.proposal SET co_authors = NULL WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]);
    await expect(approve(o, proposalId, o.admin2)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'coAuthors' } });
    expect(await voucherOf(o, runId, 'union')).toHaveLength(0);
  });
});
