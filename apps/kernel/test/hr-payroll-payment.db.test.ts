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
import type { HrRunSheet, HrRunWritten, HrWritten, PayrollSettlement } from '@crove/kernel-contract';
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

  it('rebuilds the cash flag when it records: a stored proposal without it, with a changed count, or with one on a bank payment is refused', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const rawChecks = (proposalId: string, checks: string) =>
      rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{checks}', $3::jsonb) WHERE org_id = $1 AND id = $2`, [o.orgId, proposalId, checks]);
    // A cash payment of the net pay raises the flag; the same row without it (raw SQL, staff here) cannot be approved, so it cannot slip into a bulk approval.
    const cash = await pay(o, runId, 'net_pay', { type: 'cash_payment', cashAccount: '1111' });
    await rawChecks(cash.proposalId, '[]');
    await expect(approve(o, cash.proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'checks' } });
    // A flag naming another count is refused too.
    await rawChecks(cash.proposalId, JSON.stringify([{ id: 'anomaly_cash', status: 'warn', code: 'anomaly_cash.payroll_limit', message: 'x', params: { count: '1' } }]));
    await expect(approve(o, cash.proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'checks' } });
    // A bank payment carries no such flag: one written onto it is refused.
    const bank = await pay(o, runId, 'tax');
    await rawChecks(bank.proposalId, JSON.stringify([{ id: 'anomaly_cash', status: 'warn', code: 'anomaly_cash.payroll_limit', message: 'x', params: { count: '3' } }]));
    await expect(approve(o, bank.proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'checks' } });
    expect(await voucherOf(o, runId, 'net_pay')).toHaveLength(0);
    expect(await voucherOf(o, runId, 'tax')).toHaveLength(0);
    // The flag the preparer wrote is the one that passes: ask again after the raw rows are rejected, and approve it as it is.
    await rt.execute('kernel.proposal.reject', { id: cash.proposalId, reason: 'test' }, { actor: asUser(o.owner), orgId: o.orgId });
    await rt.execute('kernel.proposal.reject', { id: bank.proposalId, reason: 'test' }, { actor: asUser(o.owner), orgId: o.orgId });
    const again = await pay(o, runId, 'net_pay', { type: 'cash_payment', cashAccount: '1111' });
    await expect(approve(o, again.proposalId)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('shows a payment proposal as the proposal of its bank line: the line is proposed, and a voucher of another kind is refused for it', async () => {
    const o = await org('tt133', 'solo');
    const { runId, totals } = await postedRun(o);
    const net = money(totals.net).toFixed(0);
    // An outgoing line of the bank account for the net pay, on the payment's date (what the statement of the pay day shows).
    const [line] = await rows<{ id: string }>(
      `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount, bank_ref)
       VALUES ($1, '1121', $2, 1, '2026-03-31', 'Chi luong thang 03', $3, 'FTPAY1') RETURNING id`,
      [o.orgId, randomUUID(), `-${net}`],
    );
    const lineId = line?.id as string;
    const lineStates = async () =>
      new Map(
        (await o.query<{ lines: { id: string; state: { status: string; proposalId?: string } }[] }>(o.owner, 'finance.bank.lines', { bankAccount: '1121', period: '2026-03' })).lines.map((l) => [l.id, l.state] as const),
      );
    expect((await lineStates()).get(lineId)).toEqual({ status: 'open' });
    const { proposalId } = await pay(o, runId, 'net_pay', { bankLineId: lineId });
    expect((await lineStates()).get(lineId)).toEqual({ status: 'proposed', proposalId });
    // Another voucher for the same line, asked for by hand, is refused while the payment waits.
    await expect(
      rt.execute(
        'kernel.proposal.request',
        { command: 'finance.voucher.record', input: { type: 'bank_debit', date: '2026-03-31', cashAccount: '1121', description: 'trùng', lines: [{ account: '642', amount: net }], bankLineId: lineId } },
        { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'BANK_LINE_PROPOSED' });
    // And a second payment proposal of the same line too; approving the first settles the line.
    await expect(pay(o, runId, 'net_pay', { bankLineId: lineId })).rejects.toMatchObject({ code: 'HR_PAYMENT_OPEN' });
    await approve(o, proposalId);
    expect((await lineStates()).get(lineId)).toMatchObject({ status: 'matched' });
  });

  it('lets a chief accountant who is a member approve a payment from the run\'s totals, and the owner who froze the run is held back (#2751)', async () => {
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
    // The owner froze the run, so they are a co-author of its payment and held back while another may approve (the chief counts as eligible).
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    await expect(approve(o, proposalId, chief)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await voucherOf(o, approved.runId, 'tax')).toHaveLength(1);
  });

  const settlementOf = (o: Org, runId: string, user = o.owner) => o.query<PayrollSettlement>(user, 'finance.payroll.settlement', { runId });

  it('tells the card of the month where the posting and each payment stand, from the books and the open proposals, and names no person', async () => {
    const o = await org('tt133', 'solo');
    const approved = await approvedRun(o);
    const none = { status: 'none', proposalId: null };
    expect(await settlementOf(o, approved.runId)).toEqual({ runId: approved.runId, posting: none, payments: { net_pay: none, insurance: none, union: none, tax: none } });
    // Asked: the posting waits in the Inbox, and the card can link to it.
    const asked = await ask(o, approved.runId, o.owner);
    expect((await settlementOf(o, approved.runId)).posting).toEqual({ status: 'pending', proposalId: asked.proposalId });
    await approve(o, asked.proposalId);
    expect((await settlementOf(o, approved.runId)).posting).toEqual({ status: 'posted', proposalId: null });
    // A payment: pending with its proposal, then recorded; the other kinds are untouched.
    const net = await pay(o, approved.runId, 'net_pay');
    let state = await settlementOf(o, approved.runId);
    expect(state.payments.net_pay).toEqual({ status: 'pending', proposalId: net.proposalId });
    expect([state.payments.insurance.status, state.payments.union.status, state.payments.tax.status]).toEqual(['none', 'none', 'none']);
    await approve(o, net.proposalId);
    state = await settlementOf(o, approved.runId);
    expect(state.payments.net_pay).toEqual({ status: 'recorded', proposalId: null });
    // Only these keys, with ids and states: no amount and no name.
    expect(Object.keys(state).sort()).toEqual(['payments', 'posting', 'runId']);
    expect(JSON.stringify(state)).not.toMatch(/canary/i);
  });

  it('shows a reversed posting as reversed, hides the card data from a member, and never shows another org\'s run', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const [posting] = await rows<{ id: string }>(
      `SELECT e.id FROM crove_finance.journal_entry e JOIN crove_finance.journal_voucher j ON j.org_id = e.org_id AND j.id = e.source_id AND e.source_type = 'finance.journal_voucher'
        WHERE j.org_id = $1 AND j.payroll_run_id = $2 AND e.reverses_entry_id IS NULL`,
      [o.orgId, runId],
    );
    const asked = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.journal.reverse', input: { entryId: posting?.id, entryDate: '2026-03-31', reason: 'Lập lại bảng lương' } },
      { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    await approve(o, asked.proposalId);
    expect((await settlementOf(o, runId)).posting.status).toBe('reversed');
    const team = await org('tt133', 'standard');
    await expect(settlementOf(team, runId, team.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A run of another org reads as nothing asked for: the books and the proposals are the org's own.
    expect((await settlementOf(team, runId, team.owner)).posting).toEqual({ status: 'none', proposalId: null });
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
