// SPDX-License-Identifier: AGPL-3.0-only
// YouTube comments end-to-end on PostgreSQL 17 (issue #3134, plan docs/plan/conversations-channels.md section 4.5): the opt-in, the poll that stores
// comment threads under the video (so Social's post tab lists them), Dy's draft, a reply sent exactly once through YouTubePublisher and counted in
// units, the daily polling budget with a fake clock, a spent project quota that holds polling and sending until the reset, the adaptive interval the
// relay's due list follows, erasure, and no customer text in audit or outbox rows.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { YouTubePublisher, type ConversationAdapter, type Fetch } from '@crove/channel';
import { metered, type AiUsage, type ReplyDraftRequest, type ReplyDraftResult } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { YOUTUBE_COMMENT_SCOPE, YOUTUBE_POLL_BUDGET_UNITS, YOUTUBE_POLL_MAX_UNITS, type ConversationDetail, type ConversationListed, type YoutubeCommentsStatus } from '@crove/kernel-contract';
import { CredentialVault, Runtime } from '@crove/kernel-runtime';
import { dueConversationSync, runConversationDraft, runConversationJob, runConversationSync } from '../src/conversations-worker.ts';
import { systemMeter } from '../src/ai-meter.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const APP = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const OTHER_CHANNEL = 'UCzyxwvutsrqponmlkjihgfe';
const CUSTOMER = 'UCcustomercustomercustom';
const VIDEO = 'dQw4w9WgXcQ';
const SECRET_TEXT = 'Số điện thoại 0909123456 của khách Lê Thị Hoa';
const THREAD = 'UgxAAAAAAAAAAAAAAAAAAAAAAAAB';
const SECOND = 'UgxBBBBBBBBBBBBBBBBBBBBBBBBC';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_COMMENT_SCOPE];
const SYSTEM = { type: 'system' as const, component: 'conversations' };

suite('YouTube comments on PostgreSQL (#3134)', () => {
  const dbName = `crove_test_youtube_conv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  const broker = new CredentialVault([{ id: 'k1', key: randomBytes(32) }]);
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
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

  afterEach(() => {
    vi.useRealTimers();
  });

  const comment = (id: string, text: string, at: string, over: { author?: string; name?: string; parentId?: string } = {}) => ({
    id,
    snippet: { authorDisplayName: over.name ?? '@le.thi.hoa', authorChannelId: { value: over.author ?? CUSTOMER }, textDisplay: text, publishedAt: at, ...(over.parentId ? { parentId: over.parentId } : {}) },
  });

  it('opt-in, poll, draft, send once, count units, budget, quota hold, interval, erase', async () => {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@yt-conv.test`, name: null });
    const member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `member-${randomUUID().slice(0, 8)}@yt-conv.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `YouTube ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const asOwner = { actor: asUser(owner), orgId };
    const asMember = { actor: asUser(member), orgId };
    const connect = (accountId: string, scopes: string[]) => {
      const sealed = broker.seal(JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' }), { orgId, provider: 'youtube', externalAccountId: accountId });
      return rt.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'youtube', externalAccountId: accountId, displayName: 'Tiệm Bánh B', scopes, expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        asOwner,
      );
    };
    const { connectionId } = await connect(CHANNEL, SCOPES);
    const narrow = await connect(OTHER_CHANNEL, SCOPES.slice(0, 2));

    const platform: { method: string; path: string; body: unknown }[] = [];
    const replyId = `${THREAD}.9aBcDeFgHiJ`;
    const nowIso = () => new Date().toISOString();
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      platform.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (method === 'GET' && url.pathname === '/youtube/v3/commentThreads') {
        return json({
          items: [
            { id: THREAD, snippet: { videoId: VIDEO, channelId: CHANNEL, totalReplyCount: 0, topLevelComment: comment(THREAD, SECRET_TEXT, nowIso()) } },
            { id: SECOND, snippet: { videoId: VIDEO, channelId: CHANNEL, totalReplyCount: 0, topLevelComment: comment(SECOND, 'Mua ở đâu vậy shop?', nowIso(), { author: 'UCsecondcustomersecond12', name: '@nguoi.mua' }) } },
          ],
        });
      }
      if (method === 'POST' && url.pathname === '/youtube/v3/comments') return json({ id: replyId });
      return new Response('{}', { status: 404 });
    };
    const publisher = new YouTubePublisher(APP, fetchImpl);
    const sendDeps = { runtime: worker, broker, adapter: (p: string) => (p === 'youtube' ? publisher.conversations : undefined) };
    const status = async (user = asOwner) => (await rt.query<YoutubeCommentsStatus[]>('kernel.conversation.youtube_comments', {}, user)).find((s) => s.connectionId === connectionId) as YoutubeCommentsStatus;
    const listCalls = () => platform.filter((c) => c.path === '/youtube/v3/commentThreads').length;

    // Off by default: nothing is read, no platform call is made, and everyone sees the switch.
    expect(await status(asMember)).toMatchObject({ enabled: false, scopeGranted: true, pollUnitsUsed: 0, pollBudget: YOUTUBE_POLL_BUDGET_UNITS });
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('none');
    expect(platform).toEqual([]);
    // The switch is for owners and admins; a channel without the comment scope reconnects first.
    await expect(rt.execute('kernel.conversation.youtube_comments_set', { connectionId, enabled: true }, asMember)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.execute('kernel.conversation.youtube_comments_set', { connectionId: narrow.connectionId, enabled: true }, asOwner)).rejects.toMatchObject({ code: 'YOUTUBE_SCOPE_MISSING' });
    // Events pushed at an off channel are ignored, however they arrive.
    const early = await worker.execute<{ stored: number; ignored: number }>(
      'kernel.conversation.ingest',
      { connectionId, events: [{ kind: 'comment_thread', threadId: THREAD, postId: VIDEO, messageId: THREAD, direction: 'in', contact: { id: CUSTOMER }, text: 'x', at: nowIso() }] },
      { actor: SYSTEM, orgId },
    );
    expect(early).toMatchObject({ stored: 0, ignored: 1 });

    // The opt-in: due at once for the relay (the first read), then within the next minutes not due again.
    await rt.execute('kernel.conversation.youtube_comments_set', { connectionId, enabled: true }, asOwner);
    expect((await dueConversationSync(workerDb, { history: ['youtube'], profile: [] })).map((j) => j.connectionId)).toContain(connectionId);
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('complete');
    expect(listCalls()).toBe(1);
    // One list request is one unit; the poll is counted and the next one is scheduled by the interval, so the relay does not ask again now.
    expect(await status()).toMatchObject({ enabled: true, pollUnitsUsed: 1, replyUnitsUsed: 0, blockedUntil: null });
    expect((await dueConversationSync(workerDb, { history: ['youtube'], profile: [] })).map((j) => j.connectionId)).not.toContain(connectionId);
    const nextAt = (await status()).nextPollAt as string;
    expect(Date.parse(nextAt)).toBeGreaterThan(Date.now() + 14 * 60_000);
    // When its time comes it is due again.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET history_next_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2", [orgId, connectionId]));
    expect((await dueConversationSync(workerDb, { history: ['youtube'], profile: [] })).map((j) => j.connectionId)).toContain(connectionId);

    // The threads are stored as comment threads under the video, so Social's post tab lists them.
    const listed = await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner);
    expect(listed.conversations).toHaveLength(2);
    expect(listed.conversations.find((c) => c.contact.displayName === '@le.thi.hoa')).toMatchObject({ kind: 'comment_thread', unread: true, channel: { provider: 'youtube' } });
    const underVideo = await rt.query<ConversationListed>('kernel.conversation.list', { posts: [{ connectionId, externalPostId: VIDEO }] }, asOwner);
    expect(underVideo.conversations).toHaveLength(2);
    // The same poll again changes nothing (the ingest is idempotent on the comment id): still two threads, one message each.
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('complete');
    expect((await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner)).conversations).toHaveLength(2);
    const convId = listed.conversations.find((c) => c.contact.displayName === '@le.thi.hoa')!.id;
    let detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ direction: 'in', body: SECRET_TEXT });

    // Dy's draft for the new comment thread: asked, written by the system job through the AI budget meter within the draft's own limit, tainted, and live for the
    // person to read; it sends nothing (the reply below is the person's own press of Send).
    const asked = await rt.execute<{ draftId: string; queued: boolean }>('kernel.conversation.draft_request', { conversationId: convId }, asOwner);
    expect(asked.queued).toBe(true);
    const seen: ReplyDraftRequest[] = [];
    const usage: AiUsage = { inputTokens: 1000, outputTokens: 200 };
    const writer = {
      draft: async (req: ReplyDraftRequest, onUsage?: (u: AiUsage) => void): Promise<ReplyDraftResult> => {
        await metered('conversation.draft', async () => {
          seen.push(req);
          return { usage };
        });
        onUsage?.(usage);
        return { kind: 'draft', body: 'Dạ bột mì số 11 ạ, bạn ghé tiệm nhé!' };
      },
    };
    expect(await runConversationDraft({ runtime: worker, writer, meter: systemMeter(worker, { price: { inputPerMTok: '1000', outputPerMTok: '3000' } }) }, { orgId, draftId: asked.draftId, conversationId: convId })).toBe('written');
    expect(seen[0]).toMatchObject({ maxChars: 2000, messages: [{ from: 'customer', text: SECRET_TEXT }] });
    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.draft).toMatchObject({ state: 'live', source: 'asked', tainted: true });
    expect(detail.messages).toHaveLength(1);
    expect(platform.filter((c) => c.method === 'POST')).toHaveLength(0);

    // A reply: over the rule is refused, hiding is not offered in v1, and the person's own Send goes out exactly once as comments.insert under the thread.
    // YouTube's rule is the core's own 8,000, which the input schema already enforces.
    await expect(rt.execute('kernel.conversation.reply', { conversationId: convId, body: 'x'.repeat(8001), lastSeenSeq: 1 }, asOwner)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(rt.execute('kernel.conversation.hide', { messageId: detail.messages[0]!.id, hidden: true }, asOwner)).rejects.toMatchObject({ code: 'HIDE_NOT_SUPPORTED' });
    const { messageId } = await rt.execute<{ messageId: string }>('kernel.conversation.reply', { conversationId: convId, body: 'Dạ bột mì số 11 ạ!', lastSeenSeq: 1 }, asOwner);
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId, action: 'reply' })).toBe('accepted');
    expect(await runConversationJob(sendDeps, { orgId, connectionId, messageId, action: 'reply' })).toBe('settled');
    const inserts = platform.filter((c) => c.method === 'POST' && c.path === '/youtube/v3/comments');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.body).toEqual({ snippet: { parentId: THREAD, textOriginal: 'Dạ bột mì số 11 ạ!' } });
    detail = await rt.query<ConversationDetail>('kernel.conversation.get', { conversationId: convId }, asOwner);
    expect(detail.messages.at(-1)).toMatchObject({ direction: 'out', sendState: 'sent' });
    const stored = await admin(async (c) => (await c.query<{ external_message_id: string | null }>('SELECT external_message_id FROM crove_kernel.conversation_message WHERE id = $1', [messageId])).rows[0]?.external_message_id);
    expect(stored).toBe(replyId);
    // The reply cost 50 units of the project's day, counted beside the polling and never against its budget.
    expect(await status()).toMatchObject({ pollUnitsUsed: 2, replyUnitsUsed: 50 });

    // The daily budget with a fake clock: a poll that might not fit the rest of the day does not start (no platform call), the held connection waits for
    // the reset, and after it the counters start again. Never more than the budget is spent.
    // The clock starts 20 hours before the day's reset, so the polls below all fall inside one quota day whatever the hour the test runs at.
    let resetAt = (await status()).resetAt;
    const start = Date.parse(resetAt) - 20 * 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    let polls = 0;
    const before = listCalls();
    const counting: ConversationAdapter = {
      provider: 'youtube',
      reply: publisher.conversations.reply.bind(publisher.conversations),
      history: async () => {
        polls++;
        return { kind: 'ok', events: [], complete: true, oldest: null, units: YOUTUBE_POLL_MAX_UNITS };
      },
    };
    const budgetDeps = { runtime: worker, broker, adapter: (p: string) => (p === 'youtube' ? counting : undefined) };
    let held = 0;
    for (let i = 0; i < 79; i++) {
      vi.setSystemTime(new Date(start + (i + 1) * 15 * 60_000));
      const out = await runConversationSync(budgetDeps, { action: 'history', orgId, connectionId });
      if (out === 'none') held++;
      expect((await status()).pollUnitsUsed).toBeLessThanOrEqual(YOUTUBE_POLL_BUDGET_UNITS);
    }
    // 2 units already used; each poll that starts costs up to 8, so the budget stops the polls at the last one that fits.
    expect(polls).toBe(Math.floor((YOUTUBE_POLL_BUDGET_UNITS - 2) / YOUTUBE_POLL_MAX_UNITS));
    expect(held).toBeGreaterThan(0);
    expect(listCalls()).toBe(before);
    const heldStatus = await status();
    expect(heldStatus.pollUnitsUsed).toBeLessThanOrEqual(YOUTUBE_POLL_BUDGET_UNITS);
    expect(Date.parse(heldStatus.nextPollAt as string)).toBeGreaterThanOrEqual(Date.parse(heldStatus.resetAt) - 1);
    // After the reset, polling resumes with fresh counters.
    vi.setSystemTime(new Date(Date.parse(resetAt) + 1000));
    expect(await runConversationSync(budgetDeps, { action: 'history', orgId, connectionId })).toBe('complete');
    expect(await status()).toMatchObject({ pollUnitsUsed: YOUTUBE_POLL_MAX_UNITS, replyUnitsUsed: 0 });
    resetAt = (await status()).resetAt;

    // The platform's own quota spent: the poll's failure is recorded with its unit, holds polling to the reset, and a person's Send is refused up front
    // with the reason (no call is made); after the reset sending is allowed again.
    const spent: ConversationAdapter = {
      provider: 'youtube',
      reply: counting.reply.bind(counting),
      history: async () => ({ kind: 'failed', retry: false, code: 'YOUTUBE_QUOTA', units: 1, quotaUntil: new Date(resetAt) }),
    };
    vi.setSystemTime(new Date(Date.parse(resetAt) + 60_000));
    resetAt = (await status()).resetAt;
    expect(await runConversationSync({ ...budgetDeps, adapter: () => spent }, { action: 'history', orgId, connectionId })).toBe('failed');
    const blocked = await status();
    expect(blocked.blockedUntil).not.toBeNull();
    expect(Date.parse(blocked.nextPollAt as string)).toBeGreaterThanOrEqual(Date.parse(blocked.blockedUntil as string) - 1);
    const callsBefore = platform.length;
    // The thread holds the customer's comment and the one answer: the next Send is the third message.
    await expect(rt.execute('kernel.conversation.reply', { conversationId: convId, body: 'Thêm một câu nữa', lastSeenSeq: 2 }, asOwner)).rejects.toMatchObject({ code: 'YOUTUBE_QUOTA_SPENT' });
    expect(platform.length).toBe(callsBefore);
    vi.setSystemTime(new Date(Date.parse(blocked.blockedUntil as string) + 1000));
    expect((await status()).blockedUntil).toBeNull();
    await rt.execute('kernel.conversation.reply', { conversationId: convId, body: 'Thêm một câu nữa', lastSeenSeq: 2 }, asOwner);
    vi.useRealTimers();

    // Turning it off stops the polling (no call) and keeps what was stored.
    await rt.execute('kernel.conversation.youtube_comments_set', { connectionId, enabled: false }, asOwner);
    const offCalls = platform.length;
    expect(await runConversationSync(sendDeps, { action: 'history', orgId, connectionId })).toBe('none');
    expect(platform.length).toBe(offCalls);
    expect((await rt.query<ConversationListed>('kernel.conversation.list', {}, asOwner)).conversations).toHaveLength(2);

    // Erasing the customer works on YouTube rows as on any channel's: the thread, its messages and the channel id (kept only as a tombstone) go.
    const mfa = { type: 'user' as const, userId: owner, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const erased = await rt.execute<{ threads: number; messages: number }>('kernel.conversation.erase_contact', { conversationId: convId, confirm: true }, { actor: mfa, orgId, idempotencyKey: randomUUID() });
    expect(erased.threads).toBe(1);
    const left = await admin((c) => c.query('SELECT 1 FROM crove_kernel.conversation_message WHERE org_id = $1 AND body ILIKE $2', [orgId, '%0909123456%']));
    expect(left.rows).toHaveLength(0);
    const names = await admin((c) => c.query<{ external_user_id: string }>('SELECT external_user_id FROM crove_kernel.conversation_identity WHERE org_id = $1 AND provider = $2', [orgId, 'youtube']));
    expect(names.rows.map((r) => r.external_user_id)).not.toContain(CUSTOMER);

    // No customer text, name or channel id reaches audit_event or outbox_event.
    for (const table of ['audit_event', 'outbox_event']) {
      const leaked = await admin((c) => c.query(`SELECT 1 FROM crove_kernel.${table} t WHERE org_id = $1 AND (row_to_json(t)::text ILIKE $2 OR row_to_json(t)::text ILIKE $3 OR row_to_json(t)::text ILIKE $4 OR row_to_json(t)::text ILIKE $5)`, [orgId, '%0909123456%', '%le.thi.hoa%', `%${CUSTOMER}%`, '%Mua ở đâu%']));
      expect(leaked.rows).toHaveLength(0);
    }
  });
});
