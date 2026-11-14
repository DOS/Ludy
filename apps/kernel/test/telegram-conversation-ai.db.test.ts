// SPDX-License-Identifier: AGPL-3.0-only
// The AI coworker on a Telegram bot chat (#3132, AGENTS.md "AI part named"): Dy drafts a reply for a new Telegram conversation through the AI
// budget meter (the org's `auto_draft` switch governs the automatic drafts), the saved replies and the {tên} placeholder work, the intent source is
// read for the suggestion, and a person presses Send: no draft is ever sent by itself, and with no model the inbox still takes the message and the
// reply. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metered, type AiUsage, type ReplyDraftRequest, type ReplyDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CONVERSATION_PROVIDER_RULES, type ConversationDetail, type ConversationEvent } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { failUndraftable, requestDueConversationDrafts, runConversationDraft } from '../src/conversations-worker.ts';
import { systemMeter } from '../src/ai-meter.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const CUSTOMER_TEXT = 'Áo thun cotton này giá bao nhiêu vậy shop? (bí mật của khách xyzzy)';
const DRAFT_TEXT = 'Dạ áo thun cotton giá [giá] ạ, bạn cần size nào ạ?';

suite('Dy on a Telegram bot chat on PostgreSQL (#3132)', () => {
  const dbName = `crove_test_telegram_ai_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
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

  type Org = { orgId: string; owner: string; member: string; connectionId: string };
  const person = async (name: string) => (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@telegram-ai.test`, name: null })) as string;
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
    const connectionId = randomUUID();
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'telegram', $3, 'Bot thử', $4)", [orgId, connectionId, `-100${Math.floor(Math.random() * 1e9)}`, owner]);
    return { orgId, owner, member, connectionId };
  }

  let tick = 0;
  const event = (chat: string, text = CUSTOMER_TEXT): ConversationEvent => ({
    kind: 'direct',
    threadId: chat,
    messageId: `${tick++}`,
    direction: 'in',
    contact: { id: chat, name: 'An Nguyễn' },
    text,
    // Ten minutes ago: past the relay's quiet period of 20 seconds.
    at: new Date(Date.now() - 600_000 + tick * 100).toISOString(),
  });
  const ingest = (o: Org, events: ConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events }, { actor: SYSTEM, orgId: o.orgId });
  const threadOf = async (o: Org, chat: string) => ((await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [o.orgId, chat]))[0] as { id: string }).id;
  const detail = (o: Org, id: string) => rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: id }, { actor: asUser(o.owner), orgId: o.orgId });
  const drafts = (o: Org) => rows<{ id: string; state: string; body: string | null; source: string; tainted: boolean }>('SELECT id, state, body, source, tainted FROM crove_kernel.conversation_draft WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
  const outgoing = (o: Org) => rows<{ send_state: string | null; body: string }>("SELECT send_state, body FROM crove_kernel.conversation_message WHERE org_id = $1 AND direction = 'out'", [o.orgId]);
  const queuedReplies = (o: Org) => rows("SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.conversation.reply_queued'", [o.orgId]);

  function model(answer: ReplyDraftResult, usage: AiUsage = { inputTokens: 1000, outputTokens: 200 }) {
    const asked: ReplyDraftRequest[] = [];
    const writer = {
      draft: async (req: ReplyDraftRequest, onUsage?: (u: AiUsage) => void): Promise<ReplyDraftResult> => {
        // The call goes through the AI budget meter's door, as the writer's default generator does.
        await metered('conversation.draft', async () => {
          asked.push(req);
          return { usage };
        });
        onUsage?.(usage);
        return answer;
      },
    };
    return { asked, writer };
  }
  const PRICE = { inputPerMTok: '1000', outputPerMTok: '3000' };
  const run = (o: Org, w: ReturnType<typeof model>['writer'], draftId: string, conversationId: string) => runConversationDraft({ runtime: worker, writer: w, meter: systemMeter(worker, { price: PRICE }) }, { orgId: o.orgId, draftId, conversationId });

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
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

  it('drafts a reply for a new Telegram conversation by itself, metered, within the channel limit, and sends nothing until a person does', async () => {
    const o = await org();
    await ingest(o, [event('501')]);
    const id = await threadOf(o, '501');
    expect(await requestDueConversationDrafts({ runtime: worker, workerDb, force: true })).toBeGreaterThanOrEqual(1);
    const [requested] = await drafts(o);
    expect(requested).toMatchObject({ state: 'requested', source: 'auto' });
    const m = model({ kind: 'draft', body: DRAFT_TEXT });
    expect(await run(o, m.writer, (requested as { id: string }).id, id)).toBe('written');
    // The model was told the thread's end and the customer's name, in Vietnamese, within Telegram's own limit (or the draft cap if that is smaller).
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatchObject({ language: 'vi', customerName: 'An Nguyễn', messages: [{ from: 'customer', text: CUSTOMER_TEXT }] });
    expect(m.asked[0]?.maxChars).toBeLessThanOrEqual(CONVERSATION_PROVIDER_RULES.telegram?.replyMax as number);
    // The draft is tainted AI text, live for a person to read; the cost counted against the org's AI cost.
    expect((await detail(o, id)).draft).toMatchObject({ state: 'live', source: 'auto', body: DRAFT_TEXT, tainted: true });
    expect(Number((await rows<{ amount: string }>("SELECT sum(amount)::text AS amount FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'", [o.orgId]))[0]?.amount)).toBeCloseTo(1.6, 6);
    // No auto-send: no message out, no reply queued, however long the draft is live.
    expect(await outgoing(o)).toEqual([]);
    expect(await queuedReplies(o)).toHaveLength(0);
    // Nothing of the customer's words or the draft in an audit row or an event.
    const leaks = await rows<{ n: string }>(
      `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND (detail::text LIKE '%xyzzy%' OR detail::text LIKE '%Dạ áo%'))
            + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND (payload::text LIKE '%xyzzy%' OR payload::text LIKE '%Dạ áo%')) AS n`,
      [o.orgId],
    );
    expect(Number(leaks[0]?.n)).toBe(0);
  });

  it('does not draft by itself when the owner turns auto-draft off, and a person may still ask for one', async () => {
    const o = await org();
    await rt.execute('kernel.conversation.auto_draft_set', { autoDraft: false }, { actor: asUser(o.owner), orgId: o.orgId });
    await ingest(o, [event('502')]);
    const id = await threadOf(o, '502');
    await requestDueConversationDrafts({ runtime: worker, workerDb, force: true });
    expect(await drafts(o)).toEqual([]);
    const asked = await rt.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId: id }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(asked.queued).toBe(true);
    expect((await drafts(o))[0]).toMatchObject({ state: 'requested', source: 'asked' });
  });

  it('offers the saved replies that answer the customer, refuses a reply that still holds {tên}, and queues only the reply a person sends', async () => {
    const o = await org();
    const saved = await rt.execute<{ id: string }>('kernel.conversation.saved_reply_create', { title: 'Giá áo thun', body: 'Chào {tên}, áo thun cotton giá 150.000đ ạ', keywords: ['giá'] }, { actor: asUser(o.owner), orgId: o.orgId });
    await ingest(o, [event('503')]);
    const id = await threadOf(o, '503');
    const shown = await detail(o, id);
    // Matched with no model; the thread's customer name is what the box fills {tên} with.
    expect(shown.suggestions.map((s) => s.title)).toEqual(['Giá áo thun']);
    expect(shown.conversation.contact).toMatchObject({ displayName: 'An Nguyễn', idTail: '503' });
    for (const body of ['Chào {tên}, áo thun cotton giá 150.000đ ạ', 'Chào {Tên} ạ']) {
      await expect(rt.execute('kernel.conversation.reply', { conversationId: id, body, lastSeenSeq: 1, savedReplyId: saved.id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'REPLY_PLACEHOLDER' });
    }
    expect(await outgoing(o)).toEqual([]);
    // The person fills the name and presses Send: now, and only now, a reply is queued for the job that sends it.
    await rt.execute('kernel.conversation.reply', { conversationId: id, body: 'Chào An Nguyễn, áo thun cotton giá 150.000đ ạ', lastSeenSeq: 1, savedReplyId: saved.id }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await outgoing(o)).toEqual([{ send_state: 'queued', body: 'Chào An Nguyễn, áo thun cotton giá 150.000đ ạ' }]);
    expect(await queuedReplies(o)).toHaveLength(1);
    // The reply may be as long as Telegram takes (4096), and no longer.
    await ingest(o, [event('503', 'Còn size M không ạ?')]);
    const seq = (await rows<{ last_seq: number }>('SELECT last_seq FROM crove_kernel.conversation WHERE id = $1', [id]))[0]?.last_seq as number;
    await expect(rt.execute('kernel.conversation.reply', { conversationId: id, body: 'a'.repeat(4097), lastSeenSeq: seq }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'REPLY_TOO_LONG' });
    await rt.execute('kernel.conversation.reply', { conversationId: id, body: 'a'.repeat(4096), lastSeenSeq: seq }, { actor: asUser(o.owner), orgId: o.orgId });
  });

  it('reads the thread for the intent suggestion, and the label is a person\'s decision', async () => {
    const o = await org();
    await ingest(o, [event('504', 'Cho mình đặt 3 cái áo, ship về Đà Nẵng nhé')]);
    const id = await threadOf(o, '504');
    const source = await rt.query<Array<{ id: string; texts: string[] }>>('kernel.conversation.intent_source', { conversationIds: [id] }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(source).toEqual([{ id, lastSeq: 1, texts: ['Cho mình đặt 3 cái áo, ship về Đà Nẵng nhé'] }]);
    // The model never stores a label: only a person's choice is kept, with who set it.
    await rt.execute('kernel.conversation.set_intent', { conversationId: id, intent: 'order_or_price' }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await rows('SELECT intent, intent_set_by FROM crove_kernel.conversation WHERE id = $1', [id])).toEqual([{ intent: 'order_or_price', intent_set_by: o.owner }]);
  });

  it('works with AI off: with no model a requested draft is settled as none, the message is in the inbox, and a person can still answer it', async () => {
    const o = await org();
    await ingest(o, [event('505')]);
    const id = await threadOf(o, '505');
    const asked = await rt.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId: id }, { actor: asUser(o.owner), orgId: o.orgId });
    await failUndraftable(worker, { orgId: o.orgId, draftId: asked.draftId, conversationId: id });
    expect((await drafts(o)).map((d) => d.state)).toEqual(['discarded']);
    expect((await detail(o, id)).draft).toBeNull();
    const list = await rt.query<{ conversations: Array<{ id: string; channel: { provider: string } }> }>('kernel.conversation.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(list.conversations.find((c) => c.id === id)?.channel.provider).toBe('telegram');
    await rt.execute('kernel.conversation.reply', { conversationId: id, body: 'Dạ shop còn hàng ạ', lastSeenSeq: 1 }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await outgoing(o)).toEqual([{ send_state: 'queued', body: 'Dạ shop còn hàng ạ' }]);
  });
});
