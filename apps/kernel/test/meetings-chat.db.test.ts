// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel by a worker job (Meetings B4, #3168, plan section 5.2) on a real database: an owner or admin saves a webhook address (sealed by the API,
// never opened by it), the recorder reads the exact message of a PUBLISHED result and QUEUES it with a click (the post row holds ids and hashes, the message sits in its own definer-only row), the sweep
// hands the post to the queue, the job opens the sealed address with the credential broker and posts once (here a fake fetch) and the message is deleted when the post settles. A repeat needs the
// recorder's tick, an answer that may have been delivered is never sent again, the facts the recorder read must still be the published ones, a channel whose saver left sends nothing, a changed text
// drops a queued post, and no row, audit entry or log line holds the address or the text.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CHAT_POSTS_PER_MEETING_PER_DAY, type ChatChannelList, type ChatPosted, type ChatPreview, type ChatStatus } from '@crove/kernel-contract';
import { CredentialVault, Runtime, defineCommand, parseVaultKey } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { resealCredentials } from '../src/credential-reseal.ts';
import { CHAT_RETRY_LIMIT, runMeetingChat, type ChatDeps, type ChatJob } from '../src/meeting-chat-job.ts';
import { runMeetingChatSweep } from '../src/meeting-chat-sweep.ts';
import { MinutesSaveBudget, minutesLink, postMinutesFromClick, saveMinutesChannel, type MinutesChatDeps } from '../src/meeting-chat.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Built from pieces so the repository holds no string shaped like a Slack webhook address (secret scanners flag one, real or not).
const SVC = ['services', 'T0000000A', 'B0000000B', 'abcdefghijklmnopqrstuvwx'].join('/');
const SLACK_URL = `https://hooks.slack.com/${SVC}`;
const TEAMS_URL = 'https://prod-12.southeastasia.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SECRETSIGNATURE';
const SECRET_BITS = ['abcdefghijklmnopqrstuvwx', 'SECRETSIGNATURE', 'T0000000A'];

interface Sent {
  url: string;
  body: string;
}

suite('minutes posted to Slack and Teams by a worker job (B4, #3168)', () => {
  const dbName = `crove_test_meeting_chat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown = {}) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  // What the fake service does with the next call: answer a status, or fail like the egress guard does.
  let next: { status: number; headers?: Record<string, string> } | { fail: string } = { status: 200 };
  let sent: Sent[] = [];
  const send = async (input: string, init?: RequestInit): Promise<Response> => {
    sent.push({ url: input, body: String(init?.body ?? '') });
    if ('fail' in next) throw Object.assign(new Error('guard'), { name: 'EgressError', code: next.fail });
    return new Response('ok', { status: next.status, headers: next.headers ?? {} });
  };
  const deps = (over: Partial<MinutesChatDeps> = {}): MinutesChatDeps => ({ runtime, broker: vault, publicUrl: 'https://app.test', saves: new MinutesSaveBudget(1000), ...over });
  const jobDeps = (over: Partial<ChatDeps> = {}): ChatDeps => ({ runtime: worker, broker: vault, send, ...over });
  // The job for one post: its result, or 'retry' when it threw so the queue would try again.
  const runJob = async (postId: string, retryCount = 0, over: Partial<ChatDeps> = {}): Promise<string> => {
    try {
      return await runMeetingChat(jobDeps(over), { orgId, id: postId }, { retryCount, retryLimit: CHAT_RETRY_LIMIT });
    } catch {
      return 'retry';
    }
  };
  // One pass of the sweep, then the job of each post it handed over: id -> result.
  async function work(over: Partial<ChatDeps> = {}): Promise<Record<string, string>> {
    const handed: ChatJob[] = [];
    await runMeetingChatSweep({ runtime: worker, workerDb, send: async (job) => void handed.push(job) });
    const out: Record<string, string> = {};
    for (const job of handed) out[job.id] = await runJob(job.id, 0, over);
    return out;
  }
  const scope = (who: string) => ({ orgId, orgSlug: 'cong-ty-chat', actor: asUser(who) });
  const saveChannel = (who: string, kind: 'slack' | 'teams', url: string, label = 'Kênh họp giao ban', id?: string) => saveMinutesChannel(deps(), scope(who), { kind, label, url, ...(id ? { id } : {}) });

  async function seedMeeting(published: boolean, summary = 'Chốt báo giá tuần này.'): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp giao ban tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 5, 'Người nói 1', 'BẢN GHI BÍ MẬT không được rời Ludy', 'draft')`, [orgId, randomUUID(), meetingId]);
    if (published) await publish(meetingId, summary);
    return meetingId;
  }
  async function publish(meetingId: string, summary: string): Promise<void> {
    await exec('recorder', 'meetings.summary.save', { meetingId, summary, decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Gửi báo giá cho khách', who: 'An', whoUserId: users.attendee, when: 'thứ sáu', whenDate: '2026-11-13', transcriptSeconds: 120 });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
  }
  const preview = (meetingId: string, who = 'recorder') => query<ChatPreview>(who, 'meetings.chat.preview', { meetingId });
  const post = async (meetingId: string, channelId: string, over: { confirmRepeat?: boolean; factsKey?: string } = {}): Promise<ChatPosted> => {
    const view = await preview(meetingId);
    return postMinutesFromClick(deps(), scope('recorder'), { meetingId, channelId, factsKey: over.factsKey ?? view.factsKey, confirmRepeat: over.confirmRepeat ?? false });
  };
  const posts = async (meetingId: string) => (await sqlAdmin<{ state: string; attempts: number; http_status: number | null; code: string | null; settled_at: Date | null }>('SELECT state, attempts, http_status, code, settled_at FROM crove_meetings.chat_post WHERE org_id = $1 AND meeting_id = $2 ORDER BY created_at, id', [orgId, meetingId])).rows;
  const bodies = async () => Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.chat_post_body WHERE org_id = $1', [orgId])).rows[0]?.n);
  const status = (meetingId: string, channelId: string) => query<ChatStatus>('recorder', 'meetings.chat.status', { meetingId, channelId });

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
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    workerDb = createDb(workerPool);
    // A command that only this test has: the recorder's own insert of a post row, with the columns the worker alone may set, to see the database refuse it (the policy of chat_post).
    const rawInsert = defineCommand({
      name: 'meetings.test.chat_post_insert',
      input: z.strictObject({ meetingId: z.string(), channelId: z.string(), sendingAt: z.boolean(), handedAt: z.boolean() }),
      risk: 'R1',
      sideEffect: 'none',
      access: ['owner', 'admin', 'member'],
      handler: async (ctx, input) => {
        const stamp = (on: boolean) => (on ? sql`pg_catalog.now()` : sql`NULL`);
        await sql`
          INSERT INTO crove_meetings.chat_post (org_id, meeting_id, channel_id, user_id, facts_key, text_hash, handed_at, sending_at)
          VALUES (${ctx.orgId}::uuid, ${input.meetingId}::uuid, ${input.channelId}::uuid, ${ctx.actor.type === 'user' ? ctx.actor.userId : null}::uuid, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${stamp(input.handedAt)}, ${stamp(input.sendingAt)})`.execute(ctx.trx);
        return { ok: true };
      },
    });
    const registry = { commands: [...kernelCommands, ...meetingsCommands, rawInsert], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'viewer', 'outsider']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'chat', subject: key, email: `${key}@chat.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Chat')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [orgId, users.admin, users.recorder, users.attendee, users.viewer]);
  }, 300_000);

  beforeEach(async () => {
    sent = [];
    next = { status: 200 };
    await sqlAdmin('DELETE FROM crove_meetings.chat_channel WHERE org_id = $1', [orgId]);
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.admin]);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });


  it('lets an owner or admin save a Slack or Teams address, sealed, shown as a host only; a member, a viewer and a bad address are refused', async () => {
    const a = await saveChannel('owner', 'slack', SLACK_URL, 'Kênh #hop-giao-ban');
    const b = await saveChannel('admin', 'teams', TEAMS_URL, 'Nhóm Kinh doanh');
    expect(a).toMatchObject({ kind: 'slack', host: 'hooks.slack.com', label: 'Kênh #hop-giao-ban' });
    expect(b).toMatchObject({ kind: 'teams', host: 'prod-12.southeastasia.logic.azure.com' });
    const list = await query<ChatChannelList>('recorder', 'meetings.chat.channels');
    expect(list.channels.map((c) => c.label)).toEqual(['Kênh #hop-giao-ban', 'Nhóm Kinh doanh']);
    expect(JSON.stringify(list)).not.toMatch(/services|workflows|abcdefgh|SECRETSIG/);
    expect(await refuses(saveChannel('recorder', 'slack', SLACK_URL))).toBe('FORBIDDEN');
    expect(await refuses(saveChannel('viewer', 'slack', SLACK_URL))).toBe('FORBIDDEN');
    expect(await refuses(saveChannel('owner', 'slack', `https://evil.example.com/${SVC}`))).toBe('CHAT_URL_INVALID');
    expect(await refuses(saveChannel('owner', 'slack', `http://hooks.slack.com/${SVC}`))).toBe('CHAT_URL_INVALID');
    expect(await refuses(saveChannel('owner', 'teams', SLACK_URL))).toBe('CHAT_URL_INVALID');
    // The address is in no readable column, no audit row and no event: only sealed bytes in the definer-only table.
    const stored = await sqlAdmin<{ envelope: Buffer }>('SELECT envelope FROM crove_meetings.chat_channel_target WHERE org_id = $1', [orgId]);
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) for (const bit of SECRET_BITS) expect(row.envelope.toString('latin1')).not.toContain(bit);
    const audit = await sqlAdmin<{ text: string }>(`SELECT (a::text) AS text FROM crove_kernel.audit_event a WHERE org_id = $1`, [orgId]);
    const events = await sqlAdmin<{ text: string }>(`SELECT (e::text) AS text FROM crove_kernel.outbox_pending e WHERE org_id = $1`, [orgId]);
    for (const row of [...audit.rows, ...events.rows]) for (const bit of SECRET_BITS) expect(row.text).not.toContain(bit);
  });

  it('queues a published result at the click and sends nothing in the request; the job posts it once, exactly as the recorder read it, and the message goes when the post settles', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const view = await preview(meeting);
    expect(view.message).toMatchObject({ title: 'Họp giao ban tuần', summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá cho khách', who: 'An', when: 'thứ sáu' }] });
    expect(view.channels).toMatchObject([{ id: channel, kind: 'slack', last: 'none', needsTick: false }]);
    expect(view.postsLeft).toBe(CHAT_POSTS_PER_MEETING_PER_DAY);
    const queued = await post(meeting, channel);
    expect(queued).toMatchObject({ state: 'queued' });
    // The click sends nothing: the row waits with its message.
    expect(sent).toHaveLength(0);
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'queued', attempts: 0, settled_at: null })]);
    expect(await bodies()).toBe(1);
    expect(await status(meeting, channel)).toMatchObject({ state: 'queued', code: null });
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'busy' });
    // The sweep hands it over and the job posts it.
    expect(await work()).toEqual({ [queued.postId]: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(SLACK_URL);
    const body = JSON.parse(sent[0]?.body ?? '{}') as { text: string; mrkdwn: boolean };
    expect(body.mrkdwn).toBe(false);
    expect(body.text).toContain('Họp giao ban tuần');
    expect(body.text).toContain('Chốt báo giá tuần này.');
    expect(body.text).toContain('• Giữ giá cũ');
    expect(body.text).toContain('• Gửi báo giá cho khách (An, thứ sáu)');
    expect(body.text).toContain(`https://app.test/o/cong-ty-chat/meetings/${meeting}`);
    // Never the transcript, nor an attendee's address.
    expect(body.text).not.toContain('BẢN GHI BÍ MẬT');
    expect(body.text).not.toMatch(/@chat\.test/);
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'sent', attempts: 1, http_status: 200, code: null })]);
    expect(await bodies()).toBe(0);
    expect(await status(meeting, channel)).toMatchObject({ state: 'sent', httpStatus: 200 });
    // A second pass finds nothing to send: a settled post is not sent again.
    expect(await work()).toEqual({});
    expect(await runJob(queued.postId)).toBe('skipped');
    expect(sent).toHaveLength(1);
    // The log holds hashes and ids: no word of the minutes in any column of any post row, and the audit names ids and counts.
    const row = await sqlAdmin<{ text: string }>('SELECT (p::text) AS text FROM crove_meetings.chat_post p WHERE org_id = $1', [orgId]);
    expect(row.rows[0]?.text).not.toMatch(/Chốt báo giá|Giữ giá cũ|Họp giao ban/);
    const audit = await sqlAdmin<{ text: string }>(`SELECT (a::text) AS text FROM crove_kernel.audit_event a WHERE org_id = $1 AND (a::text) LIKE '%meetings.chat%'`, [orgId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const r of audit.rows) {
      expect(r.text).not.toMatch(/Chốt báo giá|Giữ giá cũ|BẢN GHI/);
      for (const bit of SECRET_BITS) expect(r.text).not.toContain(bit);
    }
  });

  it('posts a Teams card the same way, with the link as an action', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('admin', 'teams', TEAMS_URL, 'Nhóm Kinh doanh');
    next = { status: 202 };
    const queued = await post(meeting, channel);
    expect(await work()).toEqual({ [queued.postId]: 'sent' });
    const card = JSON.parse(sent[0]?.body ?? '{}') as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: Array<{ text: string }>; actions: Array<{ type: string; url: string }> } }> };
    expect(card.type).toBe('message');
    expect(card.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.attachments[0]?.content.body.map((b) => b.text).join('\n')).toContain('Họp giao ban tuần');
    expect(card.attachments[0]?.content.actions[0]).toMatchObject({ type: 'Action.OpenUrl', url: `https://app.test/o/cong-ty-chat/meetings/${meeting}` });
    expect(sent[0]?.url).toContain('logic.azure.com/workflows/0123456789abcdef/triggers/manual/paths/invoke');
  });

  it('refuses a result that is not published, a recorder who is someone else, a viewer and an agent', async () => {
    const draftOnly = await seedMeeting(false);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    await exec('recorder', 'meetings.summary.save', { meetingId: draftOnly, summary: 'Chỉ là bản nháp', decisions: [] });
    expect(await refuses(preview(draftOnly))).toBe('NO_PUBLISHED_SUMMARY');
    expect(await refuses(postMinutesFromClick(deps(), scope('recorder'), { meetingId: draftOnly, channelId: channel, factsKey: 'a'.repeat(64), confirmRepeat: false }))).toBe('NO_PUBLISHED_SUMMARY');
    const meeting = await seedMeeting(true);
    // An attendee, the owner and an admin read or write nothing of someone else's meeting; the recorder alone posts.
    for (const who of ['attendee', 'owner', 'admin', 'outsider', 'viewer']) expect(await refuses(preview(meeting, who)), who).not.toBeNull();
    const view = await preview(meeting);
    for (const who of ['attendee', 'owner', 'admin', 'viewer']) {
      const code = await refuses(postMinutesFromClick(deps(), { ...scope('recorder'), actor: asUser(who) }, { meetingId: meeting, channelId: channel, factsKey: view.factsKey, confirmRepeat: false }));
      expect(code, who).not.toBeNull();
    }
    expect(await posts(meeting)).toEqual([]);
    expect(await work()).toEqual({});
    expect(sent).toHaveLength(0);
    // An agent context is refused the command by its access list.
    expect(await refuses(runtime.execute('meetings.chat.post', { meetingId: meeting, channelId: channel, factsKey: view.factsKey, confirmRepeat: false, link: null }, { actor: { type: 'agent', agentId: randomUUID() } as never, orgId }))).not.toBeNull();
    // The worker's commands are the system actor's: a member cannot record an outcome or read a message.
    const queued = await post(meeting, channel);
    expect(await refuses(exec('recorder', 'meetings.chat.record', { id: queued.postId, outcome: 'sent', httpStatus: 200, code: null }))).not.toBeNull();
    expect(await refuses(query('recorder', 'meetings.chat.delivery', { id: queued.postId }))).not.toBeNull();
    expect(await refuses(query('recorder', 'meetings.chat.target', { channelId: channel }))).not.toBeNull();
  });

  it('refuses when the published result changed since the recorder read it, and the new text is the one that goes', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const before = await preview(meeting);
    await exec('recorder', 'meetings.summary.save', { meetingId: meeting, summary: 'Đổi kế hoạch: gặp khách thứ hai.', decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.result.publish', { meetingId: meeting, confirmed: true });
    expect(await refuses(postMinutesFromClick(deps(), scope('recorder'), { meetingId: meeting, channelId: channel, factsKey: before.factsKey, confirmRepeat: false }))).toBe('STALE_CHAT');
    expect(await posts(meeting)).toEqual([]);
    const after = await preview(meeting);
    expect(after.factsKey).not.toBe(before.factsKey);
    const queued = await post(meeting, channel);
    expect(await work()).toEqual({ [queued.postId]: 'sent' });
    expect(sent[0]?.body).toContain('Đổi kế hoạch');
    expect(sent[0]?.body).not.toContain('Chốt báo giá tuần này');
  });

  it('drops a queued post, and deletes its message, when the published text of its meeting changes', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const queued = await post(meeting, channel);
    expect(await bodies()).toBe(1);
    // A personal-data erasure redacts the published summary: the message is a copy of that text and must not outlive it.
    await sqlAdmin(`UPDATE crove_meetings.meeting_result SET summary = '[đã xóa]' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, meeting]);
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'dropped', code: 'POST_DROPPED' })]);
    expect(await bodies()).toBe(0);
    expect(await runJob(queued.postId)).toBe('skipped');
    expect(await work()).toEqual({});
    expect(sent).toHaveLength(0);
    // A title rename drops a queued post too.
    const other = await seedMeeting(true);
    await post(other, channel);
    await sqlAdmin(`UPDATE crove_meetings.meeting SET title = 'Tên khác' WHERE org_id = $1 AND id = $2`, [orgId, other]);
    expect(await posts(other)).toEqual([expect.objectContaining({ state: 'dropped' })]);
    expect(await bodies()).toBe(0);
  });

  it('needs the tick to repeat a post that went, or may have gone, and none after a failure; one post waits at a time', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const first = await post(meeting, channel);
    expect(await refuses(post(meeting, channel, { confirmRepeat: true }))).toBe('CHAT_POST_BUSY');
    expect(await work()).toEqual({ [first.postId]: 'sent' });
    expect(await refuses(post(meeting, channel))).toBe('CHAT_ALREADY_POSTED');
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'sent', needsTick: true });
    const second = await post(meeting, channel, { confirmRepeat: true });
    expect(await work()).toEqual({ [second.postId]: 'sent' });
    expect(sent).toHaveLength(2);
  });

  it('settles a refusal as failed (no tick needed), tries a rate limit and an unreachable name again, and never sends again an answer that may have been delivered', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    // 404: the channel is gone: failed at once, with its code, no second attempt.
    next = { status: 404 };
    let q = await post(meeting, channel);
    expect(await work()).toEqual({ [q.postId]: 'failed' });
    expect(await status(meeting, channel)).toMatchObject({ state: 'failed', code: 'CHANNEL_GONE', httpStatus: 404 });
    expect(await bodies()).toBe(0);
    // Failed put nothing in the channel: a new post needs no tick.
    next = { status: 429, headers: { 'retry-after': '17' } };
    q = await post(meeting, channel);
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET handed_at = now() WHERE org_id = $1 AND id = $2`, [orgId, q.postId]);
    expect(await runJob(q.postId, 0)).toBe('retry');
    expect(await posts(meeting)).toEqual([expect.anything(), expect.objectContaining({ state: 'queued', attempts: 1, code: 'CHANNEL_RATE_LIMITED', settled_at: null })]);
    expect(await bodies()).toBe(1);
    // The queue tries again: now the channel takes it.
    next = { status: 200 };
    expect(await runJob(q.postId, 1)).toBe('sent');
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'sent', attempts: 2, code: null });
    expect(await bodies()).toBe(0);
    // An unreachable name is tried again too, until the tries are spent: then failed.
    next = { fail: 'dns' };
    q = await post(meeting, channel, { confirmRepeat: true });
    expect(await runJob(q.postId, 0)).toBe('retry');
    expect(await runJob(q.postId, CHAT_RETRY_LIMIT)).toBe('failed');
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'failed', attempts: 2, code: 'CHANNEL_UNREACHABLE' });
    // A lost answer may be in the channel: settled ambiguous, never sent again, and a repeat needs the tick.
    next = { fail: 'timeout' };
    q = await post(meeting, channel, { confirmRepeat: true });
    const before = sent.length;
    expect(await runJob(q.postId, 0)).toBe('ambiguous');
    expect(sent.length).toBe(before + 1);
    expect(await runJob(q.postId, 1)).toBe('skipped');
    expect(sent.length).toBe(before + 1);
    expect(await status(meeting, channel)).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_TIMEOUT' });
    expect(await refuses(post(meeting, channel))).toBe('CHAT_ALREADY_POSTED');
    next = { status: 502 };
    q = await post(meeting, channel, { confirmRepeat: true });
    expect(await runJob(q.postId, 0)).toBe('ambiguous');
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_SERVER_ERROR', http_status: 502 });
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'ambiguous', needsTick: true });
  });

  it('stops at the day limit, counted per meeting under a lock', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    for (let i = 0; i < CHAT_POSTS_PER_MEETING_PER_DAY; i += 1) {
      const q = await post(meeting, channel, { confirmRepeat: true });
      expect(await runJob(q.postId)).toBe('sent');
    }
    expect(await refuses(post(meeting, channel, { confirmRepeat: true }))).toBe('CHAT_LIMIT');
    expect((await preview(meeting)).postsLeft).toBe(0);
  });

  it('sends only while the person who saved the channel is an owner or admin and not disabled: a demoted or disabled saver stops a new click and drops a queued post', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('admin', 'slack', SLACK_URL);
    const queued = await post(meeting, channel);
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    expect(await refuses(post(meeting, channel, { confirmRepeat: true }))).toBe('CHAT_CHANNEL_OWNER_LEFT');
    // The queued post is dropped by the job: no address is handed to it, nothing is sent, and the message is deleted.
    expect(await work()).toEqual({ [queued.postId]: 'dropped' });
    expect(sent).toHaveLength(0);
    expect(await status(meeting, channel)).toMatchObject({ state: 'dropped', code: 'CHANNEL_NOT_STANDING' });
    expect(await bodies()).toBe(0);
    // The owner pastes the address again: the channel is theirs now and works.
    await saveChannel('owner', 'slack', SLACK_URL, 'Kênh họp giao ban', channel);
    const again = await post(meeting, channel);
    expect(await work()).toEqual({ [again.postId]: 'sent' });
    // A saver who is disabled: the address is not handed out and the post drops.
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    const other = await saveChannel('admin', 'slack', SLACK_URL, 'Kênh của admin');
    const third = await post(meeting, other.id);
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.admin]);
    const before = sent.length;
    expect(await work()).toEqual({ [third.postId]: 'dropped' });
    expect(sent).toHaveLength(before);
  });

  it('hands the sealed address to the worker only while the channel stands: its saver an owner or admin and not disabled, its org active, the channel there, and the org of the worker\'s own context', async () => {
    const { id: channel } = await saveChannel('admin', 'slack', SLACK_URL);
    const system = { actor: { type: 'system' as const, component: 'meetings.chat' }, orgId };
    const target = () => worker.query<{ keyId: string; envelope: string } | null>('meetings.chat.target', { channelId: channel }, system);
    expect(await target()).toMatchObject({ keyId: expect.any(String), envelope: expect.any(String) });
    // A user's own request never reaches it (no system context): the query is the worker's alone.
    expect(await refuses(runtime.query('meetings.chat.target', { channelId: channel }, { actor: asUser('owner'), orgId }))).not.toBeNull();
    // A saver who was demoted, then restored, then disabled, then enabled again: the address is handed out only while the saver stands.
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    expect(await target()).toBeNull();
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    expect(await target()).not.toBeNull();
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.admin]);
    expect(await target()).toBeNull();
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.admin]);
    expect(await target()).not.toBeNull();
    // An org that is not active (offboarding or closed) hands out nothing.
    const status = (await sqlAdmin<{ status: string }>('SELECT status FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.status;
    await sqlAdmin(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [orgId]);
    try {
      // The runtime may refuse to enter an org that is not active at all, or the definer hands out nothing: either way no address.
      expect(await target().catch(() => null)).toBeNull();
    } finally {
      await sqlAdmin('UPDATE crove_kernel.tenant SET status = $2 WHERE org_id = $1', [orgId, status]);
    }
    expect(await target()).not.toBeNull();
    // A removed channel is gone with its address.
    await exec('owner', 'meetings.chat.channel_remove', { id: channel });
    expect(await target()).toBeNull();
  });

  it('checks the host again at the send: a sealed address on another host is never called', async () => {
    const meeting = await seedMeeting(true);
    const id = randomUUID();
    const sealed = vault.seal(`https://evil.example.com/${SVC}`, { orgId, provider: 'meeting-chat', externalAccountId: id });
    await exec('owner', 'meetings.chat.channel_save', { id, kind: 'slack', label: 'Sai host', host: 'hooks.slack.com', keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') });
    const q = await post(meeting, id);
    expect(await runJob(q.postId)).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(await status(meeting, id)).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_INVALID' });
  });

  it('records a failure, not a call, when the sealed address no longer opens (a lost or rotated key), and does not try it again', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const q = await post(meeting, channel);
    const other = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    expect(await runJob(q.postId, 0, { broker: other })).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(await status(meeting, channel)).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_UNREADABLE' });
  });

  it('never sends a post twice: a second job and a replay do nothing, and a worker that died after the request left leaves it ambiguous', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    let q = await post(meeting, channel);
    // Two jobs for one post at once: the database lets one begin.
    const results = await Promise.all([runJob(q.postId), runJob(q.postId)]);
    expect(results.sort()).toEqual(['sent', 'skipped']);
    expect(sent).toHaveLength(1);
    // The worker dies after the request left and before the outcome: the attempt had begun, so the post is neither handed over again nor expired, and the queue's replay does nothing.
    sent = [];
    q = await post(meeting, channel, { confirmRepeat: true });
    await worker.execute('meetings.chat.record', { id: q.postId, outcome: 'begin', httpStatus: null, code: null }, { actor: { type: 'system', component: 'meetings.chat' }, orgId });
    expect(await runJob(q.postId, 1)).toBe('skipped');
    expect(sent).toHaveLength(0);
    const handed: string[] = [];
    const sweep = () => runMeetingChatSweep({ runtime: worker, workerDb, send: async (job) => void handed.push(job.id) });
    expect(await sweep()).toEqual({ handedOver: 0, expired: 0, lost: 0, failures: 0 });
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET created_at = now() - interval '9 hours', sending_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2`, [orgId, q.postId]);
    expect(await sweep()).toEqual({ handedOver: 0, expired: 0, lost: 0, failures: 0 });
    // After three minutes the sweep settles it ambiguous, with the body gone, and never hands it over.
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET sending_at = now() - interval '4 minutes' WHERE org_id = $1 AND id = $2`, [orgId, q.postId]);
    expect(await sweep()).toEqual({ handedOver: 0, expired: 0, lost: 1, failures: 0 });
    expect(handed).toEqual([]);
    // (the backdated post is the oldest row now)
    expect((await posts(meeting)).find((p) => p.state === 'ambiguous')).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_NO_ANSWER' });
    expect(await bodies()).toBe(0);
    expect(await refuses(post(meeting, channel))).toBe('CHAT_ALREADY_POSTED');
  });

  it('does not drop a post whose attempt has begun when the text changes, and drops a queued one when the published rows are deleted', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const q = await post(meeting, channel);
    await worker.execute('meetings.chat.record', { id: q.postId, outcome: 'begin', httpStatus: null, code: null }, { actor: { type: 'system', component: 'meetings.chat' }, orgId });
    await sqlAdmin(`UPDATE crove_meetings.meeting SET title = 'Họp giao ban tuần (đã sửa)' WHERE org_id = $1 AND id = $2`, [orgId, meeting]);
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'queued' });
    expect(await bodies()).toBe(1);
    // Publishing again, or unsharing, deletes the published rows: a queued message of the old version is dropped.
    const other = await seedMeeting(true);
    await post(other, channel);
    await sqlAdmin(`DELETE FROM crove_meetings.action_item WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, other]);
    expect((await posts(other)).at(-1)).toMatchObject({ state: 'dropped', code: 'POST_DROPPED' });
    const third = await seedMeeting(true);
    await post(third, channel);
    await sqlAdmin(`DELETE FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, third]);
    expect((await posts(third)).at(-1)).toMatchObject({ state: 'dropped' });
  });

  it('lets neither the sweep\'s expiry nor a drop settle a post whose attempt has begun, and lets no job begin an expired post', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const system = { actor: { type: 'system' as const, component: 'meetings.chat' }, orgId };
    const record = async (id: string, outcome: string) => (await worker.execute<{ recorded: boolean }>('meetings.chat.record', { id, outcome, httpStatus: null, code: null }, system)).recorded;
    const q = await post(meeting, channel);
    expect(await record(q.postId, 'begin')).toBe(true);
    // The request may be out: an expiry or a drop from elsewhere (the sweep, a stale list) changes nothing, the body stays for the attempt's own outcome.
    expect(await record(q.postId, 'expired')).toBe(false);
    expect(await record(q.postId, 'dropped')).toBe(false);
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'queued' });
    expect(await bodies()).toBe(1);
    expect(await record(q.postId, 'sent')).toBe(true);
    // A post older than eight hours cannot begin: only the sweep expires it, so the job and the sweep agree on one rule.
    const old = await post(meeting, channel, { confirmRepeat: true });
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET created_at = now() - interval '9 hours' WHERE org_id = $1 AND id = $2`, [orgId, old.postId]);
    expect(await record(old.postId, 'begin')).toBe(false);
    expect(await runJob(old.postId)).toBe('skipped');
    expect(await record(old.postId, 'expired')).toBe(true);
    expect((await posts(meeting)).find((p) => p.code === 'POST_EXPIRED')).toMatchObject({ state: 'failed' });
  });

  it('leaves no body row for any post that settled, whichever way, and keeps it only while the post is queued', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const system = { actor: { type: 'system' as const, component: 'meetings.chat' }, orgId };
    const bodyRows = async (postId: string) => Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.chat_post_body WHERE org_id = $1 AND post_id = $2', [orgId, postId])).rows[0]?.n);
    for (const outcome of ['sent', 'failed', 'ambiguous', 'dropped', 'expired'] as const) {
      const q = await post(meeting, channel, { confirmRepeat: true });
      expect(await bodyRows(q.postId), `${outcome}: queued keeps its body`).toBe(1);
      // A retry keeps the body: the post is still queued.
      await worker.execute('meetings.chat.record', { id: q.postId, outcome: 'retry', httpStatus: null, code: 'CHANNEL_UNREACHABLE' }, system);
      expect(await bodyRows(q.postId), `${outcome}: retry keeps its body`).toBe(1);
      await worker.execute('meetings.chat.record', { id: q.postId, outcome, httpStatus: null, code: outcome === 'failed' || outcome === 'ambiguous' ? 'CHANNEL_GONE' : null }, system);
      expect(await bodyRows(q.postId), `${outcome}: settled leaves no body`).toBe(0);
    }
    expect(await bodies()).toBe(0);
  });

  it('lets the recorder insert only a plain queued post: the columns of the worker (handed_at, sending_at) are refused at the insert', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const insert = (who: string, flags: { sendingAt: boolean; handedAt: boolean }) => refuses(exec(who, 'meetings.test.chat_post_insert', { meetingId: meeting, channelId: channel, ...flags }));
    expect(await insert('recorder', { sendingAt: true, handedAt: false })).not.toBeNull();
    expect(await insert('recorder', { sendingAt: false, handedAt: true })).not.toBeNull();
    expect(await insert('recorder', { sendingAt: true, handedAt: true })).not.toBeNull();
    expect(await posts(meeting)).toEqual([]);
    // The plain row passes the policy (the control: the refusals above are the columns, not the test's insert), and only the recorder may.
    expect(await insert('recorder', { sendingAt: false, handedAt: false })).toBeNull();
    expect(await insert('attendee', { sendingAt: false, handedAt: false })).not.toBeNull();
    expect(await posts(meeting)).toHaveLength(1);
  });

  it('carries no link in a post when the app address is not https', async () => {
    const meeting = await seedMeeting(true);
    expect(minutesLink('http://localhost:8080', 'cong-ty-chat', meeting)).toBeNull();
    expect(minutesLink('https://app.test', 'cong-ty-chat', meeting)).toBe(`https://app.test/o/cong-ty-chat/meetings/${meeting}`);
  });

  it('hands a post over once, again after three minutes if no job took it up, and fails one that waited eight hours', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const q = await post(meeting, channel);
    const handed: string[] = [];
    const sweep = () => runMeetingChatSweep({ runtime: worker, workerDb, send: async (job) => void handed.push(job.id) });
    expect(await sweep()).toEqual({ handedOver: 1, expired: 0, lost: 0, failures: 0 });
    expect(await sweep()).toEqual({ handedOver: 0, expired: 0, lost: 0, failures: 0 });
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET handed_at = now() - interval '4 minutes' WHERE org_id = $1 AND id = $2`, [orgId, q.postId]);
    expect(await sweep()).toEqual({ handedOver: 1, expired: 0, lost: 0, failures: 0 });
    expect(handed).toEqual([q.postId, q.postId]);
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET created_at = now() - interval '9 hours' WHERE org_id = $1 AND id = $2`, [orgId, q.postId]);
    expect(await sweep()).toEqual({ handedOver: 0, expired: 1, lost: 0, failures: 0 });
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'failed', code: 'POST_EXPIRED' })]);
    expect(await bodies()).toBe(0);
    // A failing queue leaves the post stored, to be handed over again.
    const again = await post(meeting, channel);
    const failing = await runMeetingChatSweep({ runtime: worker, workerDb, send: async () => Promise.reject(new Error('queue down')) });
    expect(failing).toEqual({ handedOver: 0, expired: 0, lost: 0, failures: 1 });
    expect((await posts(meeting)).at(-1)).toMatchObject({ state: 'queued' });
    expect(await work()).toEqual({ [again.postId]: 'sent' });
  });

  it('is reachable by no login role beyond the API\'s two functions and the worker\'s: the tables by none, the address and the message by the worker alone', async () => {
    const url = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    for (const [user, password] of [['crove_app', 'test-app-pw'], ['crove_worker', 'test-worker-pw']] as const) {
      const c = new pg.Client({ connectionString: url(user, password) });
      await c.connect();
      try {
        for (const table of ['chat_channel_target', 'chat_post_body']) await expect(c.query(`SELECT * FROM crove_meetings.${table}`)).rejects.toThrow(/permission denied/);
        await expect(c.query('UPDATE crove_meetings.chat_post SET state = \'sent\'')).rejects.toThrow(/permission denied/);
        const callable = async (sql: string, params: unknown[]) => c.query(sql, sql.includes('$1') ? params : []).then(() => true, (e: Error) => !/permission denied/.test(e.message));
        const uuid = randomUUID();
        // The API's two: sealing an address in and storing the message of the recorder's own click.
        expect(await callable('SELECT crove_meetings.chat_target_put($1::uuid, $2, $3)', [uuid, 'k', Buffer.from('x')]), `${user} chat_target_put`).toBe(user === 'crove_app');
        expect(await callable('SELECT crove_meetings.chat_post_enqueue($1::uuid, $2::jsonb)', [uuid, '{}']), `${user} chat_post_enqueue`).toBe(user === 'crove_app');
        // The worker's: reading the address and the message out, the sweep, the outcome, the rotation pass.
        expect(await callable('SELECT * FROM crove_meetings.chat_target_get($1::uuid)', [uuid]), `${user} chat_target_get`).toBe(user === 'crove_worker');
        expect(await callable('SELECT * FROM crove_meetings.chat_post_get($1::uuid, $2::uuid)', [uuid, uuid]), `${user} chat_post_get`).toBe(user === 'crove_worker');
        expect(await callable('SELECT * FROM crove_meetings.chat_open(5)', []), `${user} chat_open`).toBe(user === 'crove_worker');
        expect(await callable('SELECT crove_meetings.chat_touch($1::uuid)', [uuid]), `${user} chat_touch`).toBe(user === 'crove_worker');
        expect(await callable('SELECT crove_meetings.chat_record($1::uuid, $2, NULL, NULL)', [uuid, 'sent']), `${user} chat_record`).toBe(user === 'crove_worker');
        expect(await callable('SELECT * FROM crove_meetings.chat_target_key_counts()', []), `${user} chat_target_key_counts`).toBe(user === 'crove_worker');
        // No login role runs the helpers that only the others call.
        for (const call of ['crove_meetings.chat_standing($1::uuid, $1::uuid)', 'crove_meetings.chat_system()', 'crove_meetings.chat_drop_queued($1::uuid, $1::uuid)']) expect(await callable(`SELECT ${call}`, [uuid]), `${user} ${call}`).toBe(false);
      } finally {
        await c.end();
      }
    }
  });

  it('reseals a minutes channel\'s address after a credential key rotation, only for a channel whose saver is still an owner or admin', async () => {
    const { id: stands } = await saveChannel('owner', 'slack', SLACK_URL, 'Còn hiệu lực');
    const { id: demoted } = await saveChannel('admin', 'slack', SLACK_URL, 'Của admin');
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.admin]);
    const oldKey = parseVaultKey(randomBytes(32).toString('base64'));
    const oldVault = new CredentialVault([oldKey]);
    // Seal both under the old key.
    for (const [id, who] of [[stands, 'owner'], [demoted, 'admin']] as const) {
      const sealed = oldVault.seal(SLACK_URL, { orgId, provider: 'meeting-chat', externalAccountId: id });
      await sqlAdmin(`UPDATE crove_meetings.chat_channel SET created_by = $3 WHERE org_id = $1 AND id = $2`, [orgId, id, users[who]]);
      await sqlAdmin(`UPDATE crove_meetings.chat_channel_target SET key_id = $3, envelope = $4 WHERE org_id = $1 AND channel_id = $2`, [orgId, id, sealed.keyId, sealed.envelope]);
    }
    const next = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64')), oldKey]);
    const outcome = await resealCredentials({ runtime: worker, broker: next, workerDb });
    expect(outcome.resealed).toBeGreaterThanOrEqual(1);
    const keyOf = async (id: string) => (await sqlAdmin<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM crove_meetings.chat_channel_target WHERE org_id = $1 AND channel_id = $2', [orgId, id])).rows[0];
    const now = await keyOf(stands);
    expect(now?.key_id).toBe(next.keyId);
    expect(next.open({ keyId: now?.key_id as string, envelope: now?.envelope as Buffer }, { orgId, provider: 'meeting-chat', externalAccountId: stands })).toBe(SLACK_URL);
    // The demoted saver's address waits to be pasted again; it is counted, not resealed.
    expect((await keyOf(demoted))?.key_id).toBe(oldVault.keyId);
    expect(outcome.leftInactive).toBeGreaterThanOrEqual(1);
  });

  it('says so when the deployment has no credential key, and removing a channel removes its address, its queued posts and their messages', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    expect(await refuses(saveMinutesChannel(deps({ broker: { id: 'none', seal: vault.seal.bind(vault) } }), scope('owner'), { kind: 'slack', label: 'x', url: SLACK_URL }))).toBe('BROKER_NOT_CONFIGURED');
    // No credential key, no worker to open an address: a click is refused instead of queueing a message that nothing would send or expire.
    const view = await preview(meeting);
    expect(await refuses(postMinutesFromClick(deps({ broker: { id: 'none', seal: vault.seal.bind(vault) } }), scope('recorder'), { meetingId: meeting, channelId: channel, factsKey: view.factsKey, confirmRepeat: false }))).toBe('BROKER_NOT_CONFIGURED');
    expect(await posts(meeting)).toEqual([]);
    // A member refused at the role check does not use up the owner's saves.
    const tight = new MinutesSaveBudget(1);
    expect(await refuses(saveMinutesChannel(deps({ saves: tight }), scope('recorder'), { kind: 'slack', label: 'x', url: SLACK_URL }))).not.toBe('CHAT_SAVE_LIMIT');
    expect(await refuses(saveMinutesChannel(deps({ saves: tight }), scope('owner'), { kind: 'slack', label: 'Của owner', url: SLACK_URL }))).toBeNull();
    const q = await post(meeting, channel);
    expect(await bodies()).toBe(1);
    expect(await refuses(exec('recorder', 'meetings.chat.channel_remove', { id: channel }))).not.toBeNull();
    await exec('admin', 'meetings.chat.channel_remove', { id: channel });
    expect((await sqlAdmin('SELECT 1 FROM crove_meetings.chat_channel_target WHERE org_id = $1 AND channel_id = $2', [orgId, channel])).rowCount).toBe(0);
    expect(await posts(meeting)).toEqual([]);
    expect(await bodies()).toBe(0);
    expect(await runJob(q.postId)).toBe('skipped');
  });

  it('keeps the address out of the logs', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      next = { fail: 'network' };
      const a = await post(meeting, channel);
      await runJob(a.postId);
      const other = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
      const b = await post(meeting, channel, { confirmRepeat: true });
      await runJob(b.postId, 0, { broker: other });
    } finally {
      console.warn = warn;
    }
    for (const line of logged) for (const bit of SECRET_BITS) expect(line).not.toContain(bit);
  });
});
