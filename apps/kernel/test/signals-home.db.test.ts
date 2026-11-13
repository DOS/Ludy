// SPDX-License-Identifier: AGPL-3.0-only
// The cross-app rules light up on Home, end to end on PostgreSQL 17 (Vy V4 and V5, #2967 and #2969): the real kernel.today of the kernel, over the real signals reads of Engage (CRM) and
// Accounting, for a real owner, member and branch-limited member, with nothing stood in. Rule 1: a deal won 7 or more days ago whose customer has no sales invoice dated on or after the win. Rule 2: a
// customer with a sales invoice past its due date and a deal still open. Each fires on a seeded case and not on its near misses, and a member who cannot see every book gets no flag, never a false one.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { vietnamToday, type Deal, type PipelineStage, type TodayItem } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { addDays, financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const RULE_1 = 'signal:won-deal-no-invoice:';
const RULE_2 = 'signal:overdue-receivable-open-deal:';

suite('the cross-app rules on Home, end to end (#2967, #2969)', () => {
  const dbName = `crove_test_signals_home_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@home.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, branchMember] = [await identity('member'), await identity('branch')];
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [orgId, member, branchMember]);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const home = async (user: string) => (await rt.query<{ items: TodayItem[]; failed: number }>('kernel.today', {}, { actor: asUser(user), orgId })).items;
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stage = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const newDeal = (partyId: string) => exec<Deal>(owner, 'crm.deal.create', { partyId, title: 'Hợp đồng', amount: '15000000', expectedClose: null });
    // A deal won `days` days ago (the command stamps now; a superuser's statement moves it back).
    async function wonDeal(partyId: string, days: number): Promise<string> {
      const deal = await newDeal(partyId);
      await exec<Deal>(owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await stage('Thắng')).id });
      await rows("UPDATE crove_crm.deal SET closed_at = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' - make_interval(days => $3) + interval '9 hours' WHERE org_id = $1 AND id = $2", [orgId, deal.id, days]);
      return deal.id;
    }
    async function sale(partyId: string, number: string, date: string, total: string, legalEntity: string = entity): Promise<void> {
      await admin(async (c) => {
        const doc = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, 'sale', $7)`,
          [orgId, doc, partyId, number, date, total, legalEntity],
        );
        const entry = randomUUID();
        await c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
          [orgId, entry, date, `HĐ bán ${number}`, doc, legalEntity],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)`,
          [orgId, entry, total, partyId, legalEntity],
        );
        await c.query('COMMIT');
      });
    }
    return { orgId, owner, member, branchMember, entity, branch, home, party, newDeal, wonDeal, sale };
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
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const ids = (items: TodayItem[], prefix: string) => items.filter((i) => i.id.startsWith(prefix) && !/:(more|partial|unchecked)$/.test(i.id)).map((i) => i.id.slice(prefix.length));

  it('rule 1 fires for a deal won 8 days ago with no sales invoice, and not for its near misses', async () => {
    const o = await org();
    const [late, recent, invoiced, other, invoicedLater] = [await o.party('A'), await o.party('B'), await o.party('C'), await o.party('D'), await o.party('E')];
    const lateDeal = await o.wonDeal(late, 8);
    await o.wonDeal(recent, 6);
    await o.wonDeal(invoiced, 8);
    await o.sale(invoiced, '1', addDays(TODAY, -8), '1000000');
    const otherDeal = await o.wonDeal(other, 9);
    await o.sale(late, '9', addDays(TODAY, -30), '700000');
    const invoicedLaterDeal = await o.wonDeal(invoicedLater, 10);
    await o.sale(invoicedLater, '2', addDays(TODAY, -2), '900000');
    void invoicedLaterDeal;
    const fired = ids(await o.home(o.owner), RULE_1).sort();
    // An invoice dated before the win does not count as the sale (late: invoice 30 days ago; other: none), one dated on or after the win does.
    expect(fired).toEqual([lateDeal, otherDeal].sort());
    const item = (await o.home(o.owner)).find((i) => i.id === `${RULE_1}${lateDeal}`);
    expect(item).toMatchObject({ kind: 'flag', app: 'crm', severity: 'warn', title: { key: 'signals.wonDealNoInvoice' } });
    // A member of the org (the whole books in view) sees the same flags.
    expect(ids(await o.home(o.member), RULE_1).sort()).toEqual([lateDeal, otherDeal].sort());
  });

  it('rule 1 shows a member who sees only one entity no flag at all, never one claiming "no invoice"', async () => {
    const o = await org();
    const p = await o.party('A');
    await o.wonDeal(p, 8);
    await o.sale(p, '1', addDays(TODAY, -2), '1000000', o.entity);
    expect(ids(await o.home(o.branchMember), RULE_1)).toEqual([]);
    // The owner sees the invoice in the default entity, so the deal is invoiced and there is no flag either.
    expect(ids(await o.home(o.owner), RULE_1)).toEqual([]);
  });

  it('rule 2 fires for a customer with an overdue invoice and an open deal, and not for its near misses', async () => {
    const o = await org();
    const [both, dueToday, noDeal, wonOnly] = [await o.party('A'), await o.party('B'), await o.party('C'), await o.party('D')];
    await o.newDeal(both);
    await o.sale(both, '1', addDays(TODAY, -35), '2000000');
    await o.newDeal(dueToday);
    await o.sale(dueToday, '2', addDays(TODAY, -30), '1000000');
    await o.sale(noDeal, '3', addDays(TODAY, -40), '1000000');
    await o.wonDeal(wonOnly, 2);
    await o.sale(wonOnly, '4', addDays(TODAY, -40), '1000000');
    expect(ids(await o.home(o.owner), RULE_2)).toEqual([both]);
    expect(ids(await o.home(o.member), RULE_2)).toEqual([both]);
    const item = (await o.home(o.owner)).find((i) => i.id === `${RULE_2}${both}`);
    expect(item).toMatchObject({ kind: 'flag', app: 'crm', title: { key: 'signals.overdueReceivableOpenDeal' } });
    // A member who sees only the branch's books gets no flag: their view of the receivables is partial.
    expect(ids(await o.home(o.branchMember), RULE_2)).toEqual([]);
  });
});
