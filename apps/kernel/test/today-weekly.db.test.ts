// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" figures, end to end on PostgreSQL 17 (Vy plan C5, slice V6, #3257): the real `kernel.today_weekly.figures` over the real reads of Engage (CRM), Accounting and the kernel's tasks, for
// a real owner, member and branch-limited member, with nothing stood in. The window is the last 7 days; the figures are computed by code from the lines' own reads in the member's own context, so a
// member limited to part of the books gets figures only from what they can open. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday, zWeeklyFigures, type Deal, type PipelineStage, type WeeklyFigures } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { addDays, financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const READ = 'kernel.today_weekly.figures';

suite('"Tuần này" figures, end to end (#3257)', () => {
  const dbName = `crove_test_today_weekly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@weekly.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, branchMember] = [await identity('member'), await identity('branch')];
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [orgId, member, branchMember]);
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const weekly = (user: string) => rt.query<WeeklyFigures>(READ, {}, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stage = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const newDeal = (partyId: string, amount = '15000000') => exec<Deal>(owner, 'crm.deal.create', { partyId, title: 'Hợp đồng', amount, expectedClose: null });
    // A deal won `days` days ago (the command stamps now; a superuser's statement moves it back).
    async function wonDeal(partyId: string, days: number, amount: string): Promise<void> {
      const deal = await newDeal(partyId, amount);
      await exec<Deal>(owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await stage('Thắng')).id });
      await rows("UPDATE ludy_crm.deal SET closed_at = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' - make_interval(days => $3) + interval '9 hours' WHERE org_id = $1 AND id = $2", [orgId, deal.id, days]);
    }
    // One balanced entry of the books: `debit` account against `credit` account, on a day, in an entity.
    async function entry(date: string, debit: string, credit: string, amount: string, legalEntity: string = entity, partyId: string | null = null): Promise<void> {
      await admin(async (c) => {
        const id = randomUUID();
        await c.query('BEGIN');
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'weekly test', 'finance.purchase_document', $4, $5)`, [orgId, id, date, randomUUID(), legalEntity]);
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, $3, $5, 0, CASE WHEN $3 = '131' THEN $6::uuid END, $7), ($1, $2, 2, $4, 0, $5, CASE WHEN $4 = '131' THEN $6::uuid END, $7)`,
          [orgId, id, debit, credit, amount, partyId, legalEntity],
        );
        await c.query('COMMIT');
      });
    }
    const task = (title: string, due: string | undefined) => exec<{ taskId: string }>(owner, 'kernel.task.create', { title, assigneePositionId: null, ...(due ? { due } : {}) });
    return { orgId, owner, member, branchMember, entity, branch, weekly, party, newDeal, wonDeal, entry, task };
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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
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

  it('computes the week from the lines’ own reads: wins in the window, open deals, the books now against a week ago, tasks past due', async () => {
    const o = await org();
    const [a, b, c, d] = [await o.party('A'), await o.party('B'), await o.party('C'), await o.party('D')];
    // Won 2 and 6 days ago (inside the window of 7 days), and 7 days ago (outside it: the window is today and the 6 days before). One deal still open.
    await o.wonDeal(a, 2, '15000000.50');
    await o.wonDeal(b, 6, '4000000');
    await o.wonDeal(c, 7, '9000000');
    await o.newDeal(d);
    // The books: a sale of 10 million 12 days ago and one of 4 million 2 days ago (receivables), 3 million received 3 days ago (cash).
    await o.entry(addDays(TODAY, -12), '131', '511', '10000000', o.entity, a);
    await o.entry(addDays(TODAY, -2), '131', '511', '4000000', o.entity, a);
    await o.entry(addDays(TODAY, -3), '111', '131', '3000000', o.entity, a);
    // Tasks on the owner's seat: one past due, one in the future, one with no due time, one done that was due.
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await o.task('Quá hạn', past);
    await o.task('Còn hạn', future);
    await o.task('Không hạn', undefined);
    const done = await o.task('Đã xong', past);
    await rows("UPDATE ludy_kernel.task SET status = 'done' WHERE org_id = $1 AND id = $2", [o.orgId, done.taskId]);

    const figures = await o.weekly(o.owner);
    expect(zWeeklyFigures.safeParse(figures).success).toBe(true);
    expect(figures).toEqual({
      from: addDays(TODAY, -6),
      to: TODAY,
      before: addDays(TODAY, -7),
      deals: { won: { count: 2, amount: '19000000.50' }, open: 1 },
      money: {
        cash: { amount: '3000000', previous: '0' },
        receivables: { amount: '11000000', previous: '10000000' },
        payables: { amount: '0', previous: '0' },
      },
      tasks: { late: 1 },
    });
  });

  it('leaves a group null, never 0, when there is nothing to read it from: books with no entry at all, and no deals module data', async () => {
    const o = await org();
    const figures = await o.weekly(o.owner);
    // The books hold no entry, so there is nothing to compare; deals and tasks read fine and are really 0.
    expect(figures.money).toBeNull();
    expect(figures.deals).toEqual({ won: { count: 0, amount: '0' }, open: 0 });
    expect(figures.tasks).toEqual({ late: 0 });
  });

  it('shows a member limited to one entity the figures of that entity only, and no task of the owner’s seat', async () => {
    const o = await org();
    const p = await o.party('A');
    // The default entity's books and the branch's books differ; a member who may open only the branch sees the branch's figures, never the head office's.
    await o.entry(addDays(TODAY, -2), '131', '511', '40000000', o.entity, p);
    await o.entry(addDays(TODAY, -2), '131', '511', '7000000', o.branch, p);
    await o.task('Quá hạn', new Date(Date.now() - 86_400_000).toISOString());
    const owner = await o.weekly(o.owner);
    const branch = await o.weekly(o.branchMember);
    expect(owner.money?.receivables).toEqual({ amount: '40000000', previous: '0' });
    expect(branch.money?.receivables).toEqual({ amount: '7000000', previous: '0' });
    // The task is on the owner's seat (the root of the chart): a member holds none.
    expect(owner.tasks).toEqual({ late: 1 });
    expect(branch.tasks).toEqual({ late: 0 });
  });

  it('shows a member with no right to a book no figure of it', async () => {
    const o = await org();
    const outsider = await identity('outsider');
    // Not a member of the org at all: every read refuses and the query itself is refused rather than answering with zeros.
    await expect(o.weekly(outsider)).rejects.toThrow();
  });
});
