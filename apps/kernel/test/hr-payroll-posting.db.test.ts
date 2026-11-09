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

  async function org(regime: 'tt133' | 'tt99' = 'tt133', people: 'standard' | 'trio' | 'solo' = 'standard') {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrposting', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
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
    expect(money(debit.toString()).equals(money(totals.employerCost))).toBe(true);
    expect(lines['334']).toBe(`Cr ${money(totals.net).toFixed(0)}`);
    expect(lines['3385']).toMatch(/^Cr /);
    expect(lines['3386']).toBeUndefined();
    expect(Object.keys(lines)).toEqual(expect.arrayContaining(['6422', '6421', '154', '3383', '3384', '3382', '3335']));
    const [voucher] = await rows<{ payroll_run_id: string; proposal_id: string }>('SELECT payroll_run_id, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, posted.voucherId]);
    expect(voucher).toMatchObject({ payroll_run_id: runId, proposal_id: proposalId });
    // The people stay on the run: the test team's names appear nowhere in the proposal, the voucher, the entry, the audit rows of the posting or the outbox.
    const [trace] = await rows<{ n: string }>(
      `SELECT (SELECT count(*) FROM crove_kernel.proposal t WHERE org_id = $1 AND t::text ILIKE '%canary%')
            + (SELECT count(*) FROM crove_finance.journal_voucher t WHERE org_id = $1 AND t::text ILIKE '%canary%')
            + (SELECT count(*) FROM crove_finance.journal_entry t WHERE org_id = $1 AND t::text ILIKE '%canary%')
            + (SELECT count(*) FROM crove_finance.journal_line t WHERE org_id = $1 AND t::text ILIKE '%canary%')
            + (SELECT count(*) FROM crove_kernel.audit_event t WHERE org_id = $1 AND command IN ('kernel.proposal.request', 'hr.payroll.posting.prepare', 'finance.payroll_posting.check', 'finance.payroll_posting.regime', 'kernel.proposal.approve', 'finance.payroll_posting.record') AND t::text ILIKE '%canary%')
            + (SELECT count(*) FROM crove_kernel.outbox_event t WHERE org_id = $1 AND t::text ILIKE '%canary%') AS n`,
      [o.orgId],
    );
    expect(trace?.n).toBe('0');
    // Posted once: a new request and a second voucher for the run are both refused.
    await expect(ask(o, runId)).rejects.toMatchObject({ code: 'HR_POSTING_DONE' });
    await expect(
      withAdmin((c) =>
        c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id) SELECT org_id, voucher_date, description, proposal_id, payroll_run_id FROM crove_finance.journal_voucher WHERE id = $1`, [posted.voucherId]),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
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

  it('refuses to approve a month whose lines rest on superseded terms (a change of function with the same wage), and posts the function of the terms frozen at approval', async () => {
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'confirmed';
    const o = await org();
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: MONTH });
    const before = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    // After the month was opened, the first person moves to sales from the first day, on the same wage: the figures do not change, the expense account does.
    const [first] = await rows<{ id: string }>(`SELECT id FROM crove_hr.payroll_employee WHERE org_id = $1 ORDER BY created_at, id LIMIT 1`, [o.orgId]);
    await o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: first?.id, effectiveFrom: `${MONTH}-01`, contractType: 'indefinite', region: 'I', baseWage: TEAM[0]?.wage, payFunction: 'sales' });
    await expect(o.exec(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: before.fingerprint, acceptFlags: true }, asMfa(o.owner))).rejects.toMatchObject({ code: 'HR_RUN_STALE' });
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId });
    const after = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await o.exec(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: after.fingerprint, acceptFlags: true }, asMfa(o.owner));
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'commentary';
    const { proposalId } = await ask(o, run.runId as string);
    const posted = await approve(o, proposalId);
    const lines = await entry(o, posted.journalEntryId);
    // Two people now sit on 6421 (sales); the first one's pay no longer goes to 6422 (administration).
    expect(lines['6421']).toMatch(/^Dr /);
    expect(lines['6422']).toBeUndefined();
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

  it('refuses to ask for or to post a run while the accountant has not confirmed the account map (#2535), and posts once it is confirmed', async () => {
    const o = await org();
    const { runId } = await approvedRun(o);
    setMapStatus('commentary');
    await expect(ask(o, runId)).rejects.toMatchObject({ code: 'HR_POSTING_MAP_UNCONFIRMED' });
    // A proposal asked for while the map was confirmed is not posted once it is not (finance's own gate), and stays pending.
    setMapStatus('confirmed');
    const { proposalId } = await ask(o, runId);
    setMapStatus('commentary');
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MAP_UNCONFIRMED' });
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(0);
    setMapStatus('confirmed');
    await expect(approve(o, proposalId)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('lets two requests for the same run take turns: one proposal is made, the other is refused as open', async () => {
    const o = await org();
    const { runId } = await approvedRun(o);
    const results = await Promise.allSettled([ask(o, runId, o.admin), ask(o, runId, o.owner)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'HR_POSTING_OPEN' });
    expect(await rows(`SELECT 1 FROM crove_kernel.proposal WHERE org_id = $1 AND command = 'finance.payroll_posting.record' AND status = 'pending'`, [o.orgId])).toHaveLength(1);
  });

  it('refuses a run holding an adjustment line, and one whose stored lines have no employment on record', async () => {
    const o = await org();
    const [first] = await rows<{ id: string }>(`SELECT id FROM crove_hr.payroll_employee WHERE org_id = $1 ORDER BY created_at, id LIMIT 1`, [o.orgId]);
    const march = await approvedRun(o);
    // A correction of March, in an April run: the run carries an adjustment line, which is not posted yet.
    const april = await approvedRun(o, '2026-04', async (runId) => {
      await o.exec(o.owner, 'hr.payroll.line.adjust', { runId, adjustsRunId: march.runId, employeeId: first?.id, note: 'Tính thiếu tiền làm thêm giờ', gross: '500000', pit: '25000' });
    });
    await expect(ask(o, april.runId)).rejects.toMatchObject({ code: 'HR_POSTING_ADJUSTMENTS' });
    // A stored line that lost its employment (a raw session that lifts the freeze of an approved run, outside the commands) has no cost department on record: refused, never read as administration.
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('ALTER TABLE crove_hr.payroll_line DISABLE TRIGGER frozen_row');
      await c.query(`UPDATE crove_hr.payroll_line SET employment_id = NULL WHERE org_id = $1 AND run_id = $2 AND id = (SELECT id FROM crove_hr.payroll_line WHERE org_id = $1 AND run_id = $2 ORDER BY id LIMIT 1)`, [o.orgId, march.runId]);
      await c.query('ALTER TABLE crove_hr.payroll_line ENABLE TRIGGER frozen_row');
      await c.query('COMMIT');
    });
    await expect(ask(o, march.runId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
  });

  it('refuses a posting whose entity changed its chart after the request (HR_POSTING_MISMATCH), and one into a month that is closed (PERIOD_LOCKED)', async () => {
    const o = await org('tt133');
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId);
    // The entity moves to TT99 books from the start of the year after the proposal was made: the entry was built for the TT133 chart.
    await withAdmin((c) =>
      c.query(
        `INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from)
         SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`,
        [o.orgId],
      ),
    );
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
    // A new request builds the entry again for the TT99 chart; closing the month then refuses its posting.
    await o.exec(o.owner, 'kernel.proposal.reject', { id: proposalId });
    const again = await ask(o, runId);
    await rt.execute('finance.period.lock', { month: MONTH }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(approve(o, again.proposalId)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(0);
  });

  it('counts the person who approved the run as a co-author of its posting: they do not approve it while another may (#2736)', async () => {
    const o = await org('tt133', 'trio');
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    const [stored] = await rows<{ authors: { id: string }[]; co_authors: string[] }>('SELECT authors, co_authors FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]);
    // The requester alone is an author; the run's approver is the co-author the preparer declared.
    expect(stored?.authors.map((a) => a.id)).toEqual([o.admin]);
    expect(stored?.co_authors).toEqual([o.owner]);
    // The run's approver (the owner) and the requester (an admin) are refused; the other admin approves, and the Inbox offers Approve to that admin only.
    const canApprove = async (user: string) => (await rt.query<{ canApprove: boolean }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId })).canApprove;
    expect(await canApprove(o.owner)).toBe(false);
    expect(await canApprove(o.admin)).toBe(false);
    expect(await canApprove(o.admin2)).toBe(true);
    // The Inbox tells the run's approver why in their own words (they are a co-author), and nobody else.
    const coAuthorOf = async (user: string) => (await rt.query<{ coAuthor: boolean }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId })).coAuthor;
    expect([await coAuthorOf(o.owner), await coAuthorOf(o.admin), await coAuthorOf(o.admin2)]).toEqual([true, false, false]);
    // The request names the co-author in its audit row.
    const [requested] = await rows<{ co: string[] | null }>(`SELECT detail -> 'co_authors' AS co FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.request' AND detail ->> 'proposal_id' = $2`, [o.orgId, proposalId]);
    expect(requested?.co).toEqual([o.owner]);
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    await expect(approve(o, proposalId, o.admin2)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('keeps the one-person path: a lone owner who approved the run asks for and approves its posting, flagged self-approved', async () => {
    const o = await org('tt133', 'solo');
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.owner);
    await expect(approve(o, proposalId, o.owner)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    const [audit] = await rows<{ self_approved: string }>(`SELECT detail ->> 'self_approved' AS self_approved FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.approve'`, [o.orgId]);
    expect(audit?.self_approved).toBe('true');
  });

  it('declares the run approver again when an expired posting proposal is asked for again', async () => {
    const o = await org('tt133', 'trio');
    const { runId } = await approvedRun(o);
    const first = await ask(o, runId, o.admin);
    await rows(`UPDATE crove_kernel.proposal SET status = 'expired', decided_at = now() WHERE org_id = $1 AND id = $2`, [o.orgId, first.proposalId]);
    const again = await rt.execute<{ proposalId: string }>('kernel.proposal.resubmit', { id: first.proposalId }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    const [stored] = await rows<{ co_authors: string[] }>('SELECT co_authors FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, again.proposalId]);
    expect(stored?.co_authors).toEqual([o.owner]);
    await expect(approve(o, again.proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
  });

  it('rebuilds the entry from the frozen run when it records, and refuses a stored proposal that differs from it in any line', async () => {
    const o = await org();
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    // A proposal row written some other way than by the preparer (raw SQL, staff here): the first two lines swap their accounts, still balanced and valid as a voucher.
    await rows(
      `UPDATE crove_kernel.proposal
          SET payload = jsonb_set(jsonb_set(payload, '{lines,0,account}', payload #> '{lines,1,account}'), '{lines,1,account}', payload #> '{lines,0,account}')
        WHERE org_id = $1 AND id = $2`,
      [o.orgId, proposalId],
    );
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    await expect(rt.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
    // Nothing was posted and the proposal still waits (a new request is refused as open until it is rejected).
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
  });

  it('lets a chief accountant who is a member approve a posting from its totals, and resolves the stuck org of #2744 under the accountant preset (#2751)', async () => {
    const o = await org('tt133', 'trio');
    // A chief accountant who is a plain member, holding the ledger's approval permission org-wide: payroll lines are not theirs to read, the totals by account are.
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrposting', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, chief]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    // The owner froze the run, so they are a co-author of the posting and held back while another may approve (the chief counts as eligible).
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    // The chief approves: the HR module rebuilds the entry from the run's totals by cost department for them, so no owner or admin has to.
    const posted = await approve(o, proposalId, chief);
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(1);
    expect(posted.journalEntryId).toEqual(expect.any(String));
  });

  it('resolves the stuck org: under the accountant preset the owner who froze the run and the admin who asked cannot approve, and the member chief accountant does', async () => {
    const o = await org('tt133', 'standard');
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrposting', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, chief]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    await rt.execute('kernel.org.set_approval_preset', { preset: 'accountant' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    await expect(approve(o, proposalId, o.owner)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(approve(o, proposalId, chief)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('refuses a member without the approval permission and a viewer: they cannot approve, and the totals function refuses them in the database', async () => {
    const o = await org('tt133', 'trio');
    const viewer = await upsertIdentity(createDb(pool), { issuer: 'hrposting', subject: `viewer-${randomUUID()}`, email: `viewer-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [o.orgId, viewer]));
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(approve(o, proposalId, viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The verification itself refuses them too, whatever the approval policy says: a member and a viewer are refused by the command and by the database function.
    await expect(o.exec(o.member, 'hr.payroll.posting.verify', { runId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(o.exec(viewer, 'hr.payroll.posting.verify', { runId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(0);
  });

  it('returns no per-person field from the verification and the totals function: the same entry as the proposal, by cost department only', async () => {
    const o = await org('tt133', 'trio');
    // An advance and a damage deduction on people of two cost departments, so the per-department sums carry them.
    const { runId } = await approvedRun(o, MONTH, async (id) => {
      const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: id });
      const [first, second] = sheet.lines;
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: (first as HrRunSheet['lines'][number]).id, inputs: { ...(first as HrRunSheet['lines'][number]).inputs, advance: '500000' } });
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: (second as HrRunSheet['lines'][number]).id,
        inputs: { ...(second as HrRunSheet['lines'][number]).inputs, deductions: [{ label: 'Đền bù', kind: 'damage', amount: '300000' }] },
      });
    });
    const { proposalId } = await ask(o, runId, o.admin);
    const verified = await o.exec<{ lines: { account: string; debit: string; credit: string }[] }>(o.owner, 'hr.payroll.posting.verify', { runId });
    expect(JSON.stringify(verified)).not.toMatch(/canary/i);
    expect(Object.keys(verified).sort()).toEqual(['approvedBy', 'date', 'legalEntityId', 'lines', 'month', 'regime', 'runId']);
    // The verification equals the entry the preparer built from the people's lines (the same run, two readings).
    const [stored] = await rows<{ payload: { lines: { account: string; debit: string; credit: string }[] } }>(`SELECT payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [o.orgId, proposalId]);
    const proposed = (stored?.payload.lines ?? []).map((l) => `${l.account}:${l.debit}:${l.credit}`).sort();
    expect(verified.lines.map((l) => `${l.account}:${l.debit}:${l.credit}`).sort()).toEqual(proposed);
  });

  it("refuses a stored proposal that names another entity than the run's, or does not list the run's approver as a co-author", async () => {
    const o = await org('tt133', 'trio');
    // A second legal entity of the org, and two runs (one proposal each is tampered with, the run's own stay as made).
    const [branch] = await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [o.orgId, o.owner]);
    const { runId } = await approvedRun(o);
    const { proposalId } = await ask(o, runId, o.admin);
    const approveBy = async (user: string) => {
      const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
      return rt.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
    };
    // The proposal names the branch while the run belongs to the default entity (raw SQL, staff here): refused before anything posts.
    await rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, [o.orgId, proposalId, branch?.id]);
    await expect(approveBy(o.admin2)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'legalEntityId' } });
    // Put the entity back; now the run's approver (the owner) is removed from the co-authors, which would let them approve: refused as not made by the preparer.
    await rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb(legal_entity_id::text)), co_authors = NULL WHERE org_id = $1 AND id = $2`, [o.orgId, proposalId]);
    await expect(approveBy(o.owner)).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'coAuthors' } });
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
  });
});
