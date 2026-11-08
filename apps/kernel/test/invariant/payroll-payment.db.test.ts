// SPDX-License-Identifier: AGPL-3.0-only
// The security rules of the payment vouchers of a posted pay run (#2532, payroll plan 6.4, ADR-0046; they ride the finance proposal path) on a real PostgreSQL 17, as the real login roles:
// - only an owner or an admin approves a payment: a member who holds the approval permission (a chief accountant) is told so and the proposal stays pending, nothing recorded;
// - the person who approved the run is a co-author of its payment and is held back while another eligible approver exists; a stored proposal that lost the co-author is refused;
// - a cash payment of the net pay carries a flag when a net pay is 5 million or more, and the flag keeps it out of a bulk approval: approve_many refuses it (BULK_NOT_ALLOWED), it stays pending and no
//   voucher is recorded; the flag is rebuilt when the payment records, so a proposal written without it is refused;
// - one voucher per run and kind is a fact of the table: a voucher that names a run needs a kind, a proposal and a payment type, and a second of the same kind is refused.
// Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside test/invariant/). The product flow of the payments is in hr-payroll-payment.db.test.ts.
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
import { PAYROLL_POSTING_MAPS, PAYROLL_RULES } from '@crove/l10n-vn';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

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
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MONTH = '2026-03';
const TEAM: { name: string; wage: string; payFunction?: string }[] = [
  { name: 'Nguyễn Thị Hằng Canary', wage: '15000000' },
  { name: 'Trần Văn Hai Canary', wage: '9000000', payFunction: 'sales' },
  { name: 'Lê Thu Cúc Canary', wage: '30000000', payFunction: 'production' },
];

suite('the security of the payment of a pay run on PostgreSQL (#2532)', () => {
  const dbName = `crove_test_payinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  it('lets only an owner or an admin approve a payment: a member holding the approval permission is told so, and the proposal stays pending with nothing recorded', async () => {
    const o = await org('tt133', 'trio');
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, chief]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    const { runId } = await postedRun(o, 'trio');
    const { proposalId } = await pay(o, runId, 'tax', {}, o.admin);
    // A dated allowance for #2751 (the verification of a payment from the run's totals, so a member chief accountant can approve): until it lands, either outcome is accepted for the chief accountant:
    // refused with HR_POSTING_APPROVER_ROLE and the proposal still pending with nothing recorded, or approved with one voucher. The step-two change of #2751 pins the approval and removes this
    // allowance; it expires with that PR and, failing that, fails on 2026-12-24.
    expect(Date.now(), 'the allowance of #2751 for the chief accountant of a payment has expired: pin the approval').toBeLessThan(Date.parse('2026-12-24T00:00:00Z'));
    const outcome = await approve(o, proposalId, chief).then(
      () => 'approved' as const,
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'HR_POSTING_APPROVER_ROLE', status: 403 });
        return 'refused' as const;
      },
    );
    const status = (await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status;
    if (outcome === 'refused') {
      expect(status).toBe('pending');
      expect(await voucherOf(o, runId, 'tax')).toHaveLength(0);
    } else {
      expect(status).toBe('executed');
      expect(await voucherOf(o, runId, 'tax')).toHaveLength(1);
    }
  });

  it('holds the approver of the run back as a co-author of its payment, and refuses a stored proposal that lost the co-author', async () => {
    const o = await org('tt133', 'trio');
    const { runId } = await postedRun(o, 'trio');
    const { proposalId } = await pay(o, runId, 'union', {}, o.admin);
    const [stored] = await rows<{ co_authors: string[] }>('SELECT co_authors FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]);
    expect(stored?.co_authors).toEqual([o.owner]);
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    expect(await voucherOf(o, runId, 'union')).toHaveLength(0);
    await rows('UPDATE crove_kernel.proposal SET co_authors = NULL WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]);
    await expect(approve(o, proposalId, o.admin2)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'coAuthors' } });
    expect(await voucherOf(o, runId, 'union')).toHaveLength(0);
  });

  it('refuses a flagged cash payment in a bulk approval (BULK_NOT_ALLOWED): it stays pending and records no voucher; a proposal written without the flag is refused when it records', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const cash = await pay(o, runId, 'net_pay', { type: 'cash_payment', cashAccount: '1111' });
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: cash.proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    const bulk = await rt.execute<{ results: { id: string; outcome: string; code?: string }[] }>(
      'kernel.proposal.approve_many',
      { items: [{ id: cash.proposalId, revision: detail.revision }] },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(bulk.results).toEqual([expect.objectContaining({ id: cash.proposalId, outcome: 'refused', code: 'BULK_NOT_ALLOWED' })]);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, cash.proposalId]))[0]?.status).toBe('pending');
    expect(await voucherOf(o, runId, 'net_pay')).toHaveLength(0);
    // The same row without its flag (raw SQL, staff here) would pass the bulk filter, so recording refuses it.
    await rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{checks}', '[]'::jsonb) WHERE org_id = $1 AND id = $2`, [o.orgId, cash.proposalId]);
    await expect(approve(o, cash.proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'checks' } });
    expect(await voucherOf(o, runId, 'net_pay')).toHaveLength(0);
  });

  it('holds one voucher per run and kind in the table: a run needs a kind, a proposal and a payment type, and a second of the same kind is refused', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await postedRun(o);
    const proposalId = (await pay(o, runId, 'tax')).proposalId;
    const insert = (kind: string | null, type: string, proposal: string | null, run = runId) =>
      rows(
        `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, proposal_id, payroll_run_id, payroll_payment_kind)
         VALUES ($1, $2, 0, '2026-03-31', $3, 'chi', 1000, $4, $5, $6)`,
        [o.orgId, type, type === 'cash_payment' ? '1111' : '1121', proposal, run, kind],
      );
    // A run with no kind, no proposal or a receipt is refused by the check, and one with no run but a kind too (both or neither).
    await expect(insert(null, 'bank_debit', proposalId)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('tax', 'bank_debit', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('tax', 'bank_credit', proposalId)).rejects.toMatchObject({ code: '23514' });
    await expect(rows(`INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, payroll_payment_kind) VALUES ($1, 'bank_debit', 0, '2026-03-31', '1121', 'chi', 1000, 'tax')`, [o.orgId])).rejects.toMatchObject({ code: '23514' });
    await approve(o, proposalId);
    expect(await voucherOf(o, runId, 'tax')).toHaveLength(1);
    // Another voucher of the same run and kind (any proposal) is refused by the unique index.
    const other = (await pay(o, runId, 'union')).proposalId;
    await expect(insert('tax', 'bank_debit', other)).rejects.toMatchObject({ code: '23505' });
  });
});
