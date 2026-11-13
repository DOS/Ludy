// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's draft of the follow-up of a "Cần theo dõi" step on PostgreSQL (#3101): crm.followup.source gives the facts of an open step (the contact, the days, the deal's sent quote with
// its exact total) and nothing else; the draft built around them holds the exact total and the link of an unanswered quote and of a quiet deal that has one; a model that states a figure or a link
// gets the fixed words with the same facts; with AI off the fixed words are used; nothing is sent (no mail row, no message) and no state changes but the link the member's own command makes; a
// viewer is refused, another org's step is not found, a decided quote's step has nothing to remind about. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxReader, crmFollowupDong, CRM_FOLLOWUP_TEMPLATE, type CrmFollowupGenerator } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, NextStepPage, PipelineStage, QuoteLinkCreated } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, quoteTokenHash, type FollowupSource } from '@crove/mod-crm';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { crmFollowupAi, draftCrmFollowup } from '../src/crm-followup-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
const PUBLIC_URL = 'https://app.example.test/';
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const GOOD_WORDS = { lead: 'Bên mình nhắn để hỏi xem anh/chị đã xem báo giá chưa, thông tin nằm ngay bên dưới.', closing: 'Rất mong nhận được phản hồi của anh/chị.' };

suite('the follow-up draft of a next step on PostgreSQL (#3101)', () => {
  const dbName = `crove_test_crm_followup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@followup.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const [member, viewer] = [await person('member'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const party = (name: string, email: string | null = null) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'organization', $3) RETURNING id", [orgId, name, email]).then((r) => (r[0] as { id: string }).id);
    const newDeal = async (user: string, partyId: string, over: Record<string, unknown> = {}) => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      return exec<Deal>(user, 'crm.deal.create', { partyId, title: 'Cơ hội nội bộ XYZZY', amount: '15000000', expectedClose: null, ...over });
    };
    const age = (dealId: string, days: number) => rows('UPDATE crove_crm.deal SET updated_at = now() - make_interval(days => $3) WHERE org_id = $1 AND id = $2', [orgId, dealId, days]);
    const raise = () => worker.execute<{ raised: number; closed: number }>('crm.next_step.raise', {}, { actor: SYSTEM, orgId });
    const stepOf = async (dealId: string) => (await rows<{ id: string; reason: string }>("SELECT id, reason FROM crove_crm.deal_next_step WHERE org_id = $1 AND deal_id = $2 AND status = 'open'", [orgId, dealId]))[0] as { id: string; reason: string };
    // A quote as a person makes it (two lines, so the total has a VAT part), then sent as the database owner makes a send: `sentDaysAgo` days ago, valid until `validIn` days from today.
    const sentQuote = async (dealId: string, sentDaysAgo: number, validIn: number, number = `BG-2026-${Math.floor(Math.random() * 9000) + 1000}`) => {
      const draft = await exec<{ id: string }>(member, 'crm.quote.save', { dealId, lines: [{ kind: 'item', description: 'Bánh Tết', unit: 'hộp', quantity: '3', unitPrice: '1234567', vatRate: '8%' }, { kind: 'item', description: 'Túi quà', unit: 'cái', quantity: '2', unitPrice: '55000', vatRate: '10%' }] });
      await rows(
        "UPDATE crove_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [orgId, draft.id, number, sentDaysAgo, validIn],
      );
      const total = (await rows<{ total: string }>('SELECT total::text AS total FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [orgId, draft.id]))[0]?.total as string;
      return { id: draft.id, number, total };
    };
    const source = (user: string, nextStepId: string) => query<FollowupSource>(user, 'crm.followup.source', { nextStepId });
    // The draft as the API builds it: the facts by the query, the link by the member's own command, the words by a model that is told none of them.
    const draft = (user: string, nextStepId: string, reader: ConstructorParameters<typeof InboxReader>[1] | null, hint?: string) =>
      source(user, nextStepId).then((facts) =>
        draftCrmFollowup(
          {
            ai: crmFollowupAi(reader ? new InboxReader(CONFIG, reader) : null, new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 })),
            publicUrl: PUBLIC_URL,
            makeLink: (quoteId) => exec<QuoteLinkCreated>(user, 'crm.quote.create_link', { quoteId }),
          },
          orgId,
          user,
          facts,
          hint,
        ),
      );
    const links = () => rows<{ token_sha256: string }>('SELECT token_sha256 FROM crove_crm.quote_link WHERE org_id = $1', [orgId]);
    const sentCount = async () => ({
      mail: (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.mail_message WHERE org_id = $1', [orgId]))[0]?.n,
      messages: (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.conversation_message WHERE org_id = $1', [orgId]))[0]?.n,
    });
    return { orgId, owner, member, viewer, exec, query, party, newDeal, age, raise, stepOf, sentQuote, source, draft, links, sentCount };
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
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
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

  it('gives an unanswered quote a draft that holds its exact total, number and link, and the words of the model around them', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai', 'hoamai@khach.test');
    const deal = await o.newDeal(o.member, party);
    const quote = await o.sentQuote(deal.id, 6, 20, 'BG-2026-0042');
    await o.raise();
    const step = await o.stepOf(deal.id);
    expect(step.reason).toBe('quote_unanswered');

    const facts = await o.source(o.member, step.id);
    expect(facts).toMatchObject({ nextStepId: step.id, reason: 'quote_unanswered', dealId: deal.id, contactName: 'Công ty Hoa Mai', contactEmail: 'hoamai@khach.test', days: 6, quote: { id: quote.id, label: 'BG-2026-0042', total: quote.total } });
    expect(facts.orgName).not.toBe('');
    // The facts hold no customer message, tax code, address, phone or the deal's own title.
    expect(JSON.stringify(facts)).not.toContain('XYZZY');

    const asked: Array<Parameters<CrmFollowupGenerator>[0]> = [];
    const crmFollowup: CrmFollowupGenerator = async (args) => {
      asked.push(args);
      return { output: GOOD_WORDS, usage: { inputTokens: 5, outputTokens: 5 } };
    };
    const got = await o.draft(o.member, step.id, { crmFollowup }, 'khách quen');
    expect(got).toMatchObject({ ai: 'used', reason: 'quote_unanswered', email: 'hoamai@khach.test', quoteId: quote.id, hasLink: true, subject: 'Về báo giá số BG-2026-0042' });
    // The exact total (a decimal string, written in dong by code), the number and the contact are the books'.
    expect(got.text).toContain(crmFollowupDong(quote.total));
    expect(got.text).toContain('Báo giá số BG-2026-0042');
    expect(got.text.startsWith('Chào Công ty Hoa Mai,')).toBe(true);
    expect(got.text).toContain(GOOD_WORDS.lead);
    expect(got.text).toContain('Bên mình đã gửi báo giá cách đây 6 ngày');
    // The link is a real one: its token is in the text, and the database holds only its hash.
    const url = /https:\/\/app\.example\.test\/-\/quote#([A-Za-z0-9_-]+)/.exec(got.text);
    expect(url).not.toBeNull();
    expect((await o.links()).map((l) => l.token_sha256)).toContain(quoteTokenHash(url?.[1] as string));
    // The model was told none of it.
    const told = `${asked[0]?.system}\n${asked[0]?.prompt}`;
    for (const secret of ['Hoa Mai', 'BG-2026-0042', quote.total, url?.[1] as string, 'hoamai@khach.test']) expect(told).not.toContain(secret);
    expect(told).toContain('khách quen');
  });

  it('gives a quiet deal that has a sent quote the same exact total and link, and a quiet deal with no quote neither', async () => {
    const o = await org();
    const party = await o.party('Anh Bình');
    const quiet = await o.newDeal(o.member, party, { title: 'Đơn lẻ' });
    await o.age(quiet.id, 30);
    // A quote sent today: the quote rule raises nothing for it, the stale rule raises the quiet deal.
    const quote = await o.sentQuote(quiet.id, 0, 20, 'BG-2026-0100');
    await o.age(quiet.id, 30);
    const bare = await o.newDeal(o.member, await o.party('Chị Lan'), { title: 'Chưa báo giá' });
    await o.age(bare.id, 40);
    await o.raise();
    const quietStep = await o.stepOf(quiet.id);
    const bareStep = await o.stepOf(bare.id);
    expect([quietStep.reason, bareStep.reason]).toEqual(['no_activity', 'no_activity']);

    const withQuote = await o.draft(o.member, quietStep.id, null);
    expect(withQuote).toMatchObject({ ai: 'off', reason: 'no_activity', quoteId: quote.id, hasLink: true, email: null });
    expect(withQuote.text).toContain('Đã 30 ngày hai bên chưa trao đổi thêm.');
    expect(withQuote.text).toContain(crmFollowupDong(quote.total));
    expect(withQuote.text).toContain('https://app.example.test/-/quote#');

    const linksBefore = (await o.links()).length;
    const without = await o.draft(o.member, bareStep.id, null);
    expect(without).toMatchObject({ ai: 'off', quoteId: null, hasLink: false });
    expect(without.text).toContain('Đã 40 ngày hai bên chưa trao đổi thêm.');
    expect(without.text).not.toContain('đồng');
    expect(without.text).not.toContain('http');
    expect(await o.links()).toHaveLength(linksBefore);
  });

  it('uses the fixed words, with the same facts, when AI is off, and when the model states a figure, a link or a name (a tampered draft is refused)', async () => {
    const o = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai'));
    const quote = await o.sentQuote(deal.id, 7, 20, 'BG-2026-0200');
    await o.raise();
    const step = await o.stepOf(deal.id);
    const fixed = CRM_FOLLOWUP_TEMPLATE.quote_unanswered;

    const off = await o.draft(o.member, step.id, null);
    expect(off.ai).toBe('off');
    expect(off.text).toContain(fixed.lead);
    expect(off.text).toContain(fixed.closing);
    expect(off.text).toContain(crmFollowupDong(quote.total));

    const lies: Array<[string, { lead: string; closing: string }]> = [
      ['a figure', { lead: 'Giảm 20% nếu chốt hôm nay, tổng chỉ còn 100.000 đồng.', closing: GOOD_WORDS.closing }],
      ['a link', { lead: GOOD_WORDS.lead, closing: 'Thanh toán tại https://pay.example.cn/x nhé.' }],
      ['the contact', { lead: 'Chào chị Hoa Mai nhé, bên mình nhắn về báo giá.', closing: GOOD_WORDS.closing }],
    ];
    for (const [, words] of lies) {
      const crmFollowup: CrmFollowupGenerator = async () => ({ output: words, usage: { inputTokens: 1, outputTokens: 1 } });
      const got = await o.draft(o.member, step.id, { crmFollowup });
      expect(got.ai).toBe('failed');
      expect(got.text).toContain(fixed.lead);
      expect(got.text).not.toMatch(/20%|100\.000|pay\.example|chị Hoa Mai/);
      expect(got.text).toContain(crmFollowupDong(quote.total));
      expect(got.text).toContain('https://app.example.test/-/quote#');
    }

    const failing: CrmFollowupGenerator = async () => {
      throw new Error('model down');
    };
    expect((await o.draft(o.member, step.id, { crmFollowup: failing })).ai).toBe('failed');
  });

  it('sends nothing and changes nothing but the link the member makes: no mail, no message, no new deal or step state', async () => {
    const o = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai', 'hoamai@khach.test'));
    await o.sentQuote(deal.id, 6, 20);
    await o.raise();
    const step = await o.stepOf(deal.id);
    const before = { sent: await o.sentCount(), step: await rows('SELECT status, snoozed_until, resolved_at FROM crove_crm.deal_next_step WHERE org_id = $1 AND id = $2', [o.orgId, step.id]), deal: await rows('SELECT updated_at, stage_id FROM crove_crm.deal WHERE org_id = $1 AND id = $2', [o.orgId, deal.id]), quote: await rows('SELECT status, version, sent_at FROM crove_crm.quote WHERE org_id = $1', [o.orgId]) };
    const crmFollowup: CrmFollowupGenerator = async () => ({ output: GOOD_WORDS, usage: { inputTokens: 1, outputTokens: 1 } });
    await o.draft(o.member, step.id, { crmFollowup });
    expect(await o.sentCount()).toEqual(before.sent);
    expect(await rows('SELECT status, snoozed_until, resolved_at FROM crove_crm.deal_next_step WHERE org_id = $1 AND id = $2', [o.orgId, step.id])).toEqual(before.step);
    expect(await rows('SELECT updated_at, stage_id FROM crove_crm.deal WHERE org_id = $1 AND id = $2', [o.orgId, deal.id])).toEqual(before.deal);
    expect(await rows('SELECT status, version, sent_at FROM crove_crm.quote WHERE org_id = $1', [o.orgId])).toEqual(before.quote);
    // The one write is the link, by the member's own command, audited without a price or a word of the draft.
    const audit = await rows<{ actor_id: string; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.quote.create_link'", [o.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(o.member);
    expect(JSON.stringify(audit[0]?.detail)).not.toMatch(/Hoa Mai|đồng|Bên mình/);
  });

  it('counts the days left for an expiring quote and refuses a step with nothing to remind about', async () => {
    const o = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai'));
    const quote = await o.sentQuote(deal.id, 1, 2);
    await o.raise();
    const step = await o.stepOf(deal.id);
    expect(step.reason).toBe('quote_expiring');
    const got = await o.draft(o.member, step.id, null);
    expect(got.text).toContain('Báo giá còn hiệu lực 2 ngày nữa.');

    // The quote is declined: nobody waits for it, and the step has nothing to remind about until the daily run closes it.
    await rows("UPDATE crove_crm.quote SET status = 'declined', decided_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, quote.id]);
    await expect(o.source(o.member, step.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_WAITING' });
    await o.raise();
    await expect(o.source(o.member, step.id)).rejects.toMatchObject({ code: 'NEXT_STEP_NOT_OPEN' });
  });

  it('takes the days and the quote of one draft from the same quote: a revision sent later, two sent quotes, and an expired quote', async () => {
    const o = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai'));
    // An old quote (sent 9 days ago) raises the step; a revision sent yesterday does not close it, and must not be told as "9 days ago".
    const old = await o.sentQuote(deal.id, 9, 20, 'BG-2026-0300');
    await o.raise();
    const step = await o.stepOf(deal.id);
    expect(step.reason).toBe('quote_unanswered');
    const revision = await o.sentQuote(deal.id, 1, 25, 'BG-2026-0301');
    const facts = await o.source(o.member, step.id);
    // The unanswered step is about the quote sent longest ago, and its days are that quote's own.
    expect(facts.quote?.id).toBe(old.id);
    expect(facts.quote?.label).toBe('BG-2026-0300');
    expect(facts.days).toBe(9);
    expect(revision.id).not.toBe(old.id);

    // The old quote expires (its last day was yesterday): it is no longer reminded about, and the revision still is not the quote of an unanswered step's days.
    await rows("UPDATE crove_crm.quote SET valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1 WHERE org_id = $1 AND id = $2", [o.orgId, old.id]);
    const after = await o.source(o.member, step.id);
    expect(after.quote?.id).toBe(revision.id);
    expect(after.days).toBe(1);
    // With every sent quote expired there is nothing to remind about, and no link is made.
    await rows("UPDATE crove_crm.quote SET valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1 WHERE org_id = $1 AND id = $2", [o.orgId, revision.id]);
    await expect(o.source(o.member, step.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_WAITING' });
    expect(await o.links()).toHaveLength(0);
  });

  it('gives a draft with no link, not an error, when the quote already has the most live links', async () => {
    const o = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai'));
    const quote = await o.sentQuote(deal.id, 6, 20, 'BG-2026-0400');
    await o.raise();
    const step = await o.stepOf(deal.id);
    for (let i = 0; i < 20; i += 1) {
      const made = await o.exec<QuoteLinkCreated>(o.member, 'crm.quote.create_link', { quoteId: quote.id }).catch((e: { code?: string }) => e);
      if ('code' in made) break;
    }
    const got = await o.draft(o.member, step.id, null);
    expect(got.hasLink).toBe(false);
    expect(got.quoteId).toBe(quote.id);
    expect(got.text).toContain(crmFollowupDong(quote.total));
    expect(got.text).not.toContain('http');
  });

  it('refuses a viewer, does not find another org\'s step or an unknown one, and a second org sees only its own', async () => {
    const o = await org();
    const other = await org();
    const deal = await o.newDeal(o.member, await o.party('Công ty Hoa Mai'));
    await o.sentQuote(deal.id, 6, 20);
    await o.raise();
    const step = await o.stepOf(deal.id);
    await expect(o.source(o.viewer, step.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(other.source(other.owner, step.id)).rejects.toMatchObject({ code: 'NEXT_STEP_NOT_FOUND' });
    await expect(o.source(o.owner, randomUUID())).rejects.toMatchObject({ code: 'NEXT_STEP_NOT_FOUND' });
    expect((await o.source(o.owner, step.id)).nextStepId).toBe(step.id);
  });

  it('lists the steps of one contact only (the conversation\'s panel), for every role', async () => {
    const o = await org();
    const [a, b] = [await o.party('Công ty A'), await o.party('Công ty B')];
    const [da, db2] = [await o.newDeal(o.member, a, { title: 'Của A' }), await o.newDeal(o.member, b, { title: 'Của B' })];
    await o.age(da.id, 30);
    await o.age(db2.id, 30);
    await o.raise();
    const mineA = await o.query<NextStepPage>(o.owner, 'crm.next_step.list', { scope: 'all', partyId: a });
    expect(mineA.items.map((s) => s.dealId)).toEqual([da.id]);
    expect(mineA.counts.all).toBe(2);
    expect((await o.query<NextStepPage>(o.viewer, 'crm.next_step.list', { scope: 'all', partyId: b })).items.map((s) => s.dealId)).toEqual([db2.id]);
    expect((await o.query<NextStepPage>(o.owner, 'crm.next_step.list', { scope: 'all' })).items).toHaveLength(2);
  });
});
