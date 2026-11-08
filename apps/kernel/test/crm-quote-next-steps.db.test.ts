// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up of a sent quote as a next step of its deal, on PostgreSQL 17 (#2699, docs/plan/crm-quotes.md section 7): a quote sent 5 days ago with no answer
// raises quote_unanswered, one valid for 3 more days or fewer raises quote_expiring, both for the deal's owner, one step per deal; running the rule again raises
// nothing and "done" is not raised again at once; a quote that was decided closes its step; a draft, a quote of a closed deal and a fresh quote raise nothing; the
// Home read and the audit row hold no quote number, amount or text. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zTodayItems, type Deal, type NextStepChanged, type NextStepPage, type PipelineStage, type TodayItem } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
// A deal title that names a person: it must never reach an audit row or the Home read.
const SECRET_TITLE = 'Hợp đồng bí mật của anh Bình 4242';

interface StepRow {
  id: string;
  deal_id: string;
  reason: string;
  assignee_user_id: string | null;
  since_on: string;
  status: string;
  snoozed_until: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  closed_reason: string | null;
}

suite('quote follow-up next steps on PostgreSQL (#2699)', () => {
  const dbName = `crove_test_crm_quote_steps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stale.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [adm, member, other, viewer] = [await person('admin'), await person('member'), await person('other'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, adm, member, other, viewer]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stageNamed = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const newDeal = (user: string, partyId: string, over: Record<string, unknown> = {}) =>
      exec<Deal>(user, 'crm.deal.create', { partyId, title: SECRET_TITLE, amount: '15000000', expectedClose: null, ...over });
    // Makes the deal's last change `days` days ago (a superuser's statement: the commands always stamp now).
    const age = (dealId: string, days: number) => rows('UPDATE crove_crm.deal SET updated_at = now() - make_interval(days => $3) WHERE org_id = $1 AND id = $2', [orgId, dealId, days]);
    const raise = () => worker.execute<{ raised: number; closed: number }>('crm.next_step.raise', {}, { actor: SYSTEM, orgId });
    const steps = () =>
      rows<StepRow>(
        `SELECT id, deal_id, reason, assignee_user_id, to_char(since_on, 'YYYY-MM-DD') AS since_on, status, snoozed_until, resolved_at, resolved_by, closed_reason
         FROM crove_crm.deal_next_step WHERE org_id = $1 ORDER BY raised_at, id`,
        [orgId],
      );
    const stepsOf = async (dealId: string) => (await steps()).filter((s) => s.deal_id === dealId);
    const list = (user: string, scope: 'mine' | 'all' = 'mine') => query<NextStepPage>(user, 'crm.next_step.list', { scope });
    const done = (user: string, nextStepIds: string[]) => exec<NextStepChanged>(user, 'crm.next_step.done', { nextStepIds });
    const auditOf = (command: string) => rows<{ detail: Record<string, unknown> }>('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at', [orgId, command]);
    // A quote of the deal as a person makes it, then sent as the database owner makes a send (Q2's step): `sentDaysAgo` days ago, valid until `validIn` days from today.
    const sentQuote = async (dealId: string, sentDaysAgo: number, validIn: number, number = `BG-2026-${Math.floor(Math.random() * 9000) + 1000}`) => {
      const draft = await exec<{ id: string }>(member, 'crm.quote.save', { dealId, lines: [{ kind: 'item', description: 'Dòng bí mật 777', unit: 'cái', quantity: '2', unitPrice: '123456', vatRate: '10%' }] });
      await rows(
        "UPDATE crove_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [orgId, draft.id, number, sentDaysAgo, validIn],
      );
      return { id: draft.id, number };
    };
    const setStatus = (quoteId: string, status: string) =>
      rows("UPDATE crove_crm.quote SET status = $3, decided_at = CASE WHEN $3 IN ('accepted', 'declined') THEN now() ELSE NULL END WHERE org_id = $1 AND id = $2", [orgId, quoteId, status]);
    return { orgId, owner, admin: adm, member, other, viewer, exec, query, party, stageNamed, newDeal, age, raise, steps, stepsOf, list, done, auditOf, sentQuote, setStatus };
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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerUrl = login('crove_worker', 'test-worker-pw');
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('raises quote_unanswered for a quote sent 5 days ago, for the deal\'s owner, and nothing the second time', async () => {
    const o = await org();
    const p = await o.party('Công ty A');
    const deal = await o.newDeal(o.member, p);
    await o.sentQuote(deal.id, 6, 20);
    expect(await o.raise()).toMatchObject({ raised: 1 });
    const [step] = await o.stepsOf(deal.id);
    expect(step).toMatchObject({ reason: 'quote_unanswered', assignee_user_id: o.member, status: 'open' });
    const sent = (await rows<{ d: string }>("SELECT to_char((sent_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS d FROM crove_crm.quote WHERE org_id = $1", [o.orgId]))[0]?.d;
    expect(step?.since_on).toBe(sent);
    expect(await o.raise()).toMatchObject({ raised: 0 });
    expect(await o.stepsOf(deal.id)).toHaveLength(1);
  });

  it('raises quote_expiring, with the last valid day, when the quote is valid for 3 more days or fewer, and it wins over a quote with no answer', async () => {
    const o = await org();
    const p = await o.party('Công ty B');
    const deal = await o.newDeal(o.member, p);
    await o.sentQuote(deal.id, 8, 2);
    await o.raise();
    const [step] = await o.stepsOf(deal.id);
    const until = (await rows<{ d: string }>("SELECT to_char(valid_until, 'YYYY-MM-DD') AS d FROM crove_crm.quote WHERE org_id = $1", [o.orgId]))[0]?.d;
    expect(step).toMatchObject({ reason: 'quote_expiring', since_on: until });
  });

  it('raises nothing for a draft, a fresh quote, a quote of a closed deal or one valid for more than 3 days', async () => {
    const o = await org();
    const p = await o.party('Công ty C');
    const draftDeal = await o.newDeal(o.member, p);
    await o.exec(o.member, 'crm.quote.save', { dealId: draftDeal.id, lines: [] });
    const fresh = await o.newDeal(o.member, p);
    await o.sentQuote(fresh.id, 2, 12);
    const won = await o.newDeal(o.member, p);
    await o.sentQuote(won.id, 9, 1);
    await o.exec(o.member, 'crm.deal.move', { dealId: won.id, stageId: (await o.stageNamed('Thắng')).id, version: won.version });
    expect(await o.raise()).toMatchObject({ raised: 0 });
    expect(await o.steps()).toEqual([]);
  });

  it('keeps one step per deal: a deal that already has a stale step gets no quote step, and done is not raised again at once', async () => {
    const o = await org();
    const p = await o.party('Công ty D');
    const deal = await o.newDeal(o.member, p);
    await o.age(deal.id, 20);
    await o.sentQuote(deal.id, 7, 9);
    await o.raise();
    expect((await o.stepsOf(deal.id)).map((s) => s.reason)).toEqual(['no_activity']);
    const other = await o.newDeal(o.member, p);
    await o.sentQuote(other.id, 7, 9);
    await o.raise();
    const [mine] = await o.stepsOf(other.id);
    expect(mine?.reason).toBe('quote_unanswered');
    await o.done(o.member, [mine?.id as string]);
    expect(await o.raise()).toMatchObject({ raised: 0 });
    expect(await o.stepsOf(other.id)).toHaveLength(1);
  });

  it('closes the step with quote_decided once the quote is accepted, declined or replaced', async () => {
    const o = await org();
    const p = await o.party('Công ty E');
    const [a, b] = [await o.newDeal(o.member, p), await o.newDeal(o.member, p)];
    const quoteA = await o.sentQuote(a.id, 7, 9);
    await o.sentQuote(b.id, 7, 9);
    await o.raise();
    expect(await o.steps()).toHaveLength(2);
    await o.setStatus(quoteA.id, 'accepted');
    expect(await o.raise()).toMatchObject({ raised: 0, closed: 1 });
    expect((await o.stepsOf(a.id))[0]).toMatchObject({ status: 'closed', closed_reason: 'quote_decided' });
    expect((await o.stepsOf(b.id))[0]).toMatchObject({ status: 'open' });
  });

  it('lists an org with a quote to follow up for the nightly pass, and leaves no quote number, amount or text in an audit row or the Home read', async () => {
    const o = await org();
    const p = await o.party('Công ty F');
    const deal = await o.newDeal(o.member, p);
    const quote = await o.sentQuote(deal.id, 7, 9);
    const { rows: listed } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_crm.deal_stale_orgs(NULL, 1000)');
    expect(listed.map((r) => r.org_id)).toContain(o.orgId);
    await o.raise();
    const audit = JSON.stringify(await o.auditOf('crm.next_step.raise'));
    expect(audit).not.toMatch(new RegExp(`${quote.number}|123456|bí mật|Dòng`, 'i'));
    const items = await o.query<TodayItem[]>(o.member, 'crm.today', {});
    expect(zTodayItems.safeParse(items).success).toBe(true);
    const step = (await o.stepsOf(deal.id))[0] as StepRow;
    expect(items.find((i) => i.id === `next-step:${step.id}`)).toMatchObject({ kind: 'flag', app: 'crm', severity: 'info', title: { key: 'crm.quoteUnanswered' }, href: '/deals?tab=next' });
    expect(JSON.stringify(items)).not.toMatch(new RegExp(`${quote.number}|bí mật|Dòng`, 'i'));
    // An org whose follow-ups are all raised drops out of the list.
    const { rows: after } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_crm.deal_stale_orgs(NULL, 1000)');
    expect(after.map((r) => r.org_id)).not.toContain(o.orgId);
  });
});
