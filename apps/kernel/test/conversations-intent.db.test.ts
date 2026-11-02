// SPDX-License-Identifier: AGPL-3.0-only
// The intent of a conversation and the likely contacts of a customer (CV3, #2306, the last part) on PostgreSQL 17, through the API: a person applies,
// changes and clears the label (the only thing stored) and the list filters by it; the database refuses every writer of it but the person it names;
// the suggestion is read apart from the thread by a recorded model, never stored, for the threads the member may read only, with the model off, failing,
// spent or answering nonsense leaving no suggestion and no error; the contact match is the phone the customer wrote first, then the names, ranked by the
// model, and links nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import {
  CONVERSATION_INTENTS,
  type ConversationContactMatched,
  type ConversationEvent,
  type ConversationIntent,
  type ConversationIntentSuggested,
  type ConversationListed,
} from '@crove/kernel-contract';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { InboxReader, type IntentGenerator, type RankGenerator } from '@crove/agent';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-conversation-intent-0123';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'conversations' };

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@intent.test`, session: randomUUID(), userId: '' });

suite('the intent of a conversation and the likely contacts of a customer (CV3, #2306)', () => {
  const dbName = `crove_test_conversations_intent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let apps: Record<'on' | 'noAi', ReturnType<typeof createHttpApp>>;
  // The recorded model: what it was asked, and the answers the tests queue (an Error: it fails).
  const askedIntents: Parameters<IntentGenerator>[0][] = [];
  const askedRanks: Parameters<RankGenerator>[0][] = [];
  const intentAnswers: Array<Awaited<ReturnType<IntentGenerator>> | Error> = [];
  const rankAnswers: Array<Awaited<ReturnType<RankGenerator>> | Error> = [];
  const intents: IntentGenerator = async (args) => {
    askedIntents.push(args);
    const next = intentAnswers.shift() ?? { output: null };
    if (next instanceof Error) throw next;
    return next;
  };
  const ranks: RankGenerator = async (args) => {
    askedRanks.push(args);
    const next = rankAnswers.shift() ?? { output: null };
    if (next instanceof Error) throw next;
    return next;
  };
  const owner = account('owner');
  const desk = account('desk');
  const lan = account('lan');
  const viewer = account('viewer');
  let org = { slug: '', orgId: '', connectionId: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => withClient(adminUrl, async (c) => (await c.query<T>(text, params)).rows);
  async function asMember<T>(user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    return withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(user, org.orgId)]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });
  }
  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  let tick = 0;
  const event = (kind: ConversationEvent['kind'], threadId: string, text: string, name = `Khách ${threadId}`, contactId = `u-${threadId}`): ConversationEvent => ({
    kind,
    threadId,
    ...(kind === 'comment_thread' ? { postId: 'post-1' } : {}),
    messageId: `m-${threadId}-${tick++}`,
    direction: 'in',
    contact: { id: contactId, name },
    text,
    at: new Date(Date.now() - 600_000 + tick * 1000).toISOString(),
  });
  const ingest = (events: ConversationEvent[]) => worker.execute('kernel.conversation.ingest', { connectionId: org.connectionId, events }, { actor: SYSTEM, orgId: org.orgId });
  const threadOf = async (external: string) => ((await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [org.orgId, external]))[0] as { id: string }).id;
  const intentOf = async (id: string) => (await rows<{ intent: string | null; intent_set_by: string | null; intent_set_at: Date | null }>('SELECT intent, intent_set_by, intent_set_at FROM crove_kernel.conversation WHERE org_id = $1 AND id = $2', [org.orgId, id]))[0];
  const list = async (who: Account, input: Record<string, unknown> = {}) => (await rpc('conversations/list', who, input)).body as ConversationListed;
  const setIntent = (who: Account, id: string, intent: ConversationIntent | null) => rpc('conversations/setIntent', who, { conversationId: id, intent });
  const suggest = (who: Account, ids: string[], app: keyof typeof apps = 'on') => rpc('conversations/suggestIntents', who, { conversationIds: ids }, { app });
  const matches = (who: Account, id: string, app: keyof typeof apps = 'on') => rpc('conversations/contactMatches', who, { conversationId: id }, { app });
  const answerIntents = (...items: Array<{ n: number; intent: string }>) => intentAnswers.push({ output: { items: items as never }, usage: { inputTokens: 10, outputTokens: 5 } });

  beforeAll(async () => {
    await withClient(ADMIN as string, async (c) => void (await c.query(`CREATE DATABASE ${dbName}`)));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    appUrl = urlFor('crove_app', 'test-app-pw');
    workerUrl = urlFor('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    // The reader as the kernel wires it, with the recorded model in place of the endpoint.
    const reader = new InboxReader({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, { intents, rank: ranks });
    const make = (conversationReader?: InboxReader) =>
      createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: true, ...(conversationReader ? { conversationReader } : {}) });
    apps = { on: make(reader), noAi: make() };

    for (const who of [owner, desk, lan, viewer]) {
      const me = await rpc('me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Cửa hàng Hoa Nắng', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId), connectionId: randomUUID() };
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [org.orgId, desk.userId, lan.userId, viewer.userId]);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [org.orgId, desk.userId, owner.userId]);
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [org.orgId, org.connectionId, `acct-${randomUUID().slice(0, 8)}`, owner.userId]);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    await withClient(ADMIN, async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)));
  });

  describe('the label a person applies', () => {
    it('is applied, changed and cleared by a person, filters the list, names them, and stays when the customer writes again', async () => {
      await ingest([event('direct', 'a1', 'Hàng giao chậm quá'), event('direct', 'a2', 'Cho mình hỏi giá'), event('comment_thread', 'a3', 'Đẹp quá')]);
      const a1 = await threadOf('a1');
      expect((await setIntent(desk, a1, 'complaint')).body).toEqual({ conversationId: a1, intent: 'complaint' });
      expect(await intentOf(a1)).toMatchObject({ intent: 'complaint', intent_set_by: desk.userId });
      expect((await intentOf(a1))?.intent_set_at).toBeInstanceOf(Date);
      // The list shows it, and filters by it or by none.
      const ofIntent = async (intent: string) => (await list(owner, { intent })).conversations.map((c) => c.contact.displayName);
      expect(await ofIntent('complaint')).toEqual(['Khách a1']);
      expect(await ofIntent('spam')).toEqual([]);
      expect((await ofIntent('none')).sort()).toEqual(['Khách a2', 'Khách a3']);
      expect((await list(owner, { intent: 'complaint' })).conversations[0]?.intent).toBe('complaint');
      // Changed, then cleared: the label, who and when go together.
      await setIntent(owner, a1, 'spam');
      expect(await intentOf(a1)).toMatchObject({ intent: 'spam', intent_set_by: owner.userId });
      expect((await setIntent(owner, a1, null)).body).toEqual({ conversationId: a1, intent: null });
      expect(await intentOf(a1)).toEqual({ intent: null, intent_set_by: null, intent_set_at: null });
      // The audit rows hold the label, never the customer's words or name.
      const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.set_intent'", [org.orgId]));
      expect(audit).toContain('complaint');
      for (const typed of ['chậm quá', 'Khách a1']) expect(audit).not.toContain(typed);
      // A label survives the customer writing again (a thread resolved and reopened keeps what the person decided).
      await setIntent(desk, a1, 'complaint');
      await rt.execute('kernel.conversation.resolve', { conversationId: a1 }, { actor: asUser(desk.userId), orgId: org.orgId });
      await ingest([{ ...event('direct', 'a1', 'Vẫn chưa nhận được'), at: new Date(Date.now() + 60_000).toISOString() }]);
      expect(await intentOf(a1)).toMatchObject({ intent: 'complaint', intent_set_by: desk.userId });
      expect((await list(owner, { status: 'new', intent: 'complaint' })).conversations).toHaveLength(1);
    });

    it('is a decision of a member who may write the thread: a viewer, a member who cannot read it and another org find the way closed', async () => {
      await ingest([event('direct', 'b1', 'Nhắn riêng'), event('comment_thread', 'b2', 'Bình luận')]);
      const [b1, b2] = [await threadOf('b1'), await threadOf('b2')];
      expect((await setIntent(viewer, b2, 'question')).status).toBe(403);
      // A member with no desk role reads no private message: the thread is not found; the comment thread is theirs to label.
      expect((await setIntent(lan, b1, 'question')).status).toBe(404);
      expect((await setIntent(lan, b2, 'question')).status).toBe(200);
      expect((await setIntent(desk, b1, 'question')).status).toBe(200);
      expect((await rpc('conversations/setIntent', owner, { conversationId: b1, intent: 'bogus' })).status).toBe(400);
      expect(await intentOf(b1)).toMatchObject({ intent: 'question' });
      // Another org's thread is not found either.
      const other = await rpc('org/create', desk, { name: 'Tiệm khác', idempotencyKey: randomUUID() }, { slug: null });
      expect((await rpc('conversations/setIntent', desk, { conversationId: b2, intent: 'spam' }, { slug: String(other.body?.slug) })).status).toBe(404);
      expect(await intentOf(b2)).toMatchObject({ intent: 'question' });
    });

    it('is written in the database only by the person it names: not another name, not the system, not a thread born with one, not a half label', async () => {
      await ingest([event('comment_thread', 'g1', 'Thử khóa')]);
      const g1 = await threadOf('g1');
      // A member names themselves, with the time: allowed. Naming another member, or nobody, or leaving the time out: refused.
      await asMember(lan.userId, async (c) => {
        await c.query("UPDATE crove_kernel.conversation SET intent = 'question', intent_set_by = $1, intent_set_at = now() WHERE id = $2", [lan.userId, g1]);
        await expect(c.query("UPDATE crove_kernel.conversation SET intent = 'spam', intent_set_by = $1, intent_set_at = now() WHERE id = $2", [desk.userId, g1])).rejects.toThrow(/INTENT_FORBIDDEN/);
      });
      await asMember(lan.userId, async (c) => {
        await expect(c.query("UPDATE crove_kernel.conversation SET intent = 'spam', intent_set_by = NULL, intent_set_at = now() WHERE id = $1", [g1])).rejects.toThrow(/INTENT_FORBIDDEN/);
      });
      await asMember(lan.userId, async (c) => {
        await expect(c.query("UPDATE crove_kernel.conversation SET intent = 'spam', intent_set_by = $1 WHERE id = $2", [lan.userId, g1])).rejects.toMatchObject({ code: '23514' });
      });
      // A cleared label names nobody.
      await rows("UPDATE crove_kernel.conversation SET intent = 'question', intent_set_by = $1, intent_set_at = now() WHERE id = $2", [lan.userId, g1]);
      await asMember(lan.userId, async (c) => {
        await expect(c.query('UPDATE crove_kernel.conversation SET intent = NULL, intent_set_at = NULL WHERE id = $1', [g1])).rejects.toThrow(/INTENT_FORBIDDEN/);
      });
      // The system, in the org's own context, labels nothing.
      await withClient(workerUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
          await expect(c.query("UPDATE crove_kernel.conversation SET intent = 'spam', intent_set_by = NULL, intent_set_at = now() WHERE id = $1", [g1])).rejects.toThrow(/INTENT_FORBIDDEN/);
          // ... though it writes the rest of the thread as ever.
          await c.query('ROLLBACK');
          await c.query('BEGIN');
          await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
          expect((await c.query("UPDATE crove_kernel.conversation SET updated_at = now() WHERE id = $1", [g1])).rowCount).toBe(1);
        } finally {
          await c.query('ROLLBACK').catch(() => {});
        }
      });
      // A thread is born with no label, whoever inserts it.
      await asMember(lan.userId, async (c) => {
        await expect(
          c.query(
            "INSERT INTO crove_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, intent, intent_set_by, intent_set_at) VALUES ($1, $2, 'comment_thread', 'born-labelled', 'spam', $3, now())",
            [org.orgId, org.connectionId, lan.userId],
          ),
        ).rejects.toThrow(/INTENT_FORBIDDEN/);
      });
      // The label is one of the five, in the database as in the contract.
      await expect(rows("UPDATE crove_kernel.conversation SET intent = 'greeting', intent_set_at = now() WHERE id = $1", [g1])).rejects.toMatchObject({ code: '23514' });
      expect([...CONVERSATION_INTENTS]).toEqual(['question', 'order_or_price', 'complaint', 'invoice_request', 'spam']);
    });
  });

  describe('the suggestion', () => {
    it('is read from what the member may read, never stored, and not read twice for the same message', async () => {
      await ingest([event('direct', 's1', 'Hàng giao chậm quá, shop xử lý giúp'), event('comment_thread', 's2', 'Giá áo này bao nhiêu vậy'), event('direct', 's3', 'Xuất hóa đơn công ty giúp mình')]);
      const [s1, s2, s3] = [await threadOf('s1'), await threadOf('s2'), await threadOf('s3')];
      const before = await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1', [org.orgId]);
      const asked = askedIntents.length;
      // The model answers for the conversations in the order they were listed to it (the member's own order).
      answerIntents({ n: 1, intent: 'complaint' }, { n: 2, intent: 'question' }, { n: 3, intent: 'invoice_request' });
      const first = await suggest(desk, [s1, s2, s3]);
      expect(first.status).toBe(200);
      expect(first.body as ConversationIntentSuggested).toEqual({
        ai: 'used',
        suggestions: [
          { conversationId: s1, intent: 'complaint' },
          { conversationId: s2, intent: 'question' },
          { conversationId: s3, intent: 'invoice_request' },
        ],
      });
      // What the model was shown: the customers' words, fenced as data, with the rules that say so; no name, no channel, no id.
      const call = askedIntents.at(-1);
      expect(askedIntents.length).toBe(asked + 1);
      expect(call?.prompt).toContain('Hàng giao chậm quá, shop xử lý giúp');
      expect(call?.prompt).toContain('<<<');
      expect(call?.system).toContain('untrusted data');
      for (const hidden of ['Khách s1', s1, 'Kênh thử', org.slug]) expect(call?.prompt).not.toContain(hidden);
      // Nothing was stored: no label, and no audit row for the read.
      for (const id of [s1, s2, s3]) expect((await intentOf(id))?.intent).toBeNull();
      expect(await rows('SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1', [org.orgId])).toEqual(before);
      // The same messages again: answered from what the model said a moment ago, with no new call.
      const second = await suggest(desk, [s3, s1]);
      expect(second.body).toEqual({ ai: 'used', suggestions: [{ conversationId: s3, intent: 'invoice_request' }, { conversationId: s1, intent: 'complaint' }] });
      expect(askedIntents.length).toBe(asked + 1);
      // A newer message is read again.
      await ingest([event('direct', 's1', 'Huỷ đơn giúp mình')]);
      answerIntents({ n: 1, intent: 'order_or_price' });
      expect((await suggest(desk, [s1])).body).toEqual({ ai: 'used', suggestions: [{ conversationId: s1, intent: 'order_or_price' }] });
      expect(askedIntents.length).toBe(asked + 2);
      expect(askedIntents.at(-1)?.prompt).toContain('Huỷ đơn giúp mình');
    });

    it('reads only the threads the member may read, and a viewer gets none', async () => {
      await ingest([event('direct', 'p1', 'Nhắn riêng của khách'), event('comment_thread', 'p2', 'Bình luận của khách')]);
      const [p1, p2] = [await threadOf('p1'), await threadOf('p2')];
      const asked = askedIntents.length;
      // A member with no desk role is not shown the private message, and the model is not shown it either.
      answerIntents({ n: 1, intent: 'question' });
      const lanAnswer = await suggest(lan, [p1, p2]);
      expect(lanAnswer.body).toEqual({ ai: 'used', suggestions: [{ conversationId: p2, intent: 'question' }] });
      expect(askedIntents.at(-1)?.prompt).not.toContain('Nhắn riêng của khách');
      expect(askedIntents.length).toBe(asked + 1);
      // A viewer is refused before the model is asked.
      expect((await suggest(viewer, [p2])).status).toBe(403);
      expect(askedIntents.length).toBe(asked + 1);
      // More than ten at a time is refused by the shape of the request.
      expect((await suggest(owner, Array.from({ length: 11 }, () => randomUUID()))).status).toBe(400);
      // Another thread's id that is not in this org is simply not there.
      expect((await suggest(owner, [randomUUID()])).body).toEqual({ ai: 'used', suggestions: [] });
    });

    it('leaves no suggestion and no error when the model is off, fails, answers nonsense or has nothing to read', async () => {
      await ingest([event('direct', 'f1', 'Tư vấn giúp mình với'), event('direct', 'f2', 'Ib mình nhé')]);
      const [f1, f2] = [await threadOf('f1'), await threadOf('f2')];
      const none = (...ids: string[]) => ids.map((conversationId) => ({ conversationId, intent: null }));
      // The deployment has no model.
      expect((await suggest(owner, [f1], 'noAi')).body).toEqual({ ai: 'off', suggestions: none(f1) });
      // The model fails: the call is not cached, and says so.
      intentAnswers.push(new Error('endpoint down'));
      expect((await suggest(owner, [f1, f2])).body).toEqual({ ai: 'failed', suggestions: none(f1, f2) });
      // The model answers nothing, an unknown label, a number that was not asked, a conversation twice: only the valid first answer counts.
      answerIntents({ n: 1, intent: 'other' }, { n: 2, intent: 'greeting' }, { n: 7, intent: 'spam' });
      expect((await suggest(owner, [f1, f2])).body).toEqual({ ai: 'used', suggestions: none(f1, f2) });
      intentAnswers.push({ output: null });
      await ingest([event('direct', 'f1', 'Cảm ơn shop')]);
      expect((await suggest(owner, [f1])).body).toEqual({ ai: 'used', suggestions: none(f1) });
      answerIntents({ n: 1, intent: 'spam' }, { n: 1, intent: 'complaint' });
      await ingest([event('direct', 'f2', 'Đặt hàng đây')]);
      expect((await suggest(owner, [f2])).body).toEqual({ ai: 'used', suggestions: [{ conversationId: f2, intent: 'spam' }] });
      // The thread itself is untouched by all of it.
      for (const id of [f1, f2]) expect((await intentOf(id))?.intent).toBeNull();
    });
  });

  describe('the org’s switch for AI on its customers’ conversations', () => {
    it('keeps every word of a customer and every name of a contact from the model while it is off, answers off, and still lists the contacts by phone', async () => {
      await rows("INSERT INTO crove_kernel.party (org_id, kind, name, phone) VALUES ($1, 'person', 'Đặng Thu Hà', '0933 222 111'), ($1, 'person', 'Đặng Thị Hà', NULL), ($1, 'person', 'Hà Đặng Văn', NULL)", [org.orgId]);
      await ingest([event('direct', 'sw1', 'Cho mình hỏi giá, số mình 0933.222.111', 'Hà Đặng')]);
      const sw1 = await threadOf('sw1');
      const [intentCalls, rankCalls] = [askedIntents.length, askedRanks.length];
      expect((await rpc('conversations/setAutoDraft', viewer, { autoDraft: false })).status).toBe(403);
      expect((await rpc('conversations/setAutoDraft', owner, { autoDraft: false })).status).toBe(200);
      expect((await suggest(owner, [sw1])).body).toEqual({ ai: 'off', suggestions: [] });
      const off = (await matches(owner, sw1)).body as ConversationContactMatched;
      expect(off.ai).toBe('off');
      expect(off.candidates[0]).toMatchObject({ name: 'Đặng Thu Hà', reason: 'phone' });
      expect(off.candidates.length).toBeGreaterThan(1);
      // The model was asked nothing, and was shown nothing.
      expect([askedIntents.length, askedRanks.length]).toEqual([intentCalls, rankCalls]);
      // On again, it reads and ranks.
      expect((await rpc('conversations/setAutoDraft', owner, { autoDraft: true })).status).toBe(200);
      answerIntents({ n: 1, intent: 'order_or_price' });
      rankAnswers.push({ output: { order: [1] }, usage: { inputTokens: 5, outputTokens: 3 } });
      expect((await suggest(owner, [sw1])).body).toEqual({ ai: 'used', suggestions: [{ conversationId: sw1, intent: 'order_or_price' }] });
      expect(((await matches(owner, sw1)).body as ConversationContactMatched).ai).toBe('used');
      expect([askedIntents.length, askedRanks.length]).toEqual([intentCalls + 1, rankCalls + 1]);
    });
  });

  describe('the likely contacts of a customer', () => {
    it('puts the contact with the phone the customer wrote first, then the contacts with a similar name, ranked by the model, and links nothing', async () => {
      const party = (name: string, phone: string | null) =>
        rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, kind, name, phone) VALUES ($1, 'person', $2, $3) RETURNING id", [org.orgId, name, phone]).then((r) => (r[0] as { id: string }).id);
      const [thi, van, binh, mai] = [await party('Nguyễn Thị Hoa', '0912 345 678'), await party('Nguyễn Văn Hoa', null), await party('Trần Văn Bình', '+84 987 654 321'), await party('Lê Thị Mai', '0901 111 222')];
      // A contact merged into another is hidden by the contact list and the search, and is not offered here either, by phone or by name.
      await rows("INSERT INTO crove_kernel.party (org_id, kind, name, phone, duplicate_of) VALUES ($1, 'person', 'Trần Văn Bình (bản cũ)', '0987 654 321', $2), ($1, 'person', 'Hoa Nguyễn cũ', NULL, $3)", [org.orgId, binh, thi]);
      await ingest([event('direct', 'c1', 'Chào shop, mình là Hoa. Số mình 0987.654.321, STK 1234567890123 nhé', 'Hoa Nguyen')]);
      const c1 = await threadOf('c1');
      const asked = askedRanks.length;
      // The model puts the second name first.
      rankAnswers.push({ output: { order: [2, 1] }, usage: { inputTokens: 8, outputTokens: 4 } });
      const found = await matches(desk, c1);
      expect(found.status).toBe(200);
      const body = found.body as ConversationContactMatched;
      expect(body.ai).toBe('used');
      // The deterministic order of the two names is by name (Thị before Văn); the model's order puts Văn first.
      expect(body.candidates).toEqual([
        { partyId: binh, name: 'Trần Văn Bình', reason: 'phone' },
        { partyId: van, name: 'Nguyễn Văn Hoa', reason: 'name' },
        { partyId: thi, name: 'Nguyễn Thị Hoa', reason: 'name' },
      ]);
      expect(body.candidates.map((c) => c.partyId)).not.toContain(mai);
      // A merged contact is not offered: not the old copy of the phone's owner, not the old copy of a name.
      expect(JSON.stringify(body.candidates)).not.toContain('bản cũ');
      expect(JSON.stringify(body.candidates)).not.toContain('Hoa Nguyễn cũ');
      // The model saw the names only (the customer's and the candidates'), not the words of the thread nor the phone.
      expect(askedRanks.length).toBe(asked + 1);
      const prompt = askedRanks.at(-1)?.prompt ?? '';
      expect(prompt).toContain('Hoa Nguyen');
      expect(prompt).toContain('Nguyễn Thị Hoa');
      for (const hidden of ['0987', '1234567890123', 'Chào shop']) expect(prompt).not.toContain(hidden);
      // Nothing is linked: that is a person's click.
      expect((await rows<{ party_id: string | null }>('SELECT party_id FROM crove_kernel.conversation WHERE id = $1', [c1]))[0]?.party_id).toBeNull();
      // The model failing leaves the deterministic order, and says so.
      rankAnswers.push(new Error('endpoint down'));
      const failed = (await matches(owner, c1)).body as ConversationContactMatched;
      expect(failed.ai).toBe('failed');
      expect(failed.candidates.map((c) => c.partyId)).toEqual([binh, thi, van]);
      // With no model, the same.
      const off = (await matches(owner, c1, 'noAi')).body as ConversationContactMatched;
      expect(off.ai).toBe('off');
      expect(off.candidates.map((c) => c.partyId)).toEqual([binh, thi, van]);
      // Once a person links the thread there is nothing to suggest.
      await rt.execute('kernel.conversation.link_contact', { conversationId: c1, partyId: thi }, { actor: asUser(desk.userId), orgId: org.orgId });
      expect((await matches(owner, c1)).body).toEqual({ ai: 'used', candidates: [] });
    });

    it('asks the model nothing for one name or none, needs two shared words of a long name, and is closed to a viewer and to a thread the member cannot read', async () => {
      const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'person', $2) RETURNING id", [org.orgId, name]).then((r) => (r[0] as { id: string }).id);
      const [lanParty] = [await party('Phạm Quốc Khánh')];
      await party('Phạm Văn Long');
      await ingest([event('direct', 'n1', 'Hỏi giá', 'Phạm Quốc Khánh'), event('direct', 'n2', 'Hỏi giá', 'Phạm Gia Bảo'), event('comment_thread', 'n3', 'Hỏi giá', 'Khánh')]);
      const [n1, n2, n3] = [await threadOf('n1'), await threadOf('n2'), await threadOf('n3')];
      const asked = askedRanks.length;
      // One name resembles: no ranking call. "Phạm" alone does not make a match for a three-word name.
      expect(((await matches(owner, n1)).body as ConversationContactMatched).candidates).toEqual([{ partyId: lanParty, name: 'Phạm Quốc Khánh', reason: 'name' }]);
      expect(((await matches(owner, n2)).body as ConversationContactMatched).candidates).toEqual([]);
      // A one-word name needs that word only.
      expect(((await matches(lan, n3)).body as ConversationContactMatched).candidates.map((c) => c.partyId)).toEqual([lanParty]);
      expect(askedRanks.length).toBe(asked);
      expect((await matches(viewer, n3)).status).toBe(403);
      expect((await matches(lan, n1)).status).toBe(404);
    });
  });
});
