// SPDX-License-Identifier: AGPL-3.0-only
// Vy's reply drafts and the saved replies on PostgreSQL 17 (CV8, #2310): a member asks, a system job writes the tainted draft and a person decides; no
// text of the customer or of Vy reaches an audit row, an event, a job or a log; the draft is read by those who read the thread and written by the system
// alone (the guard trigger and the row policies); a new customer message makes it stale; a reply that began from it records only lengths; the draft is
// deleted with its thread; the owner's switch and the model's absence leave a thread with no draft and no alarm. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiUsage, ReplyDraftRequest, ReplyDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ConversationDetail, ConversationEvent, SavedReplyListed } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { failUndraftable, requestDueConversationDrafts, runConversationDraft, sweepConversationDrafts, type ConversationDraftJob } from '../src/conversations-worker.ts';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

// What the customer wrote and what Vy wrote in these tests: none of it may be found in an audit row, an event or a log.
const CUSTOMER_TEXT = 'Áo thun cotton này giá bao nhiêu vậy shop? (bí mật của khách 777)';
const DRAFT_TEXT = 'Dạ áo thun cotton giá [giá] ạ, bạn cần size nào ạ?';

suite('Vy’s drafts and the saved replies on PostgreSQL (CV8, #2310)', () => {
  const dbName = `crove_test_conversation_drafts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
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
  // Rows aged past the guard that keeps created_at: a superuser's session skips triggers, as a restore would.
  const asOwnerSql = (text: string, params: unknown[] = []) =>
    admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      return (await c.query(text, params)).rows;
    });
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

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; desk: string; connectionId: string };
  const person = async (name: string) => (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@drafts.test`, name: null })) as string;
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [adm, member, viewer, desk] = [await person('admin'), await person('member'), await person('viewer'), await person('desk')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')", [orgId, adm, member, viewer, desk]);
    const connectionId = randomUUID();
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'zalo_oa', $3, 'Zalo thử', $4)", [orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, owner]);
    return { orgId, owner, admin: adm, member, viewer, desk, connectionId };
  }

  let tick = 0;
  const event = (threadId: string, text = CUSTOMER_TEXT, extra: Partial<ConversationEvent> = {}): ConversationEvent => ({
    kind: 'direct',
    threadId,
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: `u-${threadId}`, name: `Khách ${threadId}` },
    text,
    // Ten minutes ago: past the relay's quiet period of 20 seconds, within the reply window.
    at: new Date(Date.now() - 600_000 + tick * 100).toISOString(),
    ...extra,
  });
  const ingest = (o: Org, events: ConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const threadOf = async (o: Org, external: string) => ((await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, external]))[0] as { id: string }).id;
  const detail = (o: Org, id: string, user = o.owner) => rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: id }, { actor: asUser(user), orgId: o.orgId });
  const drafts = (o: Org) =>
    rows<{ id: string; state: string; body: string | null; source: string; tainted: boolean; draft_length: number | null; final_length: number | null; edit_size: number | null; basis_seq: number }>(
      'SELECT id, state, body, source, tainted, draft_length, final_length, edit_size, basis_seq FROM crove_kernel.conversation_draft WHERE org_id = $1 ORDER BY created_at, id',
      [o.orgId],
    );
  const request = (o: Org, conversationId: string, user = o.owner) => rt.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId }, { actor: asUser(user), orgId: o.orgId });

  // A stand-in for the model: what it answers, what it was asked, and the tokens it reports.
  function model(answer: ReplyDraftResult | Error, usage: AiUsage = { inputTokens: 1000, outputTokens: 200 }) {
    const asked: ReplyDraftRequest[] = [];
    const writer = {
      draft: async (req: ReplyDraftRequest, onUsage?: (u: AiUsage) => void): Promise<ReplyDraftResult> => {
        asked.push(req);
        onUsage?.(usage);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { asked, writer };
  }
  const written: ReplyDraftResult = { kind: 'draft', body: DRAFT_TEXT };
  const PRICE = { inputPerMTok: '1000', outputPerMTok: '3000' };
  const jobOf = (o: Org, draftId: string, conversationId: string): ConversationDraftJob => ({ orgId: o.orgId, draftId, conversationId });
  const run = (o: Org, w: ReturnType<typeof model>['writer'], draftId: string, conversationId: string, limits?: { ai_cost: string }) =>
    runConversationDraft({ runtime: worker, writer: w, aiPrice: PRICE, ...(limits ? { limits: limits as never } : {}) }, jobOf(o, draftId, conversationId));

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
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
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

  describe('the saved replies', () => {
    it('are written by owners, admins and members, read by every member, and offered beside the draft by the words they answer', async () => {
      const o = await org();
      const create = (user: string, input: Record<string, unknown>) => rt.execute<{ id: string }>('kernel.conversation.saved_reply_create', input, { actor: asUser(user), orgId: o.orgId });
      const price = await create(o.member, { title: 'Giá áo thun', body: 'Áo thun cotton giá 150.000đ ạ', keywords: ['giá', 'bao nhiêu', 'gia ', 'GIÁ'] });
      await create(o.owner, { title: 'Địa chỉ', body: 'Shop ở 12 Lê Lợi ạ', keywords: ['địa chỉ', 'ở đâu'] });
      await create(o.admin, { title: 'Giờ mở cửa', body: 'Shop mở cửa 8h đến 21h ạ', keywords: ['giờ mở cửa'] });
      // A viewer writes none.
      await expect(create(o.viewer, { title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(asMember(o.orgId, o.viewer, (c) => c.query("INSERT INTO crove_kernel.saved_reply (org_id, title, body) VALUES ($1, 'x', 'y')", [o.orgId]))).rejects.toMatchObject({ code: '42501' });
      const list = await rt.query<SavedReplyListed>('kernel.conversation.saved_reply_list', {}, { actor: asUser(o.viewer), orgId: o.orgId });
      expect(list.replies.map((r) => r.title)).toEqual(['Địa chỉ', 'Giá áo thun', 'Giờ mở cửa']);
      // The keywords are cleaned: the empty ones and the repeats (after the matching's own reading) are dropped.
      expect(list.replies.find((r) => r.title === 'Giá áo thun')?.keywords).toEqual(['GIÁ', 'bao nhiêu']);
      // The thread's last customer message names the price: that reply is offered, the others are not.
      await ingest(o, [event('match')]);
      const id = await threadOf(o, 'match');
      expect((await detail(o, id)).suggestions.map((s) => s.title)).toEqual(['Giá áo thun']);
      // Update and delete by a member; a missing one is a not found, never a silent success.
      await rt.execute('kernel.conversation.saved_reply_update', { id: price.id, title: 'Giá mới', body: 'Giá 160.000đ ạ', keywords: ['giá'] }, { actor: asUser(o.member), orgId: o.orgId });
      expect((await detail(o, id)).suggestions.map((s) => s.title)).toEqual(['Giá mới']);
      await rt.execute('kernel.conversation.saved_reply_delete', { id: price.id }, { actor: asUser(o.member), orgId: o.orgId });
      await expect(rt.execute('kernel.conversation.saved_reply_delete', { id: price.id }, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'SAVED_REPLY_NOT_FOUND' });
      expect((await detail(o, id)).suggestions).toEqual([]);
      // No text in the audit row of a write: ids and lengths.
      const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.conversation.saved_reply_%'", [o.orgId]));
      expect(audit).not.toContain('Áo thun cotton');
      expect(audit).not.toContain('Giá áo thun');
    });

    it('are limited to 200 an org', async () => {
      const o = await org();
      await rows("INSERT INTO crove_kernel.saved_reply (org_id, title, body) SELECT $1, 'Mẫu ' || g, 'Nội dung' FROM generate_series(1, 200) g", [o.orgId]);
      await expect(rt.execute('kernel.conversation.saved_reply_create', { title: 'Thêm', body: 'x' }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'SAVED_REPLY_LIMIT' });
    });
  });

  describe('asking for a draft and the job that writes it', () => {
    it('a member asks, the job writes a tainted draft, and the thread shows it with the saved replies that fit; ids only in the event and the audit row, no text anywhere', async () => {
      const o = await org();
      await rt.execute('kernel.conversation.saved_reply_create', { title: 'Giá áo thun', body: 'Áo thun cotton giá 150.000đ ạ', keywords: ['giá'] }, { actor: asUser(o.owner), orgId: o.orgId });
      await ingest(o, [event('a')]);
      const id = await threadOf(o, 'a');
      const asked = await request(o, id);
      expect(asked.queued).toBe(true);
      // Asked again: the same draft, nothing queued twice.
      expect(await request(o, id)).toEqual({ draftId: asked.draftId, queued: false });
      expect((await detail(o, id)).draft).toEqual({ id: asked.draftId, state: 'requested', source: 'asked', body: null, tainted: true });
      const events = await rows<{ payload: unknown }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.draft_queued'", [o.orgId]);
      expect(events.map((e) => e.payload)).toEqual([{ draftId: asked.draftId, conversationId: id }]);
      // The job: the model is told the end of the thread and the saved replies that fit, in Vietnamese, within the channel's limit.
      const m = model(written);
      expect(await run(o, m.writer, asked.draftId, id)).toBe('written');
      expect(m.asked).toHaveLength(1);
      expect(m.asked[0]).toMatchObject({ language: 'vi', maxChars: 2000, customerName: 'Khách a', messages: [{ from: 'customer', text: CUSTOMER_TEXT }], savedReplies: [{ title: 'Giá áo thun' }] });
      const [row] = await drafts(o);
      expect(row).toMatchObject({ id: asked.draftId, state: 'live', body: DRAFT_TEXT, source: 'asked', tainted: true, basis_seq: 1 });
      const shown = await detail(o, id);
      expect(shown.draft).toEqual({ id: asked.draftId, state: 'live', source: 'asked', body: DRAFT_TEXT, tainted: true });
      expect(shown.suggestions.map((s) => s.title)).toEqual(['Giá áo thun']);
      // The cost of the call counts against the org's AI cost limit: (1000 x 1000 + 200 x 3000) / 1e6.
      expect(Number((await rows<{ amount: string }>("SELECT sum(amount)::text AS amount FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'", [o.orgId]))[0]?.amount)).toBeCloseTo(1.6, 6);
      // Nobody's text in an audit row or an event: the customer's and Vy's (ids, lengths and codes only).
      const leaks = await rows<{ n: string }>(
        `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND (detail::text LIKE '%777%' OR detail::text LIKE '%cotton%' OR detail::text LIKE '%Dạ áo%'))
              + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND (payload::text LIKE '%777%' OR payload::text LIKE '%cotton%' OR payload::text LIKE '%Dạ áo%')) AS n`,
        [o.orgId],
      );
      expect(Number(leaks[0]?.n)).toBe(0);
      const [audit] = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.draft_record' AND outcome = 'ok'", [o.orgId]);
      expect(audit?.detail).toMatchObject({ draft_id: asked.draftId, outcome: 'written', length: DRAFT_TEXT.length });
    });

    it('asks nothing of a thread whose last message is not a customer’s, nor of one the member may not read or write', async () => {
      const o = await org();
      await ingest(o, [event('b')]);
      const id = await threadOf(o, 'b');
      // A private message is read by owners and admins and holders of the direct-message permission: a plain member finds none, a viewer may not write.
      await expect(request(o, id, o.desk)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
      await expect(request(o, id, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await request(o, id, o.admin)).queued).toBe(true);
      // The business answered last: nothing to draft.
      await rows("UPDATE crove_kernel.conversation_draft SET state = 'discarded' WHERE org_id = $1", [o.orgId]);
      await rt.execute('kernel.conversation.reply', { conversationId: id, body: 'Dạ shop trả lời ạ', lastSeenSeq: 1 }, { actor: asUser(o.owner), orgId: o.orgId });
      await expect(request(o, id)).rejects.toMatchObject({ code: 'DRAFT_NOT_NEEDED' });
    });

    it('leaves no draft, with no alarm, when the model fails, is refused by its own checks, or the org is over its AI cost limit', async () => {
      const o = await org();
      const cases: Array<[string, ReplyDraftResult | Error, string]> = [
        ['err', new Error('boom: prompt text 777 leaked in the error'), 'error'],
        ['figures', { kind: 'none', code: 'FIGURES' }, 'none'],
        ['empty', { kind: 'none', code: 'EMPTY' }, 'none'],
      ];
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
      try {
        for (const [thread, answer, outcome] of cases) {
          await ingest(o, [event(thread)]);
          const id = await threadOf(o, thread);
          const asked = await request(o, id);
          expect(await run(o, model(answer).writer, asked.draftId, id), thread).toBe(outcome);
        }
      } finally {
        console.error = original;
      }
      expect((await drafts(o)).map((d) => [d.state, d.body])).toEqual([['discarded', null], ['discarded', null], ['discarded', null]]);
      // What an error said (it may quote the prompt) is never logged.
      expect(logged.join('\n')).not.toContain('777');
      // The failed call's tokens still count; once the org is over its limit the next draft is not asked of the model at all.
      await ingest(o, [event('limit')]);
      const id = await threadOf(o, 'limit');
      const asked = await request(o, id);
      const m = model(written);
      expect(await run(o, m.writer, asked.draftId, id, { ai_cost: '1' })).toBe('limit');
      expect(m.asked).toHaveLength(0);
      expect((await drafts(o)).at(-1)?.state).toBe('discarded');
      const [audit] = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.draft_record' AND detail->>'code' = 'AI_LIMIT'", [o.orgId]);
      expect(audit?.detail).toMatchObject({ outcome: 'none', code: 'AI_LIMIT' });
    });

    it('is rationed by the existing per-minute draft budget of the org (ai-draft-limit.ts): over it no model call is made and the person can ask again', async () => {
      const o = await org();
      const budget = new DraftBudget({ perOrgPerMinute: 1 });
      const m = model(written);
      const make = async (thread: string) => {
        await ingest(o, [event(thread)]);
        const id = await threadOf(o, thread);
        return { id, asked: await request(o, id) };
      };
      const one = await make('r1');
      expect(await runConversationDraft({ runtime: worker, writer: m.writer, aiPrice: PRICE, budget }, jobOf(o, one.asked.draftId, one.id))).toBe('written');
      const two = await make('r2');
      expect(await runConversationDraft({ runtime: worker, writer: m.writer, aiPrice: PRICE, budget }, jobOf(o, two.asked.draftId, two.id))).toBe('rate');
      // One call was made; the refused draft is discarded with its code, and the thread can be asked about again (the member's own ask is rationed in the API).
      expect(m.asked).toHaveLength(1);
      expect((await drafts(o)).map((d) => d.state)).toEqual(['live', 'discarded']);
      const [audit] = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.draft_record' AND detail->>'code' = 'RATE_LIMITED'", [o.orgId]);
      expect(audit?.detail).toMatchObject({ outcome: 'none', code: 'RATE_LIMITED' });
      expect((await request(o, two.id)).queued).toBe(true);
    });

    it('settles a draft asked for where this worker has no model as none, so nothing waits for a job that will never exist', async () => {
      const o = await org();
      await ingest(o, [event('off')]);
      const id = await threadOf(o, 'off');
      const asked = await request(o, id);
      await failUndraftable(worker, jobOf(o, asked.draftId, id));
      expect((await drafts(o)).map((d) => d.state)).toEqual(['discarded']);
      expect((await detail(o, id)).draft).toBeNull();
      // Asked again, it can be.
      expect((await request(o, id)).queued).toBe(true);
    });

    it('goes stale, its text dropped, when the platform removes the message it answered or the page answers from its own inbox', async () => {
      const o = await org();
      const removable = event('rm');
      await ingest(o, [removable]);
      const rm = await threadOf(o, 'rm');
      const a = await request(o, rm);
      expect(await run(o, model(written).writer, a.draftId, rm)).toBe('written');
      // The customer deletes the message: its body goes, and the draft Vy wrote from it with it.
      await ingest(o, [{ ...removable, removed: true, text: '' }]);
      expect((await drafts(o)).map((d) => [d.state, d.body])).toEqual([['stale', null]]);
      // The page answers from its own inbox (an echo that is not a reply of ours): the message is answered, so the draft is stale.
      await ingest(o, [event('echo')]);
      const echo = await threadOf(o, 'echo');
      const b = await request(o, echo);
      expect(await run(o, model(written).writer, b.draftId, echo)).toBe('written');
      await ingest(o, [event('echo', 'Dạ shop trả lời ở Zalo rồi ạ', { direction: 'out' })]);
      expect((await drafts(o)).map((d) => [d.state, d.body])).toEqual([['stale', null], ['stale', null]]);
    });

    it('does not stop the removal of a member who asked for a draft: the name goes, the draft stays whatever its state', async () => {
      const o = await org();
      const asker = await person('asker');
      await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [o.orgId, asker]);
      await ingest(o, [event('gone1'), event('gone2')]);
      const [g1, g2] = [await threadOf(o, 'gone1'), await threadOf(o, 'gone2')];
      const asked = await request(o, g1, asker);
      expect(await run(o, model(written).writer, asked.draftId, g1)).toBe('written');
      const used = await request(o, g2, asker);
      expect(await run(o, model(written).writer, used.draftId, g2)).toBe('written');
      await rt.execute('kernel.conversation.reply', { conversationId: g2, body: 'Dạ vâng ạ', lastSeenSeq: 1, draftId: used.draftId }, { actor: asUser(o.owner), orgId: o.orgId });
      // The member is removed: the foreign key clears who asked, on a live draft and on a decided one, and nothing else of them changes.
      await rows('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, asker]);
      const after = await rows<{ state: string; requested_by: string | null; body: string | null }>('SELECT state, requested_by, body FROM crove_kernel.conversation_draft WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
      expect(after).toEqual([{ state: 'live', requested_by: null, body: DRAFT_TEXT }, { state: 'used', requested_by: null, body: null }]);
    });

    it('goes stale, its text dropped, when the customer writes again, and a job that outlived it writes nothing', async () => {
      const o = await org();
      await ingest(o, [event('c')]);
      const id = await threadOf(o, 'c');
      const first = await request(o, id);
      const m = model(written);
      expect(await run(o, m.writer, first.draftId, id)).toBe('written');
      await ingest(o, [event('c', 'Mà shop có giao tận nơi không?')]);
      expect((await drafts(o)).map((d) => [d.state, d.body])).toEqual([['stale', null]]);
      expect((await detail(o, id)).draft).toBeNull();
      // A job for the stale draft finds nothing to do and the model is not called.
      expect(await run(o, m.writer, first.draftId, id)).toBe('gone');
      expect(m.asked).toHaveLength(1);
      // A draft asked for while the customer writes: the answer arrives after their next message, so it is stale and keeps no text.
      const second = await request(o, id);
      await ingest(o, [event('c', 'Cho mình hỏi thêm cái nữa')]);
      expect(await run(o, model(written).writer, second.draftId, id)).toBe('gone');
      expect((await drafts(o)).map((d) => [d.state, d.body])).toEqual([['stale', null], ['stale', null]]);
    });
  });

  describe('who writes what of a draft', () => {
    it('is read by those who read the thread and written by the system: a member cannot put text in a draft, make one live, ask in another’s name or change a decided one', async () => {
      const o = await org();
      await ingest(o, [event('g')]);
      const id = await threadOf(o, 'g');
      await request(o, id);
      const [thread] = await rows<{ channel_connection_id: string }>('SELECT channel_connection_id FROM crove_kernel.conversation WHERE org_id = $1 AND id = $2', [o.orgId, id]);
      const insert = (user: string, values: { state?: string; body?: string | null; source?: string; by?: string }) =>
        asMember(o.orgId, user, (c) =>
          c.query(
            `INSERT INTO crove_kernel.conversation_draft (org_id, conversation_id, channel_connection_id, kind, basis_seq, source, requested_by, state, body, tainted)
             VALUES ($1, $2, $3, 'direct', 1, $4, $5, $6, $7, true)`,
            [o.orgId, id, thread?.channel_connection_id, values.source ?? 'asked', values.by ?? user, values.state ?? 'requested', values.body ?? null],
          ),
        );
      // A second request is a second open draft: the unique index. One in another's name, with text, live or from the relay: the guard.
      await rows("UPDATE crove_kernel.conversation_draft SET state = 'discarded' WHERE org_id = $1", [o.orgId]);
      await expect(insert(o.owner, { by: o.admin })).rejects.toMatchObject({ code: '42501', message: 'DRAFT_FORBIDDEN' });
      await expect(insert(o.owner, { source: 'auto' })).rejects.toMatchObject({ code: '42501', message: 'DRAFT_FORBIDDEN' });
      await expect(insert(o.owner, { state: 'live', body: 'Vy nói giả' })).rejects.toMatchObject({ code: '42501' });
      await expect(insert(o.owner, { body: 'Chữ của tôi' })).rejects.toMatchObject({ code: '42501' });
      await expect(insert(o.viewer, {})).rejects.toMatchObject({ code: '42501' });
      await expect(insert(o.desk, {})).rejects.toMatchObject({ code: '42501' });
      // The system writes the text; a member's update of a requested draft to live, or with text, is refused; a decided draft never changes.
      const open = await request(o, id);
      await expect(asMember(o.orgId, o.owner, (c) => c.query("UPDATE crove_kernel.conversation_draft SET state = 'live', body = 'Vy nói giả' WHERE id = $1", [open.draftId]))).rejects.toMatchObject({ code: '42501', message: 'DRAFT_FORBIDDEN' });
      await expect(asMember(o.orgId, o.owner, (c) => c.query("UPDATE crove_kernel.conversation_draft SET tainted = false WHERE id = $1", [open.draftId]))).rejects.toBeTruthy();
      expect(await run(o, model(written).writer, open.draftId, id)).toBe('written');
      // Used without the lengths a reply records is no draft state the table accepts (the check), and the text of a live draft is the system's.
      await expect(asMember(o.orgId, o.owner, (c) => c.query("UPDATE crove_kernel.conversation_draft SET body = 'Sửa chữ của Vy' WHERE id = $1", [open.draftId]))).rejects.toMatchObject({ code: '42501', message: 'DRAFT_FORBIDDEN' });
      await expect(asMember(o.orgId, o.owner, (c) => c.query("UPDATE crove_kernel.conversation_draft SET state = 'used', body = NULL WHERE id = $1", [open.draftId]))).rejects.toMatchObject({ code: '23514' });
      expect((await drafts(o)).at(-1)).toMatchObject({ state: 'live', body: DRAFT_TEXT, tainted: true });
      // A member does not delete a draft row; the system does, in the thread's deletion.
      await expect(asMember(o.orgId, o.owner, (c) => c.query('DELETE FROM crove_kernel.conversation_draft'))).resolves.toMatchObject({ rowCount: 0 });
      // The agent write guard sits on both tables, as on every tenant table: an agent context is refused whatever the policies say.
      const guarded = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = 'agent_write_guard' AND c.relname IN ('conversation_draft', 'saved_reply') ORDER BY 1`,
      );
      expect(guarded.map((r) => r.relname)).toEqual(['conversation_draft', 'saved_reply']);
    });

    it('is read by owners and admins and by nobody else in a private thread: a member who may not read it sees no draft, in the table or the detail', async () => {
      const o = await org();
      await ingest(o, [event('h')]);
      const id = await threadOf(o, 'h');
      const asked = await request(o, id);
      expect(await run(o, model(written).writer, asked.draftId, id)).toBe('written');
      const count = (user: string) => asMember(o.orgId, user, async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.conversation_draft')).rows[0].n as number);
      expect(await count(o.owner)).toBe(1);
      expect(await count(o.admin)).toBe(1);
      expect(await count(o.desk)).toBe(0);
      expect(await count(o.viewer)).toBe(0);
      await expect(detail(o, id, o.desk)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    });
  });

  describe('a person decides', () => {
    it('a reply that began from the draft records only lengths and the size of the edit, drops the text, discards any other draft and counts the saved reply', async () => {
      const o = await org();
      const saved = await rt.execute<{ id: string }>('kernel.conversation.saved_reply_create', { title: 'Giá', body: 'Giá 150.000đ ạ', keywords: ['giá'] }, { actor: asUser(o.owner), orgId: o.orgId });
      await ingest(o, [event('d')]);
      const id = await threadOf(o, 'd');
      const asked = await request(o, id);
      expect(await run(o, model(written).writer, asked.draftId, id)).toBe('written');
      const sent = 'Dạ áo thun cotton giá 150.000đ ạ, bạn cần size nào ạ?';
      await rt.execute('kernel.conversation.reply', { conversationId: id, body: sent, lastSeenSeq: 1, draftId: asked.draftId, savedReplyId: saved.id }, { actor: asUser(o.owner), orgId: o.orgId });
      const [row] = await drafts(o);
      expect(row).toMatchObject({ id: asked.draftId, state: 'used', body: null, draft_length: DRAFT_TEXT.length, final_length: sent.length, tainted: true });
      // Between the common beginning and ending the draft has "[giá]" (5 characters) and the sent reply "150.000đ" (8): the edit is the larger.
      expect(row?.edit_size).toBe(8);
      expect((await rt.query<SavedReplyListed>('kernel.conversation.saved_reply_list', {}, { actor: asUser(o.owner), orgId: o.orgId })).replies[0]?.useCount).toBe(1);
      expect((await detail(o, id)).draft).toBeNull();
      // The audit row of the reply names the draft and the lengths, not a word of either text.
      const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.reply'", [o.orgId]));
      expect(audit).toContain(asked.draftId);
      expect(audit).not.toContain('cotton');
      expect(audit).not.toContain('Dạ');
    });

    it('a reply that did not begin from the live draft discards it, and a person can set a draft aside', async () => {
      const o = await org();
      await ingest(o, [event('e'), event('f')]);
      const [e, f] = [await threadOf(o, 'e'), await threadOf(o, 'f')];
      const a = await request(o, e);
      expect(await run(o, model(written).writer, a.draftId, e)).toBe('written');
      await rt.execute('kernel.conversation.reply', { conversationId: e, body: 'Tôi tự viết câu trả lời', lastSeenSeq: 1 }, { actor: asUser(o.owner), orgId: o.orgId });
      const b = await request(o, f);
      expect(await run(o, model(written).writer, b.draftId, f)).toBe('written');
      expect(await rt.execute('kernel.conversation.draft_discard', { draftId: b.draftId }, { actor: asUser(o.owner), orgId: o.orgId })).toEqual({ discarded: true });
      expect(await rt.execute('kernel.conversation.draft_discard', { draftId: b.draftId }, { actor: asUser(o.owner), orgId: o.orgId })).toEqual({ discarded: false });
      await expect(rt.execute('kernel.conversation.draft_discard', { draftId: randomUUID() }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
      expect((await drafts(o)).map((d) => [d.state, d.body, d.edit_size])).toEqual([['discarded', null, null], ['discarded', null, null]]);
      // A decided draft's text is gone, so a retention purge or an erasure has nothing of Vy's text to delete.
      expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.conversation_draft WHERE org_id = $1 AND body IS NOT NULL', [o.orgId]))[0]?.n).toBe('0');
    });
  });

  describe('new conversations', () => {
    it('are drafted for once each, when the org has not turned it off, the customer wrote last and no draft was decided for that message', async () => {
      const o = await org();
      await ingest(o, [event('n1'), event('n2'), event('n3')]);
      const [n1, n2, n3] = [await threadOf(o, 'n1'), await threadOf(o, 'n2'), await threadOf(o, 'n3')];
      // n3 is resolved: not new, nothing to answer.
      await rt.execute('kernel.conversation.resolve', { conversationId: n3 }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBeGreaterThanOrEqual(2);
      const mine = (await drafts(o)).map((d) => [d.state, d.source]);
      expect(mine).toEqual([['requested', 'auto'], ['requested', 'auto']]);
      // Listed once: the requests in play are not asked again, however often the relay passes.
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(0);
      const [first] = await drafts(o);
      expect(await run(o, model(written).writer, (first as { id: string }).id, n1)).toBe('written');
      // A draft a person discarded is not made again for the same message, but is for the next one.
      await rt.execute('kernel.conversation.draft_discard', { draftId: (first as { id: string }).id }, { actor: asUser(o.owner), orgId: o.orgId });
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(0);
      await ingest(o, [event('n1', 'Cho mình hỏi thêm')]);
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(1);
      void n2;
    });

    it('are not drafted for when an owner turns it off (a draft a member asks for is theirs), and the switch is the owners’ and admins’ alone', async () => {
      const o = await org();
      expect((await rt.query<{ autoDraft: boolean }>('kernel.conversation.auto_draft', {}, { actor: asUser(o.viewer), orgId: o.orgId })).autoDraft).toBe(true);
      await expect(rt.execute('kernel.conversation.auto_draft_set', { autoDraft: false }, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await rt.execute('kernel.conversation.auto_draft_set', { autoDraft: false }, { actor: asUser(o.admin), orgId: o.orgId });
      expect((await rt.query<{ autoDraft: boolean }>('kernel.conversation.auto_draft', {}, { actor: asUser(o.viewer), orgId: o.orgId })).autoDraft).toBe(false);
      await ingest(o, [event('off1')]);
      await requestDueConversationDrafts({ runtime: worker, workerDb, force: true });
      expect(await drafts(o)).toEqual([]);
      // The retention setting is left as it was (no row meant the default; the row the switch made keeps the default).
      expect((await rt.query<{ retentionMonths: number | null }>('kernel.conversation.retention', {}, { actor: asUser(o.owner), orgId: o.orgId })).retentionMonths).toBe(24);
      // A member's own ask still works.
      expect((await request(o, await threadOf(o, 'off1'), o.admin)).queued).toBe(true);
      await rt.execute('kernel.conversation.auto_draft_set', { autoDraft: true }, { actor: asUser(o.owner), orgId: o.orgId });
    });

    it('settles a request the job never answered, after fifteen minutes, so the conversation can be asked about again', async () => {
      const o = await org();
      await ingest(o, [event('lost')]);
      const id = await threadOf(o, 'lost');
      const asked = await request(o, id);
      await asOwnerSql("UPDATE crove_kernel.conversation_draft SET created_at = now() - interval '20 minutes' WHERE org_id = $1 AND id = $2", [o.orgId, asked.draftId]);
      // The list of conversations to draft for no longer settles anything (it is asked only where a model is configured); the sweep does.
      await requestDueConversationDrafts({ runtime: worker, workerDb, force: true });
      expect((await drafts(o)).map((d) => d.state)).toEqual(['requested']);
      expect((await sweepConversationDrafts({ workerDb, force: true })).settled).toBeGreaterThanOrEqual(1);
      expect((await drafts(o)).map((d) => d.state)).toEqual(['discarded']);
      // The same message is not drafted for again by the relay, but a person can ask.
      expect((await request(o, id)).queued).toBe(true);
    });

    it('is swept with no model configured: a live draft older than seven days loses its text and goes stale, and a request older than fifteen minutes is settled (ADR-0041)', async () => {
      // The relay runs sweepConversationDrafts whether or not the worker has a writer; here nothing but the sweep runs, as in a deployment with the model off.
      const o = await org();
      await ingest(o, [event('old-live'), event('old-ask'), event('fresh-live')]);
      const [oldLive, oldAsk, freshLive] = [await threadOf(o, 'old-live'), await threadOf(o, 'old-ask'), await threadOf(o, 'fresh-live')];
      const live = await request(o, oldLive);
      const ask = await request(o, oldAsk);
      const fresh = await request(o, freshLive);
      await asOwnerSql("UPDATE crove_kernel.conversation_draft SET state = 'live', body = $3, written_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2", [o.orgId, live.draftId, DRAFT_TEXT]);
      await asOwnerSql("UPDATE crove_kernel.conversation_draft SET created_at = now() - interval '20 minutes' WHERE org_id = $1 AND id = $2", [o.orgId, ask.draftId]);
      await asOwnerSql("UPDATE crove_kernel.conversation_draft SET state = 'live', body = $3, written_at = now() - interval '6 days' WHERE org_id = $1 AND id = $2", [o.orgId, fresh.draftId, DRAFT_TEXT]);
      // (The sweep is across orgs, so rows other tests aged count too: at least ours.)
      const swept = await sweepConversationDrafts({ workerDb, force: true });
      expect(swept.settled).toBeGreaterThanOrEqual(1);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      const states = Object.fromEntries((await drafts(o)).map((d) => [d.id, [d.state, d.body]]));
      expect(states[live.draftId]).toEqual(['stale', null]);
      expect(states[ask.draftId]).toEqual(['discarded', null]);
      // Six days old: still there.
      expect(states[fresh.draftId]).toEqual(['live', DRAFT_TEXT]);
      // Nothing left to do on a second pass, and the API login cannot run it.
      expect(await sweepConversationDrafts({ workerDb, force: true })).toEqual({ settled: 0, expired: 0 });
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_draft_sweep()')).rejects.toMatchObject({ code: '42501' });
    });

    it('waits for the customer to stop typing, drafts at most three times an hour for one conversation, skips a closed reply window, and lets a live draft nobody opened go stale after a week', async () => {
      const o = await org();
      // A message from a few seconds ago is not drafted for yet: a burst of messages is one draft, not one for each.
      await ingest(o, [event('quiet', CUSTOMER_TEXT, { at: new Date(Date.now() - 5_000).toISOString() })]);
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(0);
      const quiet = await threadOf(o, 'quiet');
      await asOwnerSql("UPDATE crove_kernel.conversation SET last_inbound_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [o.orgId, quiet]);
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(1);
      // A window the platform closed: nothing to draft for, by the relay or by a person.
      await ingest(o, [event('closed')]);
      const closed = await threadOf(o, 'closed');
      await asOwnerSql("UPDATE crove_kernel.conversation SET reply_window_until = now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, closed]);
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(0);
      await expect(request(o, closed)).rejects.toMatchObject({ code: 'REPLY_WINDOW_CLOSED' });
      // Three automatic drafts in the last hour for one conversation: no fourth, however many messages the customer sends.
      await ingest(o, [event('chatty')]);
      const chatty = await threadOf(o, 'chatty');
      for (let i = 0; i < 3; i++) {
        await asOwnerSql("INSERT INTO crove_kernel.conversation_draft (org_id, conversation_id, channel_connection_id, kind, basis_seq, source, state) SELECT org_id, id, channel_connection_id, kind, 1, 'auto', 'discarded' FROM crove_kernel.conversation WHERE org_id = $1 AND id = $2", [o.orgId, chatty]);
      }
      await ingest(o, [event('chatty', 'Còn nữa nè')]);
      expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBe(0);
      // A live draft nobody opened in a week goes stale, its text with it (the quiet thread's draft, asked for above, is made live and old).
      await asOwnerSql("UPDATE crove_kernel.conversation_draft SET state = 'live', body = $3, written_at = now() - interval '8 days' WHERE org_id = $1 AND conversation_id = $2 AND state = 'requested'", [o.orgId, quiet, DRAFT_TEXT]);
      await sweepConversationDrafts({ workerDb, force: true });
      expect((await drafts(o)).filter((d) => d.basis_seq === 1 && d.body !== null)).toEqual([]);
      expect((await rows<{ state: string; body: string | null }>('SELECT state, body FROM crove_kernel.conversation_draft WHERE org_id = $1 AND conversation_id = $2', [o.orgId, quiet])).map((d) => [d.state, d.body])).toEqual([['stale', null]]);
    });

    it('keeps the due list and the worker’s functions out of the API login’s reach', async () => {
      await expect(pool.query('SELECT * FROM crove_kernel.conversation_draft_due(10)')).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('the draft goes with its thread', () => {
    it('is deleted by the erasure of the customer, and listed in the export', async () => {
      const o = await org();
      await ingest(o, [event('x')]);
      const id = await threadOf(o, 'x');
      const asked = await request(o, id);
      expect(await run(o, model(written).writer, asked.draftId, id)).toBe('written');
      await rt.execute('kernel.conversation.erase_contact', { conversationId: id, confirm: true }, { actor: { ...asUser(o.owner), aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) }, orgId: o.orgId });
      expect(await drafts(o)).toEqual([]);
      expect(EXPORT_TABLE_NAMES).toEqual(expect.arrayContaining(['kernel.conversation_draft', 'kernel.saved_reply']));
    });
  });
});
