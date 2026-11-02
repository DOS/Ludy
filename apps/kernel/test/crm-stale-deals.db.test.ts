// SPDX-License-Identifier: AGPL-3.0-only
// The stale-deal rule and the next steps it raises, on PostgreSQL 17 (#2381, docs/plan/crm.md): an open deal nobody changed for N days, or past its
// expected close, gets one next step for its owner; running the rule again raises nothing; an edit, a move or a close closes it; done and snooze, one at
// a time or twenty at once, leave one audit row with ids only; a viewer marks nothing; the org's N is the owners' and admins'; the Home read answers
// the member's own items and no text a person typed. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { vietnamToday, zTodayItems, type Deal, type DealSetting, type NextStepChanged, type NextStepPage, type PipelineStage, type TodayItem } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { raiseCrmNextSteps } from '../src/crm-worker.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
const DAY = 86_400_000;
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

suite('stale deals and their next steps on PostgreSQL (#2381)', () => {
  const dbName = `crove_test_crm_stale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // A superuser's session that skips the triggers, as a restore would: to age rows past what the guards let a command do.
  const asRestore = (text: string, params: unknown[] = []) =>
    admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      return (await c.query(text, params)).rows;
    });
  // A member's own connection with the context entered, as the API's login: what a stray statement could do.
  async function asMember<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

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
    // The Vietnam calendar day of the deal's last change, as the database reads it.
    const changedOn = async (dealId: string) =>
      (await rows<{ d: string }>("SELECT to_char((updated_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS d FROM crove_crm.deal WHERE org_id = $1 AND id = $2", [orgId, dealId]))[0]?.d as string;
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
    const snooze = (user: string, nextStepIds: string[], days: number) => exec<NextStepChanged>(user, 'crm.next_step.snooze', { nextStepIds, days });
    const auditOf = (command: string) => rows<{ detail: Record<string, unknown> }>('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at', [orgId, command]);
    return { orgId, owner, admin: adm, member, other, viewer, exec, query, party, stageNamed, newDeal, age, changedOn, raise, steps, stepsOf, list, done, snooze, auditOf };
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

  describe('the rule', () => {
    it('raises one next step for a deal nobody changed for 14 days, for its owner, and none the second time', async () => {
      const o = await org();
      const p = await o.party('Công ty A');
      const stale = await o.newDeal(o.member, p);
      const fresh = await o.newDeal(o.member, p);
      const won = await o.newDeal(o.member, p);
      await o.age(stale.id, 20);
      await o.age(fresh.id, 3);
      // A deal that is won is closed: not stale, however long ago it was touched.
      await o.exec(o.member, 'crm.deal.move', { dealId: won.id, version: won.version, stageId: (await o.stageNamed('Thắng')).id });
      await o.age(won.id, 40);
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
      const first = await o.steps();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ deal_id: stale.id, reason: 'no_activity', assignee_user_id: o.member, status: 'open', snoozed_until: null, resolved_at: null, closed_reason: null });
      expect(first[0]?.since_on).toBe(await o.changedOn(stale.id));
      // Again: nothing new, one open step per deal.
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
      expect(await o.steps()).toHaveLength(1);
      // The deal shows the badge to every role, the fresh and the won ones do not.
      const shown = await o.query<Deal>(o.viewer, 'crm.deal.get', { dealId: stale.id });
      expect(shown.followUp).toEqual({ id: (first[0] as StepRow).id, reason: 'no_activity', sinceOn: (first[0] as StepRow).since_on });
      expect((await o.query<Deal>(o.viewer, 'crm.deal.get', { dealId: fresh.id })).followUp).toBeNull();
      expect((await o.query<Deal>(o.viewer, 'crm.deal.get', { dealId: won.id })).followUp).toBeNull();
      expect((await o.query<{ items: Deal[] }>(o.viewer, 'crm.deal.list', {})).items.find((d) => d.id === stale.id)?.followUp?.reason).toBe('no_activity');
      // The audit row of the run holds counts and no title.
      const audit = await o.auditOf('crm.next_step.raise');
      expect(audit.map((a) => a.detail)).toEqual(expect.arrayContaining([expect.objectContaining({ raised: 1, closed: 0 })]));
      expect(JSON.stringify(audit)).not.toContain(SECRET_TITLE);
    });

    it('raises past_close for a deal past its expected close even when it was edited today, and not for one closing today', async () => {
      const o = await org();
      const p = await o.party('Công ty B');
      const yesterday = vietnamToday(new Date(Date.now() - DAY));
      const today = vietnamToday(new Date());
      const overdue = await o.newDeal(o.member, p, { expectedClose: yesterday });
      const closingToday = await o.newDeal(o.member, p, { expectedClose: today });
      // Both overdue and untouched for a month: past_close wins, and it is still one step.
      const both = await o.newDeal(o.member, p, { expectedClose: yesterday });
      await o.age(both.id, 30);
      expect(await o.raise()).toEqual({ raised: 2, closed: 0 });
      const byDeal = new Map((await o.steps()).map((s) => [s.deal_id, s]));
      expect(byDeal.get(overdue.id)).toMatchObject({ reason: 'past_close', since_on: yesterday, assignee_user_id: o.member });
      expect(byDeal.get(both.id)).toMatchObject({ reason: 'past_close', since_on: yesterday });
      expect(byDeal.has(closingToday.id)).toBe(false);
      expect((await o.query<Deal>(o.owner, 'crm.deal.get', { dealId: overdue.id })).followUp?.reason).toBe('past_close');
    });

    it('closes the open step when the deal is edited, moved or closed, and with the deal when it is deleted; the reasons are kept', async () => {
      const o = await org();
      const p = await o.party('Công ty C');
      const edited = await o.newDeal(o.member, p);
      const moved = await o.newDeal(o.member, p);
      const lost = await o.newDeal(o.member, p);
      const deleted = await o.newDeal(o.member, p);
      for (const d of [edited, moved, lost, deleted]) await o.age(d.id, 20);
      expect(await o.raise()).toEqual({ raised: 4, closed: 0 });
      await o.exec(o.member, 'crm.deal.update', { dealId: edited.id, version: edited.version, partyId: p, title: 'Đổi tên', amount: '1000', expectedClose: null, ownerUserId: o.member });
      await o.exec(o.member, 'crm.deal.move', { dealId: moved.id, version: moved.version, stageId: (await o.stageNamed('Báo giá')).id });
      await o.exec(o.member, 'crm.deal.move', { dealId: lost.id, version: lost.version, stageId: (await o.stageNamed('Thua')).id, lostReason: 'Chọn nhà cung cấp khác' });
      await o.exec(o.member, 'crm.deal.delete', { dealId: deleted.id });
      expect(await o.stepsOf(edited.id)).toMatchObject([{ status: 'closed', closed_reason: 'deal_edited', resolved_by: null }]);
      expect(await o.stepsOf(moved.id)).toMatchObject([{ status: 'closed', closed_reason: 'deal_moved' }]);
      expect(await o.stepsOf(lost.id)).toMatchObject([{ status: 'closed', closed_reason: 'deal_closed' }]);
      expect(await o.stepsOf(deleted.id)).toEqual([]);
      for (const d of [edited, moved, lost]) expect((await o.stepsOf(d.id))[0]?.resolved_at).not.toBeNull();
      // Their deals are fresh now (or closed): the rule raises nothing and the badge is gone.
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
      expect((await o.query<Deal>(o.owner, 'crm.deal.get', { dealId: edited.id })).followUp).toBeNull();
    });

    it('does not raise the same step again right after it was marked done, or after an edit left the deal overdue, until N days have passed', async () => {
      const o = await org();
      const p = await o.party('Công ty D');
      const quiet = await o.newDeal(o.member, p);
      await o.age(quiet.id, 20);
      await o.raise();
      const [step] = await o.stepsOf(quiet.id);
      // Marked done by another member: their name, and the deal itself is as old as it was.
      expect(await o.done(o.other, [(step as StepRow).id])).toEqual({ changed: [(step as StepRow).id], skipped: [] });
      expect(await o.stepsOf(quiet.id)).toMatchObject([{ status: 'done', resolved_by: o.other, closed_reason: null, snoozed_until: null }]);
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
      // N days after, the deal is still untouched: a new step.
      await asRestore('UPDATE crove_crm.deal_next_step SET resolved_at = now() - interval \'15 days\' WHERE org_id = $1', [o.orgId]);
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
      expect(await o.stepsOf(quiet.id)).toHaveLength(2);

      // An overdue deal edited but still overdue: its step closes with the edit, and the rule does not raise it again that night.
      const yesterday = vietnamToday(new Date(Date.now() - DAY));
      const overdue = await o.newDeal(o.member, p, { expectedClose: yesterday });
      await o.raise();
      await o.exec(o.member, 'crm.deal.update', { dealId: overdue.id, version: overdue.version, partyId: p, title: 'Đổi', amount: '5', expectedClose: yesterday, ownerUserId: o.member });
      expect(await o.stepsOf(overdue.id)).toMatchObject([{ status: 'closed', closed_reason: 'deal_edited' }]);
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
      await asRestore("UPDATE crove_crm.deal_next_step SET resolved_at = now() - interval '15 days' WHERE org_id = $1 AND deal_id = $2", [o.orgId, overdue.id]);
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
    });

    it('raises at most 500 steps in a run, the longest quiet first, and the rest the next time', async () => {
      const o = await org();
      const p = await o.party('Công ty E2');
      const stage = await o.stageNamed('Mới');
      await rows(
        `INSERT INTO crove_crm.deal (org_id, party_id, title, stage_id, sort_key, owner_user_id, created_by, updated_at)
         SELECT $1, $2, 'Cơ hội ' || g, $3, 'V', $4, $4, now() - interval '30 days' + g * interval '1 minute' FROM generate_series(1, 501) g`,
        [o.orgId, p, stage.id, o.member],
      );
      expect(await o.raise()).toEqual({ raised: 500, closed: 0 });
      const left = await rows<{ title: string }>(
        'SELECT d.title FROM crove_crm.deal d WHERE d.org_id = $1 AND NOT EXISTS (SELECT 1 FROM crove_crm.deal_next_step n WHERE n.org_id = d.org_id AND n.deal_id = d.id)',
        [o.orgId],
      );
      // The 501st is the least quiet one.
      expect(left.map((d) => d.title)).toEqual(['Cơ hội 501']);
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
    });

    it('closes the open steps of a deal that left the open stages as a safety net, and raises none for it', async () => {
      const o = await org();
      const p = await o.party('Công ty E');
      const deal = await o.newDeal(o.member, p);
      await o.age(deal.id, 20);
      await o.raise();
      // A close that did not come through the command (a restore): the rule closes the step.
      await asRestore('UPDATE crove_crm.deal SET closed_at = now() WHERE org_id = $1 AND id = $2', [o.orgId, deal.id]);
      expect(await o.raise()).toEqual({ raised: 0, closed: 1 });
      expect(await o.stepsOf(deal.id)).toMatchObject([{ status: 'closed', closed_reason: 'deal_closed' }]);
    });
  });

  describe('snooze, done, and who sees what', () => {
    it('hides a snoozed step until its time and shows it again, and the rule raises no second one meanwhile', async () => {
      const o = await org();
      const p = await o.party('Công ty F');
      const deal = await o.newDeal(o.member, p);
      await o.age(deal.id, 20);
      await o.raise();
      const [step] = await o.stepsOf(deal.id);
      const id = (step as StepRow).id;
      expect((await o.list(o.member)).items.map((s) => s.id)).toEqual([id]);
      expect(await o.snooze(o.member, [id], 3)).toEqual({ changed: [id], skipped: [] });
      const hidden = await o.list(o.member);
      expect(hidden.items).toEqual([]);
      expect(hidden.counts).toEqual({ mine: 0, all: 0 });
      expect((await o.query<Deal>(o.member, 'crm.deal.get', { dealId: deal.id })).followUp).toBeNull();
      const window = await rows<{ ok: boolean }>(
        "SELECT snoozed_until BETWEEN now() + interval '2 days 20 hours' AND now() + interval '3 days 4 hours' AS ok FROM crove_crm.deal_next_step WHERE org_id = $1 AND id = $2",
        [o.orgId, id],
      );
      expect(window[0]?.ok).toBe(true);
      expect(await o.raise()).toEqual({ raised: 0, closed: 0 });
      // Its time passes: it shows again, still the same step, while the deal is still stale.
      await asRestore("UPDATE crove_crm.deal_next_step SET snoozed_until = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [o.orgId, id]);
      expect((await o.list(o.member)).items.map((s) => s.id)).toEqual([id]);
      expect((await o.query<Deal>(o.member, 'crm.deal.get', { dealId: deal.id })).followUp?.id).toBe(id);
      // 14 days is allowed, 5 is not, a viewer snoozes nothing, and a step that is done is skipped.
      expect((await o.snooze(o.member, [id], 14)).changed).toEqual([id]);
      await expect(o.snooze(o.member, [id], 5)).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(o.snooze(o.viewer, [id], 3)).rejects.toMatchObject({ status: 403 });
      await o.done(o.member, [id]);
      expect(await o.snooze(o.member, [id], 3)).toEqual({ changed: [], skipped: [id] });
      expect(await o.done(o.member, [id])).toEqual({ changed: [], skipped: [id] });
      await expect(o.done(o.viewer, [id])).rejects.toMatchObject({ status: 403 });
      // An id that is not a step (or is another org's) is skipped, never an error and never a write.
      expect(await o.done(o.member, [randomUUID()])).toMatchObject({ changed: [] });
    });

    it('lists my steps (and the unowned ones for owners and admins) and everyone’s, to every role, with counts', async () => {
      const o = await org();
      const p = await o.party('Công ty G');
      const mine = await o.newDeal(o.member, p);
      const theirs = await o.newDeal(o.other, p);
      const nobody = await o.newDeal(o.owner, p, { ownerUserId: null });
      for (const d of [mine, theirs, nobody]) await o.age(d.id, 20);
      await o.raise();
      const stepOf = async (d: Deal) => ((await o.stepsOf(d.id))[0] as StepRow);
      expect((await stepOf(nobody)).assignee_user_id).toBeNull();
      const ids = async (user: string, scope: 'mine' | 'all') => (await o.list(user, scope)).items.map((s) => s.dealId).sort();
      expect(await ids(o.member, 'mine')).toEqual([mine.id]);
      expect(await ids(o.other, 'mine')).toEqual([theirs.id]);
      // An owner or admin also reads the unowned deal's step as theirs.
      expect(await ids(o.owner, 'mine')).toEqual([nobody.id]);
      expect(await ids(o.admin, 'mine')).toEqual([nobody.id]);
      for (const user of [o.owner, o.admin, o.member, o.other, o.viewer]) expect(await ids(user, 'all')).toEqual([mine.id, theirs.id, nobody.id].sort());
      expect(await ids(o.viewer, 'mine')).toEqual([]);
      expect((await o.list(o.member)).counts).toEqual({ mine: 1, all: 3 });
      expect((await o.list(o.owner)).counts).toEqual({ mine: 1, all: 3 });
      // A step carries what the screen shows, the amount as a decimal string; the oldest quiet first.
      const first = (await o.list(o.member, 'all')).items[0];
      expect(first).toMatchObject({ amount: '15000000.00', currency: 'VND', stageName: 'Mới', partyName: 'Công ty G', reason: 'no_activity' });
      // A member who is removed leaves the step unowned (their deal too): owners and admins read it as theirs.
      await rows('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.other]);
      expect((await stepOf(theirs)).assignee_user_id).toBeNull();
      expect(await ids(o.admin, 'mine')).toEqual([nobody.id, theirs.id].sort());
    });

    it('is one action, one audit row with ids only, for twenty steps at once; twenty-one or a repeated id is refused', async () => {
      const o = await org();
      const p = await o.party('Công ty H');
      const deals: Deal[] = [];
      for (let i = 0; i < 21; i++) deals.push(await o.newDeal(o.member, p, { title: `${SECRET_TITLE} ${i}` }));
      for (const d of deals) await o.age(d.id, 20);
      expect((await o.raise()).raised).toBe(21);
      const all = (await o.steps()).map((s) => s.id);
      expect(all).toHaveLength(21);
      const twenty = all.slice(0, 20);
      await expect(o.done(o.member, all)).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(o.done(o.member, [twenty[0] as string, twenty[0] as string])).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(o.done(o.member, [])).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await o.auditOf('crm.next_step.done')).toEqual([]);
      const result = await o.done(o.member, twenty);
      expect(new Set(result.changed)).toEqual(new Set(twenty));
      expect(result.skipped).toEqual([]);
      const audit = await o.auditOf('crm.next_step.done');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.detail.nextStepIds).toHaveLength(20);
      expect(JSON.stringify(audit)).not.toContain('bí mật');
      expect(JSON.stringify(audit)).not.toContain('Công ty H');
      expect((await o.steps()).filter((s) => s.status === 'done')).toHaveLength(20);
      // The same twenty again: all skipped. One more to snooze together with a done one.
      expect(await o.done(o.member, twenty)).toEqual({ changed: [], skipped: twenty });
      const last = all[20] as string;
      expect(await o.snooze(o.member, [last, twenty[0] as string], 7)).toEqual({ changed: [last], skipped: [twenty[0]] });
      const snoozeAudit = await o.auditOf('crm.next_step.snooze');
      expect(snoozeAudit).toHaveLength(1);
      expect(snoozeAudit[0]?.detail).toMatchObject({ nextStepIds: [last], days: 7 });
    });
  });

  describe('what the database holds each role to', () => {
    it('refuses a member’s insert, a viewer’s update, any delete, a changed reason, an unsnooze and a change to a resolved step; reads follow the org', async () => {
      const o = await org();
      const other = await org();
      const p = await o.party('Công ty I');
      const deal = await o.newDeal(o.member, p);
      const stale = await o.newDeal(o.member, p);
      await o.age(deal.id, 20);
      await o.age(stale.id, 20);
      await o.raise();
      const [step, second] = [(await o.stepsOf(deal.id))[0] as StepRow, (await o.stepsOf(stale.id))[0] as StepRow];
      // Only the system context raises one.
      await expect(
        asMember(o.orgId, o.member, (c) => c.query("INSERT INTO crove_crm.deal_next_step (org_id, deal_id, reason, since_on) VALUES ($1, $2, 'no_activity', '2026-10-01')", [o.orgId, deal.id])),
      ).rejects.toMatchObject({ code: '42501' });
      // A viewer reads, and updates no row: the policy shows it none to change.
      expect(await asMember(o.orgId, o.viewer, async (c) => (await c.query('SELECT id FROM crove_crm.deal_next_step')).rowCount)).toBe(2);
      expect(await asMember(o.orgId, o.viewer, async (c) => (await c.query("UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now(), resolved_by = $1", [o.viewer])).rowCount)).toBe(0);
      // Nobody deletes one through the API's login.
      for (const user of [o.owner, o.member]) expect(await asMember(o.orgId, user, async (c) => (await c.query('DELETE FROM crove_crm.deal_next_step')).rowCount)).toBe(0);
      // A member marks it done in their own name only, and changes none of the step's own facts.
      await expect(
        asMember(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now(), resolved_by = $1 WHERE id = $2", [o.other, step.id])),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(asMember(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.deal_next_step SET reason = 'past_close' WHERE id = $1", [step.id]))).rejects.toMatchObject({ code: '42501' });
      await expect(asMember(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.deal_next_step SET assignee_user_id = $1 WHERE id = $2', [o.other, step.id]))).rejects.toMatchObject({ code: '42501' });
      // Snoozed, then unsnoozed by a statement: a snooze is a time.
      expect(await o.snooze(o.member, [step.id], 3)).toMatchObject({ changed: [step.id] });
      await expect(asMember(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.deal_next_step SET snoozed_until = NULL WHERE id = $1', [step.id]))).rejects.toMatchObject({ code: '42501' });
      // A resolved step is final.
      await o.done(o.member, [second.id]);
      await expect(asMember(o.orgId, o.member, (c) => c.query("UPDATE crove_crm.deal_next_step SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = $1", [second.id]))).rejects.toMatchObject({ code: '42501' });
      // Another org's members see none of these rows, and write none.
      expect(await asMember(other.orgId, other.member, async (c) => (await c.query('SELECT id FROM crove_crm.deal_next_step')).rowCount)).toBe(0);
      expect(await asMember(other.orgId, other.owner, async (c) => (await c.query("UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now(), resolved_by = $1", [other.owner])).rowCount)).toBe(0);
      expect((await other.list(other.owner, 'all')).items).toEqual([]);
      // A snooze is a time within the next 14 days (a day of slack): the past is an unsnooze and the far future buries the step.
      for (const when of ["now() - interval '1 day'", "now() + interval '30 days'", "'9999-12-31'"]) {
        await expect(asMember(o.orgId, o.member, (c) => c.query(`UPDATE crove_crm.deal_next_step SET snoozed_until = ${when} WHERE id = $1`, [step.id]))).rejects.toMatchObject({ code: '42501' });
      }
      expect(await asMember(o.orgId, o.member, async (c) => (await c.query("UPDATE crove_crm.deal_next_step SET snoozed_until = now() + interval '5 days' WHERE id = $1", [step.id])).rowCount)).toBe(1);
      // Who marked a step done cannot be wiped by a statement of a login; only the foreign key's own action, when that member is removed, clears it.
      await expect(asMember(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.deal_next_step SET resolved_by = NULL WHERE id = $1', [second.id]))).rejects.toMatchObject({ code: '42501' });
      expect((await o.steps()).find((s) => s.id === second.id)?.resolved_by).toBe(o.member);
      await rows('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]);
      expect((await o.steps()).find((s) => s.id === second.id)).toMatchObject({ status: 'done', resolved_by: null });
    });

    it('holds the system context to closing: it marks no step done, snoozes none and raises one only open', async () => {
      const o = await org();
      const p = await o.party('Công ty I2');
      const deal = await o.newDeal(o.member, p);
      const other = await o.newDeal(o.member, p);
      await o.age(deal.id, 20);
      await o.age(other.id, 20);
      await o.raise();
      const [first, second] = [(await o.stepsOf(deal.id))[0] as StepRow, (await o.stepsOf(other.id))[0] as StepRow];
      // The command is the people's: the system actor is refused by its access list.
      await expect(worker.execute('crm.next_step.done', { nextStepIds: [first.id] }, { actor: SYSTEM, orgId: o.orgId })).rejects.toBeDefined();
      // And its own statements, in the system context of the org, are held by the guard.
      const asSystem = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
        const c = new pg.Client({ connectionString: workerUrl });
        await c.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
          return await fn(c);
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          await c.end();
        }
      };
      await expect(asSystem((c) => c.query("UPDATE crove_crm.deal_next_step SET status = 'done', resolved_at = now() WHERE id = $1", [first.id]))).rejects.toMatchObject({ code: '42501' });
      await expect(asSystem((c) => c.query("UPDATE crove_crm.deal_next_step SET snoozed_until = now() + interval '3 days' WHERE id = $1", [first.id]))).rejects.toMatchObject({ code: '42501' });
      await expect(
        asSystem((c) => c.query("INSERT INTO crove_crm.deal_next_step (org_id, deal_id, reason, since_on, status, resolved_at, closed_reason) VALUES ($1, $2, 'no_activity', '2026-10-01', 'closed', now(), 'deal_edited')", [o.orgId, deal.id])),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await asSystem(async (c) => (await c.query("UPDATE crove_crm.deal_next_step SET status = 'closed', resolved_at = now(), closed_reason = 'deal_closed' WHERE id = $1", [second.id])).rowCount)).toBe(1);
      // Nothing of that was kept: the transaction rolled back.
      expect((await o.steps()).map((s) => s.status)).toEqual(['open', 'open']);
    });

    it('raises a deal a viewer owns for the owners and admins, whom a viewer’s step would not reach, and nobody else’s change', async () => {
      const o = await org();
      const p = await o.party('Công ty I3');
      const viewerDeal = await o.newDeal(o.member, p, { ownerUserId: o.viewer });
      await o.age(viewerDeal.id, 20);
      await o.raise();
      expect((await o.stepsOf(viewerDeal.id))[0]?.assignee_user_id).toBeNull();
      expect((await o.list(o.viewer)).items).toEqual([]);
      expect((await o.list(o.admin)).items.map((s) => s.dealId)).toEqual([viewerDeal.id]);
    });

    it('keeps the setting to owners and admins, within 7 to 60 days, 14 until set', async () => {
      const o = await org();
      const p = await o.party('Công ty K');
      const eight = await o.newDeal(o.member, p);
      const twenty = await o.newDeal(o.member, p);
      await o.age(eight.id, 8);
      await o.age(twenty.id, 20);
      expect(await o.query<DealSetting>(o.viewer, 'crm.deal_setting.get', {})).toEqual({ staleDays: 14, isDefault: true });
      // 14 days by default: the 20-day deal only.
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
      await expect(o.exec(o.member, 'crm.deal_setting.set', { staleDays: 7 })).rejects.toMatchObject({ status: 403 });
      await expect(o.exec(o.viewer, 'crm.deal_setting.set', { staleDays: 7 })).rejects.toMatchObject({ status: 403 });
      for (const bad of [6, 61, 14.5, '14']) await expect(o.exec(o.admin, 'crm.deal_setting.set', { staleDays: bad })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await o.exec<DealSetting>(o.admin, 'crm.deal_setting.set', { staleDays: 7 })).toEqual({ staleDays: 7, isDefault: false });
      expect(await o.query<DealSetting>(o.member, 'crm.deal_setting.get', {})).toEqual({ staleDays: 7, isDefault: false });
      // From the next run on: the 8-day deal is stale too.
      expect(await o.raise()).toEqual({ raised: 1, closed: 0 });
      // Set again (an update of the one row), and 60 is the most.
      expect(await o.exec<DealSetting>(o.owner, 'crm.deal_setting.set', { staleDays: 60 })).toEqual({ staleDays: 60, isDefault: false });
      expect(await rows('SELECT 1 FROM crove_crm.deal_setting WHERE org_id = $1', [o.orgId])).toHaveLength(1);
      expect(JSON.stringify(await o.auditOf('crm.deal_setting.set'))).toContain('60');
      // A member's own statement cannot write it either.
      await expect(asMember(o.orgId, o.member, (c) => c.query('UPDATE crove_crm.deal_setting SET stale_days = 7'))).resolves.toMatchObject({ rowCount: 0 });
      await expect(asMember(o.orgId, o.member, (c) => c.query('INSERT INTO crove_crm.deal_setting (org_id, stale_days) VALUES ($1, 7)', [o.orgId]))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the daily pass', () => {
    it('lists the orgs that may have a stale deal to the worker login alone, and raises in each org’s own context', async () => {
      const busy = await org();
      const calm = await org();
      const p = await busy.party('Công ty L');
      const q = await calm.party('Công ty M');
      const stale = await busy.newDeal(busy.member, p);
      await busy.age(stale.id, 20);
      await calm.newDeal(calm.member, q);
      const { rows: orgs } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_crm.deal_stale_orgs(NULL, 1000)');
      expect(orgs.map((r) => r.org_id)).toContain(busy.orgId);
      expect(orgs.map((r) => r.org_id)).not.toContain(calm.orgId);
      // The keyset: after the last org of a page, the next page starts past it.
      const sorted = orgs.map((r) => r.org_id).sort();
      const { rows: after } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_crm.deal_stale_orgs($1::uuid, 1000)', [sorted[0]]);
      expect(after.map((r) => r.org_id)).not.toContain(sorted[0]);
      // The API's login and a member's context are refused.
      await expect(pool.query('SELECT * FROM crove_crm.deal_stale_orgs(NULL, 10)')).rejects.toMatchObject({ code: '42501' });
      await expect(asMember(busy.orgId, busy.owner, (c) => c.query('SELECT * FROM crove_crm.deal_stale_orgs(NULL, 10)'))).rejects.toMatchObject({ code: '42501' });
      // The worker's pass raises in the busy org, none in the calm one, and again changes nothing.
      const pass = await raiseCrmNextSteps({ runtime: worker, workerDb });
      expect(pass.raised).toBeGreaterThanOrEqual(1);
      expect((await busy.steps()).map((s) => s.deal_id)).toEqual([stale.id]);
      expect(await calm.steps()).toEqual([]);
      expect((await raiseCrmNextSteps({ runtime: worker, workerDb })).raised).toBe(0);
      // Handled: an org whose stale deals all have a step is no longer listed, so the next night does not walk it (or audit it) again.
      const { rows: handled } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_crm.deal_stale_orgs(NULL, 1000)');
      expect(handled.map((r) => r.org_id)).not.toContain(busy.orgId);
      expect((await busy.auditOf('crm.next_step.raise')).length).toBe(1);
      // A person cannot run the rule, and the system actor reaches no other org's rows from here.
      await expect(busy.exec(busy.owner, 'crm.next_step.raise', {})).rejects.toBeDefined();
    });
  });

  describe('the Home read (crm.today)', () => {
    it('answers the member’s own next steps, deals closing today and bookings today, in the shared shape, with no text a person typed; other members’ never appear', async () => {
      const o = await org();
      const p = await o.party('Khách hàng Nguyễn Văn Bình');
      const today = vietnamToday(new Date());
      const yesterday = vietnamToday(new Date(Date.now() - DAY));
      const quiet = await o.newDeal(o.member, p);
      const overdue = await o.newDeal(o.member, p, { expectedClose: yesterday });
      const closing = await o.newDeal(o.member, p, { expectedClose: today, amount: '2500000.5' });
      const mineElsewhere = await o.newDeal(o.other, p, { expectedClose: today });
      const otherQuiet = await o.newDeal(o.other, p);
      await o.age(quiet.id, 20);
      await o.age(otherQuiet.id, 20);
      await o.raise();
      // A booking today of an event type the member leads, and one of another member's.
      const booking = async (host: string, title: string) => {
        const type = randomUUID();
        const event = randomUUID();
        // A minute ago, but never before the start of Vietnam's day (a run just after midnight): the read asks for bookings that start today.
        const starts = new Date(Math.max(Date.now() - 60_000, new Date(`${today}T00:00:01+07:00`).getTime()));
        const ends = new Date(Date.now() + 600_000);
        await rows('INSERT INTO crove_crm.event_type (org_id, id, slug, title, duration_min, host_user_id, created_by) VALUES ($1, $2, $3, $4, 30, $5, $5)', [o.orgId, type, `t-${type.slice(0, 8)}`, title, host]);
        await rows("INSERT INTO crove_kernel.calendar_event (org_id, id, user_id, starts_at, ends_at, time_zone, kind, created_by) VALUES ($1, $2, $3, $4, $5, 'Asia/Ho_Chi_Minh', 'booking', $3)", [o.orgId, event, host, starts, ends]);
        const id = randomUUID();
        await rows(
          "INSERT INTO crove_crm.booking (org_id, id, event_type_id, calendar_event_id, starts_at, ends_at, status, visitor_name, email, time_zone) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'Khách Lê Thị Hoa', 'hoa@khach.test', 'Asia/Ho_Chi_Minh')",
          [o.orgId, id, type, event, starts, ends],
        );
        return id;
      };
      const mine = await booking(o.member, 'Tư vấn thuế riêng');
      const theirs = await booking(o.other, 'Buổi của người khác');
      const items = await o.query<TodayItem[]>(o.member, 'crm.today', {});
      expect(zTodayItems.safeParse(items).success).toBe(true);
      const stepOfQuiet = (await o.stepsOf(quiet.id))[0] as StepRow;
      const stepOfOverdue = (await o.stepsOf(overdue.id))[0] as StepRow;
      const byId = new Map(items.map((i) => [i.id, i]));
      expect([...byId.keys()].sort()).toEqual([`next-step:${stepOfQuiet.id}`, `next-step:${stepOfOverdue.id}`, `deal-closes:${closing.id}`, `booking:${mine}`].sort());
      expect(byId.get(`next-step:${stepOfQuiet.id}`)).toMatchObject({ kind: 'flag', app: 'crm', severity: 'info', amount: '15000000.00', currency: 'VND', title: { key: 'crm.noActivity' }, href: '/deals?tab=next' });
      expect(byId.get(`next-step:${stepOfOverdue.id}`)).toMatchObject({ kind: 'deadline', title: { key: 'crm.pastClose', params: { days: 1 } }, dueAt: `${yesterday}T00:00:00+07:00` });
      expect(byId.get(`deal-closes:${closing.id}`)).toMatchObject({ kind: 'deadline', amount: '2500000.50', currency: 'VND', dueAt: `${today}T23:59:00+07:00`, href: '/deals' });
      expect(byId.get(`booking:${mine}`)).toMatchObject({ kind: 'deadline', title: { key: 'crm.booking' }, href: '/bookings' });
      expect(byId.get(`booking:${mine}`)?.dueAt).toBeDefined();
      // Another member's deals, steps and bookings never appear, nor any text a person typed.
      const text = JSON.stringify(items);
      for (const hidden of [mineElsewhere.id, otherQuiet.id, theirs]) expect(text).not.toContain(hidden);
      for (const typed of [SECRET_TITLE, 'Nguyễn Văn Bình', 'Tư vấn thuế', 'Lê Thị Hoa', 'hoa@khach.test']) expect(text).not.toContain(typed);
      // The other member reads their own; a viewer has none; an owner reads the unowned ones only (none here).
      const theirsItems = await o.query<TodayItem[]>(o.other, 'crm.today', {});
      expect(theirsItems.map((i) => i.id).sort()).toEqual([`next-step:${((await o.stepsOf(otherQuiet.id))[0] as StepRow).id}`, `deal-closes:${mineElsewhere.id}`, `booking:${theirs}`].sort());
      expect(await o.query<TodayItem[]>(o.viewer, 'crm.today', {})).toEqual([]);
      expect(await o.query<TodayItem[]>(o.owner, 'crm.today', {})).toEqual([]);
      // A snoozed or done step leaves the read; a won deal does not close today.
      await o.snooze(o.member, [stepOfQuiet.id], 3);
      await o.done(o.member, [stepOfOverdue.id]);
      await o.exec(o.member, 'crm.deal.move', { dealId: closing.id, version: closing.version, stageId: (await o.stageNamed('Thắng')).id });
      expect((await o.query<TodayItem[]>(o.member, 'crm.today', {})).map((i) => i.id)).toEqual([`booking:${mine}`]);
    });

    it('groups a long list: twenty next steps, then one item that carries the rest as a count', async () => {
      const o = await org();
      const p = await o.party('Công ty N');
      for (let i = 0; i < 23; i++) await o.age((await o.newDeal(o.member, p)).id, 20);
      await o.raise();
      const items = await o.query<TodayItem[]>(o.member, 'crm.today', {});
      expect(items.filter((i) => i.id.startsWith('next-step:'))).toHaveLength(20);
      expect(items.find((i) => i.id === 'next-steps-more')).toMatchObject({ kind: 'flag', count: 3, title: { key: 'crm.nextStepsMore' } });
    });
  });
});
