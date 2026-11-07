// SPDX-License-Identifier: AGPL-3.0-only
// The posting of an approved pay run (#2532, payroll plan 6.4 and row 18, ADR-0046) on a real PostgreSQL 17, through the finance proposal path:
// - an owner or an admin asks for it (kernel.proposal.request, `finance.payroll_posting.record`), the HR module builds the entry from the frozen run, an owner or an admin approves it, and
//   approving posts one voucher that names the run; the entry balances and equals the run's totals, one line per account;
// - a TT133 entity posts unemployment insurance to 3385 and never 3386, a TT99 entity to 3386 and never 3385, and each function has its own expense account;
// - a run that is not approved, one with a posting open or done, and one that does not exist are refused; a member cannot ask; the voucher of a run is unique in the database.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrRunSheet, HrRunWritten, HrWritten } from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { PAYROLL_RULES } from '@crove/l10n-vn';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

// Every rule of the shipped set is `commentary` until the accountant confirms it (#2535), so a real approval cannot pass yet: the tests confirm the rows for themselves (see hr-payroll-run).
vi.mock('@crove/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@crove/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MONTH = '2026-03';
const TEAM: { name: string; wage: string; payFunction?: string }[] = [
  { name: 'Nguyễn Thị Hằng Canary', wage: '15000000' },
  { name: 'Trần Văn Hai Canary', wage: '9000000', payFunction: 'sales' },
  { name: 'Lê Thu Cúc Canary', wage: '30000000', payFunction: 'production' },
];

suite('the posting of a pay run on PostgreSQL (#2532)', () => {
  const dbName = `crove_test_hrposting_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function org(regime: 'tt133' | 'tt99' = 'tt133') {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrposting', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `Hạch toán lương ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
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
    return { orgId, owner, admin, member, exec, query };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // Opens, calculates and approves a month (the rules confirmed for the test), returning the run and its totals as approved.
  async function approvedRun(o: Org) {
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'confirmed';
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: MONTH });
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

  it('posts a TT133 run once: balanced, equal to the totals, one line per account, 3385 and never 3386, each function on its own account', async () => {
    const o = await org('tt133');
    const { runId, totals } = await approvedRun(o);
    const { proposalId } = await ask(o, runId);
    const posted = await approve(o, proposalId);
    const lines = await entry(o, posted.journalEntryId);
    const all = await rows<{ account_code: string; debit: string; credit: string }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2',
      [o.orgId, posted.journalEntryId],
    );
    expect(new Set(all.map((l) => l.account_code)).size).toBe(all.length);
    const debit = all.reduce((a, l) => a + BigInt(l.debit), 0n);
    const credit = all.reduce((a, l) => a + BigInt(l.credit), 0n);
    expect(debit).toBe(credit);
    // The expense of the entry is the employer's cost of the run, and 334 carries the net pay.
    expect(debit).toBe(BigInt(Number(totals.employerCost)));
    expect(lines['334']).toBe(`Cr ${Math.round(Number(totals.net))}`);
    expect(lines['3385']).toMatch(/^Cr /);
    expect(lines['3386']).toBeUndefined();
    expect(Object.keys(lines)).toEqual(expect.arrayContaining(['6422', '6421', '154', '3383', '3384', '3382', '3335']));
    const [voucher] = await rows<{ payroll_run_id: string; proposal_id: string }>('SELECT payroll_run_id, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, posted.voucherId]);
    expect(voucher).toMatchObject({ payroll_run_id: runId, proposal_id: proposalId });
    // Posted once: a new request and a second voucher for the run are both refused.
    await expect(ask(o, runId)).rejects.toMatchObject({ code: 'HR_POSTING_DONE' });
    await expect(
      withAdmin((c) =>
        c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id) SELECT org_id, voucher_date, description, proposal_id, payroll_run_id FROM crove_finance.journal_voucher WHERE id = $1`, [posted.voucherId]),
      ),
    ).rejects.toThrow();
  });

  it('posts a TT99 run to 3386, never 3385, and sends each function to its own account', async () => {
    const o = await org('tt99');
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId);
    const posted = await approve(o, proposalId);
    const lines = await entry(o, posted.journalEntryId);
    expect(lines['3386']).toMatch(/^Cr /);
    expect(lines['3385']).toBeUndefined();
    expect(Object.keys(lines)).toEqual(expect.arrayContaining(['6421', '6411', '622', '3383', '3384', '3382', '3335', '334']));
  });

  it('refuses a run that is not approved, one already asked for, and one that does not exist; a member cannot ask', async () => {
    const o = await org();
    const draft = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-02' });
    await expect(ask(o, draft.runId)).rejects.toMatchObject({ code: 'HR_RUN_NOT_APPROVED' });
    await expect(ask(o, randomUUID())).rejects.toMatchObject({ code: 'HR_RUN_NOT_FOUND' });
    const { runId } = await approvedRun(o);
    await expect(ask(o, runId, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await ask(o, runId);
    await expect(ask(o, runId, o.owner)).rejects.toMatchObject({ code: 'HR_POSTING_OPEN' });
    // The id written in capitals is the same run.
    await expect(ask(o, runId.toUpperCase(), o.owner)).rejects.toMatchObject({ code: 'HR_POSTING_OPEN' });
  });
});
