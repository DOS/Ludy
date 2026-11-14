// SPDX-License-Identifier: AGPL-3.0-only
// The four signals reads over MCP, in the sealed context of a grant (Vy V4 and V5, #2967 and #2969, step S2), on PostgreSQL 17: an owner's or admin's company grant and a member-bound grant of a member
// with the whole org in view get the same answers as the person's own session; a member-bound grant of a branch-limited member is refused by the two finance reads with SIGNAL_PARTIAL_VIEW (never the
// part of the books in view) while the CRM reads answer; a grant without the scope, a revoked grant and a demoted grantor reach nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE, vietnamToday, type Deal, type PipelineStage } from '@crove/kernel-contract';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { addDays, financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const RULES = ['kernel.signals.deal_without_invoice', 'kernel.signals.receivable_with_open_deal', 'kernel.signals.supplier_bank_changed', 'kernel.signals.conversation_unanswered'] as const;
const READS = ['crm.signals.won_deals', 'crm.signals.open_deals', 'finance.signals.sales', 'finance.signals.overdue_receivables'] as const;

suite('the signals reads over MCP (#2967, #2969, step S2)', () => {
  const dbName = `crove_test_signals_mcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let orgId = '';
  let entity = '';
  let partyIds: string[] = [];
  const users = { owner: '', admin: '', member: '', branchMember: '' };
  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string, kind: 'company' | 'member', scopes: string[] = ['ludy.read']): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal1',
    mcp: { grantId, clientId: 'client', clientName: 'Test client', scopes, kind },
  });
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  let counter = 0;
  async function grant(userId: string, over: { kind?: 'company' | 'member'; revoked?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const kind = over.kind ?? 'company';
    counter += 1;
    await rows(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', ${over.revoked ? 'now()' : 'NULL'}, $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
      [orgId, id, userId, `client-${counter}-${id}`, `oauth-${id}`, kind],
    );
    return id;
  }
  const input = (read: string) => (read.startsWith('finance.') ? { partyIds } : {});
  const run = (actor: UserActor, read: string) => rt.query<unknown[]>(read, input(read), { actor, orgId });
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...financeQueries],
    });
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = (await upsertIdentity(db, { issuer: 'signals-mcp', subject: key, email: `${key}@signals-mcp.test`, name: null })) as string;
    orgId = (await createOrg(rt, browser(users.owner), 'Org A')).orgId;
    entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, users.owner]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')", [orgId, users.admin, users.member, users.branchMember]);
    await rows('UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1', [orgId]);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, users.branchMember, branch, users.owner]);
    // Party A: a deal won 8 days ago, no invoice. Party B: an open deal and an invoice 40 days old (overdue). Party C: a deal won 8 days ago with an invoice after the win.
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const [a, b, c] = [await party('A'), await party('B'), await party('C')];
    partyIds = [a, b, c];
    const exec = <T>(command: string, body: unknown) => rt.execute<T>(command, body, { actor: browser(users.owner), orgId });
    const won = ((await exec<PipelineStage[]>('crm.pipeline.setup', {})).find((s) => s.name === 'Thắng') as PipelineStage).id;
    for (const [partyId, days] of [[a, 8], [c, 8]] as const) {
      const deal = await exec<Deal>('crm.deal.create', { partyId, title: 'x', amount: '1000000', expectedClose: null });
      await exec('crm.deal.move', { dealId: deal.id, version: deal.version, stageId: won });
      await rows("UPDATE crove_crm.deal SET closed_at = now() - make_interval(days => $3) WHERE org_id = $1 AND id = $2", [orgId, deal.id, days]);
    }
    await exec('crm.deal.create', { partyId: b, title: 'y', amount: '2000000', expectedClose: null });
    const sale = (partyId: string, number: string, date: string) =>
      admin(async (cl) => {
        const doc = randomUUID();
        await cl.query('BEGIN');
        await cl.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', 1000000, 0, 1000000, 'sale', $6)`,
          [orgId, doc, partyId, number, date, entity],
        );
        const entry = randomUUID();
        await cl.query(`INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'HĐ', 'finance.purchase_document', $4, $5)`, [orgId, entry, date, doc, entity]);
        await cl.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', 1000000, 0, $3, $4), ($1, $2, 2, '511', 0, 1000000, NULL, $4)`, [orgId, entry, partyId, entity]);
        await cl.query('COMMIT');
      });
    await sale(b, '1', addDays(TODAY, -40));
    await sale(c, '2', addDays(TODAY, -2));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers a company grant of an owner and of an admin as the person\'s own session, on every read, and the seeded data is there to see', async () => {
    for (const userId of [users.owner, users.admin]) {
      const g = await grant(userId, { kind: 'company' });
      for (const read of READS) expect(await run(mcp(userId, g, 'company'), read), `${read} for ${userId}`).toEqual(await run(browser(userId), read));
    }
    const g = await grant(users.owner);
    expect(await run(mcp(users.owner, g, 'company'), 'crm.signals.won_deals')).toHaveLength(2);
    expect(await run(mcp(users.owner, g, 'company'), 'crm.signals.open_deals')).toHaveLength(1);
    expect(await run(mcp(users.owner, g, 'company'), 'finance.signals.sales')).toHaveLength(2);
    expect(await run(mcp(users.owner, g, 'company'), 'finance.signals.overdue_receivables')).toHaveLength(1);
  });

  it('answers a member-bound grant of a member with the whole org in view as the member\'s own session', async () => {
    const g = await grant(users.member, { kind: 'member' });
    for (const read of READS) expect(await run(mcp(users.member, g, 'member'), read), read).toEqual(await run(browser(users.member), read));
  });

  it('refuses the two finance reads, and answers the CRM reads, for a member-bound grant of a branch-limited member', async () => {
    const g = await grant(users.branchMember, { kind: 'member' });
    const actor = mcp(users.branchMember, g, 'member');
    for (const read of ['finance.signals.sales', 'finance.signals.overdue_receivables']) {
      const error = await refusal(run(actor, read));
      expect(error.code, read).toBe(SIGNAL_PARTIAL_VIEW_CODE);
    }
    expect(await run(actor, 'crm.signals.won_deals')).toHaveLength(2);
    expect(await run(actor, 'crm.signals.open_deals')).toHaveLength(1);
  });

  it('runs the rules over MCP for a company grant with the items of the owner\'s own Home, rule 3 quiet while its reads do not exist', async () => {
    const g = await grant(users.owner);
    const actor = mcp(users.owner, g, 'company');
    for (const rule of RULES) expect(await run(actor, rule), rule).toEqual(await run(browser(users.owner), rule));
    expect(await run(actor, 'kernel.signals.deal_without_invoice')).toHaveLength(1);
    expect(await run(actor, 'kernel.signals.receivable_with_open_deal')).toHaveLength(1);
    expect(await run(actor, 'kernel.signals.supplier_bank_changed')).toEqual([]);
    const items = (await run(actor, 'kernel.signals.deal_without_invoice')) as Array<{ title: { key: string }; kind: string }>;
    expect(items[0]).toMatchObject({ kind: 'flag', title: { key: 'signals.wonDealNoInvoice' } });
  });

  it('gives a member-bound grant of a whole-org member the member\'s own items, and a branch-limited member\'s grant no flag at all', async () => {
    const whole = mcp(users.member, await grant(users.member, { kind: 'member' }), 'member');
    for (const rule of RULES) expect(await run(whole, rule), rule).toEqual(await run(browser(users.member), rule));
    expect(await run(whole, 'kernel.signals.deal_without_invoice')).toHaveLength(1);
    const branch = mcp(users.branchMember, await grant(users.branchMember, { kind: 'member' }), 'member');
    // The finance reads refuse a partial view, so a rule that needs them says nothing: never a flag claiming "no invoice" or "no debt".
    for (const rule of RULES) expect(await run(branch, rule), rule).toEqual([]);
  });

  it('answers kernel.mcp.signals with the items of the rules and says what it could not check: nothing for a whole-org grant, partial_view for a branch-limited one, rule 3 never checked yet', async () => {
    const whole = mcp(users.owner, await grant(users.owner), 'company');
    const answer = (await run(whole, 'kernel.mcp.signals')) as unknown as { items: Array<{ id: string }>; checked: string[]; unchecked: Array<{ rule: string; reason: string }> };
    expect(answer.items.map((i) => i.id).sort()).toEqual([
      ...((await run(whole, 'kernel.signals.deal_without_invoice')) as Array<{ id: string }>),
      ...((await run(whole, 'kernel.signals.receivable_with_open_deal')) as Array<{ id: string }>),
    ].map((i) => i.id).sort());
    expect(answer.items).toHaveLength(2);
    expect(answer.checked).toEqual(['deal_without_invoice', 'receivable_with_open_deal']);
    expect(answer.unchecked).toEqual([{ rule: 'supplier_bank_changed', reason: 'not_available' }, { rule: 'conversation_unanswered', reason: 'not_available' }]);
    // A branch-limited member's grant gets no item, and is told in so many words that two rules could not be checked: an empty list is never "all clear".
    const branch = mcp(users.branchMember, await grant(users.branchMember, { kind: 'member' }), 'member');
    const limited = (await run(branch, 'kernel.mcp.signals')) as unknown as { items: unknown[]; checked: string[]; unchecked: Array<{ rule: string; reason: string }> };
    expect(limited.items).toEqual([]);
    expect(limited.checked).toEqual([]);
    expect(limited.unchecked).toEqual([
      { rule: 'deal_without_invoice', reason: 'partial_view' },
      { rule: 'receivable_with_open_deal', reason: 'partial_view' },
      { rule: 'supplier_bank_changed', reason: 'not_available' },
      { rule: 'conversation_unanswered', reason: 'not_available' },
    ]);
  });

  it('does not let a grant run Home itself or anything the rules do not name', async () => {
    const actor = mcp(users.owner, await grant(users.owner), 'company');
    await expect(run(actor, 'kernel.today')).rejects.toBeInstanceOf(DomainError);
    await expect(run(actor, 'finance.today')).rejects.toBeInstanceOf(DomainError);
  });

  it('reaches nothing with a grant without the scope, a revoked grant or a grantor demoted since, and answers all three the same generic way', async () => {
    const answers: DomainError[] = [];
    const g = await grant(users.owner);
    answers.push(await refusal(run(mcp(users.owner, g, 'company', []), 'crm.signals.won_deals')));
    const revoked = await grant(users.owner, { revoked: true });
    answers.push(await refusal(run(mcp(users.owner, revoked, 'company'), 'crm.signals.won_deals')));
    const demoted = await grant(users.admin);
    await run(mcp(users.admin, demoted, 'company'), 'crm.signals.won_deals');
    await rows("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, users.admin]);
    answers.push(await refusal(run(mcp(users.admin, demoted, 'company'), 'crm.signals.won_deals')));
    await rows("UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [orgId, users.admin]);
    // The revoked grant and the demoted grantor are the one generic answer; the missing scope is refused before the grant is looked at.
    expect(answers[1]?.code).toBe('MCP_GRANT_INVALID');
    expect(answers[2]?.code).toBe('MCP_GRANT_INVALID');
    expect(answers[2]?.message).toBe(answers[1]?.message);
    expect(answers[0]).toBeInstanceOf(DomainError);
  });
});
