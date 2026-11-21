// SPDX-License-Identifier: AGPL-3.0-only
// The security rules of the payment vouchers of a posted pay run (#2532, payroll plan 6.4, ADR-0046; they ride the finance proposal path) on a real PostgreSQL 17, as the real login roles:
// - only an owner or an admin approves a payment: a member who holds the approval permission (a chief accountant) is told so and the proposal stays pending, nothing recorded;
// - the person who approved the run is a co-author of its payment and is held back while another eligible approver exists; a stored proposal that lost the co-author is refused;
// - a cash payment of the net pay carries a flag when a net pay is 5 million or more, and the flag keeps it out of a bulk approval: approve_many refuses it (BULK_NOT_ALLOWED), it stays pending and no
//   voucher is recorded; the flag is rebuilt when the payment records, so a proposal written without it is refused;
// - one voucher per run and kind is a fact of the table: a voucher that names a run needs a kind, a proposal and a payment type, and a second of the same kind is refused;
// - one live posting voucher per run is a fact of the table (#2931, #2939, crove_finance.journal_voucher_payroll_slot): a second live posting voucher of one run is refused with 23505
//   (journal_voucher_payroll_run_uq), a reversed posting entry frees the slot so a new live posting is accepted, and the new one holds the run again across concurrent writers and entity scopes.
// Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside test/invariant/). The product flow of the payments is in hr-payroll-payment.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HrRunSheet, HrRunWritten, HrWritten } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { PAYROLL_POSTING_MAPS, PAYROLL_RULES } from '@ludy/l10n-vn';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

// Every rule of the shipped set, and every account map of the posting, is `commentary` until the accountant confirms it (#2535), so a real approval or posting cannot pass yet: the tests confirm the
// rows for themselves (see hr-payroll-run), and one test leaves the maps as shipped to show the posting is refused.
vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
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
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    pool = createDbPool({ connectionString: url.toString(), max: 4 }, dbIds);
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

  it('lets a member holding the approval permission approve a payment from the run\'s totals, and refuses a member without it and a viewer, nothing recorded for them (#2751)', async () => {
    const o = await org('tt133', 'trio');
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    const viewer = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `viewer-${randomUUID()}`, email: `viewer-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [o.orgId, chief, viewer]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    const { runId } = await postedRun(o, 'trio');
    const { proposalId } = await pay(o, runId, 'tax', {}, o.admin);
    // A plain member and a viewer cannot approve, and the verification of the payment refuses them whatever the approval policy says.
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(approve(o, proposalId, viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(o.exec(o.member, 'hr.payroll.payment.verify', { runId, kind: 'tax' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(o.exec(viewer, 'hr.payroll.payment.verify', { runId, kind: 'tax' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await voucherOf(o, runId, 'tax')).toHaveLength(0);
    // The chief holds the approval permission: the verification reads the totals by cost department, no person, and they approve.
    const verified = await o.exec<{ lines: unknown[]; total: string }>(chief, 'hr.payroll.payment.verify', { runId, kind: 'tax' });
    expect(Object.keys(verified).sort()).toEqual(['approvedBy', 'cashLarge', 'kind', 'legalEntityId', 'lines', 'month', 'regime', 'runId', 'total']);
    expect(JSON.stringify(verified)).not.toMatch(/canary/i);
    await expect(approve(o, proposalId, chief)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    expect(await voucherOf(o, runId, 'tax')).toHaveLength(1);
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

  // The totals function called directly in a user's (or the system's) context as the real login roles, so its own gate is exercised, not only the command's.
  const callTotals = async (who: { kind: 'user'; userId: string } | { kind: 'system' }, orgId: string, runId: string) => {
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName(who.kind === 'user' ? 'crove_app' : 'crove_worker') : (who.kind === 'user' ? 'crove_app' : 'crove_worker');
    url.password = who.kind === 'user' ? 'test-app-pw' : 'test-worker-pw';
    const c = createDbClient({ connectionString: url.toString() }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      if (who.kind === 'user') await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(who.userId, orgId)]);
      else await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      const { rows } = await c.query<{ totals: Record<string, unknown> | null }>('SELECT crove_hr.payroll_run_totals($1::uuid) AS totals', [runId]);
      return { ok: true as const, totals: rows[0]?.totals ?? null };
    } catch (error) {
      return { ok: false as const, code: (error as { code?: string }).code };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  };

  it('answers the totals function to an owner, an admin and a member holding the approval permission only, with totals by cost department and no person (#2751)', async () => {
    const o = await org('tt133', 'trio');
    const chief = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    const viewer = await upsertIdentity(createDb(pool), { issuer: 'hrpayment', subject: `viewer-${randomUUID()}`, email: `viewer-${randomUUID().slice(0, 6)}@hr.test`, name: null });
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [o.orgId, chief, viewer]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [o.orgId, chief, o.owner]);
    });
    const { runId } = await postedRun(o, 'trio');
    for (const [label, userId] of [['owner', o.owner], ['admin', o.admin], ['chief accountant', chief]] as const) {
      const answer = await callTotals({ kind: 'user', userId }, o.orgId, runId);
      expect(answer.ok, label).toBe(true);
      const totals = (answer as { totals: Record<string, unknown> | null }).totals;
      expect(Object.keys(totals ?? {}).sort(), label).toEqual(['approvalTotals', 'approvedBy', 'counts', 'groups', 'legalEntityId', 'month', 'runId', 'status']);
      // By cost department: no name, no employee or line id anywhere in the answer.
      expect(JSON.stringify(totals), label).not.toMatch(/canary|employee_?id|line_?id/i);
      const groups = (totals?.groups ?? []) as { payFunction: string }[];
      expect(groups.map((g) => g.payFunction).sort(), label).toEqual(['admin', 'production', 'sales']);
    }
    // A plain member, a viewer and the system context are refused by the function itself.
    expect(await callTotals({ kind: 'user', userId: o.member }, o.orgId, runId)).toEqual({ ok: false, code: '42501' });
    expect(await callTotals({ kind: 'user', userId: viewer }, o.orgId, runId)).toEqual({ ok: false, code: '42501' });
    expect(await callTotals({ kind: 'system' }, o.orgId, runId)).toMatchObject({ ok: false });
  });

  it('shows another org\'s run to nobody, and a draft run only as its status: no figure before approval (#2751)', async () => {
    const a = await org('tt133', 'solo');
    const b = await org('tt133', 'solo');
    const { runId } = await approvedRun(a);
    // The owner of another org asks for this run: it is not theirs, so the answer is nothing.
    expect(await callTotals({ kind: 'user', userId: b.owner }, b.orgId, runId)).toEqual({ ok: true, totals: null });
    const draft = await a.exec<HrRunWritten>(a.owner, 'hr.payroll.run.open', { month: '2026-02' });
    const answer = await callTotals({ kind: 'user', userId: a.owner }, a.orgId, draft.runId as string);
    expect(answer).toEqual({ ok: true, totals: { runId: draft.runId, status: 'draft' } });
  });

  // Two lines of one cost department, each wrong by an opposite amount: the department's total is right, so only a per-line check can see it. Written by staff with the frozen-run guard off for the
  // moment (an approved run is frozen against every tenant role), as a database corruption or a forged row would be.
  async function tamperTwoLines(o: Org, runId: string, how: 'net' | 'funds') {
    await withAdmin(async (c) => {
      await c.query('ALTER TABLE crove_hr.payroll_line DISABLE TRIGGER frozen_row');
      try {
        const { rows } = await c.query<{ id: string }>(
          `SELECT l.id FROM crove_hr.payroll_line l JOIN crove_hr.payroll_employment e ON e.org_id = l.org_id AND e.id = l.employment_id
            WHERE l.org_id = $1 AND l.run_id = $2 AND e.pay_function = 'admin' ORDER BY l.id LIMIT 2`,
          [o.orgId, runId],
        );
        expect(rows).toHaveLength(2);
        const [up, down] = rows as [{ id: string }, { id: string }];
        if (how === 'net') {
          await c.query('UPDATE crove_hr.payroll_line SET net = net + 1000 WHERE org_id = $1 AND id = $2', [o.orgId, up.id]);
          await c.query('UPDATE crove_hr.payroll_line SET net = net - 1000 WHERE org_id = $1 AND id = $2', [o.orgId, down.id]);
        } else {
          // The first fund of each line moves by 1000 in opposite directions: each line's split no longer adds to its own insurance.
          await c.query(
            `UPDATE crove_hr.payroll_line SET breakdown = jsonb_set(breakdown, '{insurance,funds,0,employee}', to_jsonb((((breakdown #>> '{insurance,funds,0,employee}')::numeric) + 1000)::text)) WHERE org_id = $1 AND id = $2`,
            [o.orgId, up.id],
          );
          await c.query(
            `UPDATE crove_hr.payroll_line SET breakdown = jsonb_set(breakdown, '{insurance,funds,0,employee}', to_jsonb((((breakdown #>> '{insurance,funds,0,employee}')::numeric) - 1000)::text)) WHERE org_id = $1 AND id = $2`,
            [o.orgId, down.id],
          );
        }
      } finally {
        await c.query('ALTER TABLE crove_hr.payroll_line ENABLE ALWAYS TRIGGER frozen_row');
      }
    });
  }

  it('refuses a run whose lines are wrong by opposite amounts in one department: the sums agree, the per-line count does not, and neither the verification nor the payment record passes (#2751)', async () => {
    for (const how of ['net', 'funds'] as const) {
      const o = await org('tt133', 'solo');
      // A second person of the same cost department (admin), so two lines can cancel in its total.
      await o.exec(o.owner, 'hr.payroll.employee.add', {
        displayName: 'Phạm Văn Hai Canary',
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '12000000' },
      });
      const { runId } = await postedRun(o);
      const verifiedBefore = await o.exec<{ lines: unknown[] }>(o.owner, 'hr.payroll.posting.verify', { runId });
      expect(verifiedBefore.lines.length, how).toBeGreaterThan(0);
      const { proposalId } = await pay(o, runId, 'tax');
      await tamperTwoLines(o, runId, how);
      // The department's totals are unchanged by the two opposite errors; the database counts the broken lines, so the verification and the payment verification refuse.
      await expect(o.exec(o.owner, 'hr.payroll.posting.verify', { runId }), how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'toàn vẹn dòng lương' } });
      await expect(o.exec(o.owner, 'hr.payroll.payment.verify', { runId, kind: 'tax' }), how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: 'toàn vẹn dòng lương' } });
      // A payment proposal asked for before the tampering cannot be approved after it, and nothing is recorded.
      await expect(approve(o, proposalId), how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
      expect(await voucherOf(o, runId, 'tax'), how).toHaveLength(0);
    }
  });

  // A breakdown with a missing key reads as NULL in SQL, and NULL must count as malformed, never as well formed: the run is refused as a missing list, not passed over.
  it('refuses a run with a line whose breakdown lost a deduction key or a fund\'s employee amount: the counts see it, both verifications and the payment record refuse, nothing recorded (#2751)', async () => {
    const cases = [
      { how: 'deductions', sql: `UPDATE crove_hr.payroll_line SET breakdown = breakdown #- '{deductions,damage}' WHERE org_id = $1 AND id = $2`, what: 'thiếu các khoản khấu trừ' },
      { how: 'fund', sql: `UPDATE crove_hr.payroll_line SET breakdown = breakdown #- '{insurance,funds,0,employee}' WHERE org_id = $1 AND id = $2`, what: 'thiếu chi tiết bảo hiểm' },
    ] as const;
    for (const c of cases) {
      const o = await org('tt133', 'solo');
      const { runId } = await postedRun(o);
      const { proposalId } = await pay(o, runId, 'tax');
      await withAdmin(async (db) => {
        await db.query('ALTER TABLE crove_hr.payroll_line DISABLE TRIGGER frozen_row');
        try {
          const { rows } = await db.query<{ id: string }>(`SELECT id FROM crove_hr.payroll_line WHERE org_id = $1 AND run_id = $2 AND kind = 'pay' ORDER BY id LIMIT 1`, [o.orgId, runId]);
          expect(rows, c.how).toHaveLength(1);
          await db.query(c.sql, [o.orgId, (rows[0] as { id: string }).id]);
        } finally {
          await db.query('ALTER TABLE crove_hr.payroll_line ENABLE ALWAYS TRIGGER frozen_row');
        }
      });
      await expect(o.exec(o.owner, 'hr.payroll.posting.verify', { runId }), c.how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: c.what } });
      await expect(o.exec(o.owner, 'hr.payroll.payment.verify', { runId, kind: 'tax' }), c.how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH', details: { what: c.what } });
      await expect(approve(o, proposalId), c.how).rejects.toMatchObject({ code: 'HR_POSTING_MISMATCH' });
      expect(await voucherOf(o, runId, 'tax'), c.how).toHaveLength(0);
    }
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

  it('holds one live posting voucher per run in the table: refuses a second live posting (23505, journal_voucher_payroll_run_uq), accepts a new one once the earlier entry is reversed, and holds the run again (#2931, #2939)', async () => {
    const o = await org('tt133', 'standard');
    const branch = await withAdmin(async (c) => {
      const { rows: inserted } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`,
        [o.orgId, o.owner],
      );
      const branchId = inserted[0]?.id as string;
      // Scope o.member to the branch entity alone: RLS hides the default entity's vouchers and entries from them, and the branch has its own voucher number series.
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [o.orgId, o.member, branchId, o.owner],
      );
      return branchId;
    });
    const { runId } = await approvedRun(o);
    const appClient = () => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
      url.password = 'test-app-pw';
      return createDbClient({ connectionString: url.toString() }, dbIds);
    };
    const approvedPostingProposal = (entityId: string | null = null, decider = o.owner) =>
      withAdmin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, decided_by, decided_at, executed_command_id, legal_entity_id)
               VALUES ($1, 'test.payroll_posting', 'finance.payroll_posting.record', 'approved', 'T2939', '{"n": 1}', ARRAY[$2::uuid], '[]', $2::uuid, now(), gen_random_uuid(),
                       COALESCE($3::uuid, (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = $1 AND e.is_default))) RETURNING id`,
              [o.orgId, decider, entityId],
            )
          ).rows[0]?.id as string,
      );
    const insertAsUser = async (userId: string, proposalId: string | null, targetRunId = runId, entityId: string | null = null) => {
      const c = appClient();
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(userId, o.orgId)]);
        await c.query(
          `INSERT INTO crove_finance.journal_voucher (org_id, legal_entity_id, voucher_date, description, proposal_id, payroll_run_id)
           VALUES ($1, COALESCE($4::uuid, (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = $1 AND e.is_default)), '2026-03-31', 'Hạch toán lương', $2, $3)`,
          [o.orgId, proposalId, targetRunId, entityId],
        );
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    const reversePosting = async (entryId: string) => {
      const revAsk = await rt.execute<{ proposalId: string }>(
        'kernel.proposal.request',
        { command: 'finance.journal.reverse', input: { entryId, entryDate: '2026-03-31', reason: 'Lập lại bảng lương' } },
        { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
      await approve(o, revAsk.proposalId, o.owner);
    };

    // A posting voucher that names a run must carry a proposal and no closing or stock tag (journal_voucher_payroll_run).
    await expect(insertAsUser(o.owner, null)).rejects.toMatchObject({ code: '23514', constraint: 'journal_voucher_payroll_run' });
    await expect(
      rows(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id, closing_year)
         VALUES ($1, '2026-03-31', 'Hạch toán lương', $2, $3, 2026)`,
        [o.orgId, await approvedPostingProposal(), runId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'journal_voucher_payroll_run' });

    // 1. Recording the first live posting voucher of the run succeeds (admin asks, owner approves under four-eyes).
    const firstAsk = await ask(o, runId, o.admin);
    const first = await approve(o, firstAsk.proposalId, o.owner);
    expect(await rows('SELECT id FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(1);

    // 2. While the first posting voucher is live (unreversed), a second live posting voucher for the same run is refused
    // in the command and by crove_finance.journal_voucher_payroll_slot (for staff, for the owner on crove_app, and for a branch-scoped member blind to the first voucher under RLS).
    const insertStaffCopy = (sourceId: string) =>
      rows(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id)
         SELECT org_id, voucher_date, description, proposal_id, payroll_run_id FROM crove_finance.journal_voucher WHERE id = $1`,
        [sourceId],
      );
    await expect(ask(o, runId, o.admin)).rejects.toMatchObject({ code: 'HR_POSTING_DONE' });
    await expect(insertStaffCopy(first.voucherId)).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
    await expect(insertAsUser(o.owner, await approvedPostingProposal())).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
    await expect(insertAsUser(o.member, await approvedPostingProposal(branch, o.member), runId, branch)).rejects.toMatchObject({
      code: '23505',
      constraint: 'journal_voucher_payroll_run_uq',
    });
    // Another run's slot is independent.
    await expect(insertAsUser(o.owner, await approvedPostingProposal(), randomUUID())).resolves.toBeUndefined();

    // 3. Once the first posting entry is reversed, a new live posting voucher for the same run is accepted,
    // and another live one after it is again refused with 23505 / journal_voucher_payroll_run_uq.
    await reversePosting(first.journalEntryId);
    const secondAsk = await ask(o, runId, o.admin);
    const second = await approve(o, secondAsk.proposalId, o.owner);
    expect(second.voucherId).not.toBe(first.voucherId);
    expect(await rows('SELECT id FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(2);
    await expect(ask(o, runId, o.admin)).rejects.toMatchObject({ code: 'HR_POSTING_DONE' });
    await expect(insertStaffCopy(second.voucherId)).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
    await expect(insertAsUser(o.owner, await approvedPostingProposal())).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });

    // 4. After reversing again, two concurrent writers on crove_app across distinct legal entities (distinct number series, so only the slot's advisory lock holds them)
    // serialize on crove_finance.journal_voucher_payroll_slot: a voucher before its entry counts as live, the first writer commits, and the waiting third live attempt is refused.
    await reversePosting(second.journalEntryId);
    const [propA1, propA2, propB] = await Promise.all([
      approvedPostingProposal(),
      approvedPostingProposal(),
      approvedPostingProposal(branch, o.member),
    ]);
    const lines = JSON.stringify([
      { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
      { line_no: 2, account_code: '334', debit: '0', credit: '100000' },
    ]);
    const writerA = appClient();
    const writerB = appClient();
    await Promise.all([writerA.connect(), writerB.connect()]);
    try {
      await writerA.query('BEGIN');
      await writerA.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]);
      const insertedA = await writerA.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id)
         VALUES ($1, '2026-03-31', 'Hạch toán lương', $2, $3) RETURNING id`,
        [o.orgId, propA1, runId],
      );
      // Even before writerA posts its journal_entry, a voucher with no entry counts as live and holds the slot.
      await writerA.query('SAVEPOINT before_entry');
      await expect(
        writerA.query(
          `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payroll_run_id)
           VALUES ($1, '2026-03-31', 'Hạch toán lương', $2, $3)`,
          [o.orgId, propA2, runId],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
      await writerA.query('ROLLBACK TO SAVEPOINT before_entry');
      await writerA.query(`SELECT crove_finance.post_journal_entry('2026-03-31'::date, 'Hạch toán lương', 'finance.journal_voucher', $1::uuid, $2::jsonb)`, [
        insertedA.rows[0]?.id,
        lines,
      ]);

      await writerB.query('BEGIN');
      await writerB.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.member, o.orgId)]);
      // Under RLS, the branch-scoped member sees zero vouchers in the default entity, yet the definer trigger still serializes and sees the live slot.
      expect(
        (await writerB.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).rows[0]?.n,
      ).toBe(0);
      let bSettled = false;
      const bAttempt = writerB
        .query(
          `INSERT INTO crove_finance.journal_voucher (org_id, legal_entity_id, voucher_date, description, proposal_id, payroll_run_id)
           VALUES ($1, $2, '2026-03-31', 'Hạch toán lương', $3, $4)`,
          [o.orgId, branch, propB, runId],
        )
        .finally(() => {
          bSettled = true;
        });
      bAttempt.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(bSettled).toBe(false);

      await writerA.query('COMMIT');
      await expect(bAttempt).rejects.toMatchObject({ code: '23505', constraint: 'journal_voucher_payroll_run_uq' });
      expect(bSettled).toBe(true);
    } finally {
      await Promise.all([writerA, writerB].map((c) => c.query('ROLLBACK').catch(() => {})));
      await Promise.all([writerA.end(), writerB.end()]);
    }
    expect(await rows('SELECT id FROM crove_finance.journal_voucher WHERE org_id = $1 AND payroll_run_id = $2', [o.orgId, runId])).toHaveLength(3);
  });

  it('pins expected runtime-role grants and immutable identity columns on crove_hr tables (#2720)', async () => {
    const EXPECTED_HR_TABLE_GRANTS: Record<string, readonly string[]> = {
      candidate: ['INSERT', 'SELECT'],
      department: ['INSERT', 'SELECT'],
      job_opening: ['INSERT', 'SELECT'],
      payroll_bank_template: ['DELETE', 'INSERT', 'SELECT'],
      payroll_dependent: ['INSERT', 'SELECT'],
      payroll_employee: ['INSERT', 'SELECT'],
      payroll_employment: ['INSERT', 'SELECT'],
      payroll_leave_entry: ['DELETE', 'INSERT', 'SELECT'],
      payroll_line: ['DELETE', 'INSERT', 'SELECT'],
      payroll_run: ['INSERT', 'SELECT'],
    };
    const TENANT_ROLES = ['crove_app', 'crove_definer_tenant', 'crove_tenant', 'crove_worker'];
    const ALL_OPS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];

    const found = await rows<{ relname: string; role: string; ops: string[] }>(
      `SELECT c.relname,
              r.rolname AS role,
              ARRAY(
                SELECT op
                  FROM pg_catalog.unnest($3::text[]) AS op
                 WHERE pg_catalog.has_table_privilege(r.oid, c.oid, op)
                 ORDER BY op
              ) AS ops
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN pg_catalog.pg_roles r
        WHERE n.nspname = 'crove_hr'
          AND c.relname = ANY($1::text[])
          AND r.rolname = ANY($2::text[])
        ORDER BY 1, 2`,
      [Object.keys(EXPECTED_HR_TABLE_GRANTS), [...TENANT_ROLES, 'crove_auth_reader'], ALL_OPS],
    );
    expect(new Set(found.map((r) => r.relname))).toEqual(new Set(Object.keys(EXPECTED_HR_TABLE_GRANTS)));
    for (const row of found) {
      if (row.role === 'crove_auth_reader') {
        expect(row.ops, `${row.role} on crove_hr.${row.relname}`).toEqual([]);
      } else {
        expect(row.ops, `${row.role} on crove_hr.${row.relname}`).toEqual(EXPECTED_HR_TABLE_GRANTS[row.relname]);
      }
    }

    // Employment terms are append-only (no column UPDATE), and pay run / line identity and adjustment target columns are never updatable by tenant roles.
    const forbiddenColumnUpdates = await rows<{ relname: string; attname: string; role: string }>(
      `SELECT c.relname, a.attname, r.rolname AS role
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         CROSS JOIN pg_catalog.pg_roles r
        WHERE n.nspname = 'crove_hr'
          AND r.rolname = ANY($1::text[])
          AND pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')
          AND (
            c.relname = 'payroll_employment'
            OR (c.relname = 'payroll_run' AND a.attname IN ('org_id', 'id', 'legal_entity_id', 'month', 'created_by', 'created_at'))
            OR (c.relname = 'payroll_line' AND a.attname IN ('org_id', 'id', 'legal_entity_id', 'run_id', 'employee_id', 'kind', 'adjusts_run_id', 'note', 'created_by', 'created_at'))
          )
        ORDER BY 1, 2, 3`,
      [[...TENANT_ROLES, 'crove_auth_reader']],
    );
    expect(forbiddenColumnUpdates).toEqual([]);
  });
});
