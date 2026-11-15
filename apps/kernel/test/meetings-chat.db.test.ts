// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168, plan section 5.2) on a real database: an owner or admin saves a webhook address (sealed, never read back as text),
// the recorder reads the exact message of a PUBLISHED result and posts it in their own request (one call through the adapter, here a fake fetch), the post is recorded `started` before the call and
// settled after it (sent, failed or ambiguous), a repeat needs the recorder's tick, the facts the recorder read must still be the published ones, the day's limit holds, the sealed address opens only
// for the recorder's own post in flight, and no row, audit entry or log line holds the address or the text.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CHAT_POSTS_PER_MEETING_PER_DAY, type ChatChannelList, type ChatPosted, type ChatPreview } from '@crove/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { MinutesSaveBudget, postMinutesFromClick, saveMinutesChannel, type MinutesChatDeps } from '../src/meeting-chat.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

// Built from pieces so the repository holds no string shaped like a Slack webhook address (secret scanners flag one, real or not).
const SVC = ['services', 'T0000000A', 'B0000000B', 'abcdefghijklmnopqrstuvwx'].join('/');
const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SLACK_URL = `https://hooks.slack.com/${SVC}`;
const TEAMS_URL = 'https://prod-12.southeastasia.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SECRETSIGNATURE';
const SECRET_BITS = ['abcdefghijklmnopqrstuvwx', 'SECRETSIGNATURE', 'T0000000A'];

interface Sent {
  url: string;
  body: string;
}

suite('minutes posted to Slack and Teams from the recorder\'s click (B4, #3168)', () => {
  const dbName = `crove_test_meeting_chat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
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
  const deps = (over: Partial<MinutesChatDeps> = {}): MinutesChatDeps => ({ runtime, broker: vault, publicUrl: 'https://app.test', send, saves: new MinutesSaveBudget(1000), ...over });
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
  const posts = async (meetingId: string) => (await sqlAdmin<{ state: string; http_status: number | null; code: string | null; settled_at: Date | null }>('SELECT state, http_status, code, settled_at FROM crove_meetings.chat_post WHERE org_id = $1 AND meeting_id = $2 ORDER BY created_at, id', [orgId, meetingId])).rows;

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
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
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
    // No login role reads the sealed table or opens an address outside a post in flight.
    for (const [user, password] of [['crove_app', 'test-app-pw'], ['crove_worker', 'test-worker-pw']] as const) {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        await expect(c.query('SELECT envelope FROM crove_meetings.chat_channel_target')).rejects.toThrow(/permission denied/);
        await expect(c.query('SELECT * FROM crove_meetings.chat_target_for_post($1::uuid)', [randomUUID()])).rejects.toThrow(user === 'crove_app' ? /NO_CONTEXT/ : /permission denied/);
      } finally {
        await c.end();
      }
    }
  });

  it('posts a published result once, exactly as the recorder read it, records started before and sent after, and keeps no text', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const view = await preview(meeting);
    expect(view.message).toMatchObject({ title: 'Họp giao ban tuần', summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá cho khách', who: 'An', when: 'thứ sáu' }] });
    expect(view.channels).toMatchObject([{ id: channel, kind: 'slack', last: 'none' }]);
    expect(view.postsLeft).toBe(CHAT_POSTS_PER_MEETING_PER_DAY);
    const result = await post(meeting, channel);
    expect(result).toMatchObject({ state: 'sent', retryAfterSeconds: null, code: null });
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
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'sent', http_status: 200, code: null })]);
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
    expect(await post(meeting, channel)).toMatchObject({ state: 'sent' });
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
    for (const who of ['attendee', 'owner', 'admin', 'outsider', 'viewer']) {
      const code = await refuses(preview(meeting, who));
      expect(code, who).not.toBeNull();
    }
    const view = await preview(meeting);
    for (const who of ['attendee', 'owner', 'admin', 'viewer']) {
      const code = await refuses(postMinutesFromClick(deps(), { ...scope('recorder'), actor: asUser(who) }, { meetingId: meeting, channelId: channel, factsKey: view.factsKey, confirmRepeat: false }));
      expect(code, who).not.toBeNull();
    }
    expect(sent).toHaveLength(0);
    expect(await posts(meeting)).toEqual([]);
    // An agent context is refused the command by its access list.
    expect(await refuses(runtime.execute('meetings.chat.begin', { meetingId: meeting, channelId: channel, factsKey: view.factsKey, textHash: 'b'.repeat(64), confirmRepeat: false }, { actor: { type: 'agent', agentId: randomUUID() } as never, orgId }))).not.toBeNull();
  });

  it('refuses when the published result changed since the recorder read it, and the new text is the one that goes', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const before = await preview(meeting);
    await exec('recorder', 'meetings.summary.save', { meetingId: meeting, summary: 'Đổi kế hoạch: gặp khách thứ hai.', decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.result.publish', { meetingId: meeting, confirmed: true });
    expect(await refuses(postMinutesFromClick(deps(), scope('recorder'), { meetingId: meeting, channelId: channel, factsKey: before.factsKey, confirmRepeat: false }))).toBe('STALE_CHAT');
    expect(sent).toHaveLength(0);
    expect(await posts(meeting)).toEqual([]);
    const after = await preview(meeting);
    expect(after.factsKey).not.toBe(before.factsKey);
    expect(await post(meeting, channel)).toMatchObject({ state: 'sent' });
    expect(sent[0]?.body).toContain('Đổi kế hoạch');
    expect(sent[0]?.body).not.toContain('Chốt báo giá tuần này');
  });

  it('needs the tick to repeat a post that went, or may have gone, and none after a failure', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    expect(await post(meeting, channel)).toMatchObject({ state: 'sent' });
    expect(await refuses(post(meeting, channel))).toBe('CHAT_ALREADY_POSTED');
    expect(sent).toHaveLength(1);
    expect(await post(meeting, channel, { confirmRepeat: true })).toMatchObject({ state: 'sent' });
    expect(sent).toHaveLength(2);
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'sent' });
  });

  it('records a refused call as failed (no tick needed), a rate limit with its seconds, and a lost answer as ambiguous (a tick needed)', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    next = { status: 404 };
    expect(await post(meeting, channel)).toMatchObject({ state: 'failed', code: 'CHANNEL_GONE' });
    next = { status: 429, headers: { 'retry-after': '17' } };
    expect(await post(meeting, channel)).toMatchObject({ state: 'failed', code: 'CHANNEL_RATE_LIMITED', retryAfterSeconds: 17 });
    next = { fail: 'dns' };
    expect(await post(meeting, channel)).toMatchObject({ state: 'failed', code: 'CHANNEL_UNREACHABLE' });
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'failed' });
    next = { fail: 'timeout' };
    expect(await post(meeting, channel)).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_TIMEOUT' });
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'ambiguous' });
    expect(await refuses(post(meeting, channel))).toBe('CHAT_ALREADY_POSTED');
    next = { status: 502 };
    expect(await post(meeting, channel, { confirmRepeat: true })).toMatchObject({ state: 'ambiguous', code: 'CHANNEL_SERVER_ERROR' });
    expect((await posts(meeting)).map((p) => p.state)).toEqual(['failed', 'failed', 'failed', 'ambiguous', 'ambiguous']);
  });

  it('reads a post whose request died before it recorded an outcome as ambiguous after two minutes, and one running now as busy', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const view = await preview(meeting);
    const textHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify([view.message.v, view.message.lang, view.message.title, view.message.day, view.message.summary, view.message.decisions, view.message.items.map((i) => [i.title, i.who, i.when])])).digest('hex');
    const begin = (confirmRepeat = false) => exec<{ postId: string }>('recorder', 'meetings.chat.begin', { meetingId: meeting, channelId: channel, factsKey: view.factsKey, textHash, confirmRepeat });
    const first = await begin();
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'busy' });
    expect(await refuses(begin(true))).toBe('CHAT_POST_BUSY');
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET created_at = now() - interval '3 minutes' WHERE org_id = $1 AND id = $2`, [orgId, first.postId]);
    expect((await preview(meeting)).channels[0]).toMatchObject({ last: 'ambiguous' });
    expect(await refuses(begin(false))).toBe('CHAT_ALREADY_POSTED');
    expect(await begin(true)).toMatchObject({ postId: expect.any(String) });
  });

  it('stops at the day limit, counted per meeting under a lock', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    for (let i = 0; i < CHAT_POSTS_PER_MEETING_PER_DAY; i += 1) expect(await post(meeting, channel, { confirmRepeat: true })).toMatchObject({ state: 'sent' });
    expect(await refuses(post(meeting, channel, { confirmRepeat: true }))).toBe('CHAT_LIMIT');
    expect((await preview(meeting)).postsLeft).toBe(0);
  });

  it('opens the sealed address only for the recorder\'s own post in flight, to the API login alone, and once it settles it opens for nobody', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const view = await preview(meeting);
    const { createHash } = await import('node:crypto');
    const textHash = createHash('sha256').update(JSON.stringify([view.message.v, view.message.lang, view.message.title, view.message.day, view.message.summary, view.message.decisions, view.message.items.map((i) => [i.title, i.who, i.when])])).digest('hex');
    const begun = await exec<{ postId: string }>('recorder', 'meetings.chat.begin', { meetingId: meeting, channelId: channel, factsKey: view.factsKey, textHash, confirmRepeat: false });
    // Not another member, not the owner or an admin, not a post that does not exist.
    for (const who of ['attendee', 'owner', 'admin', 'outsider', 'viewer']) expect(await refuses(query(who, 'meetings.chat.target', { postId: begun.postId })), who).not.toBeNull();
    expect(await refuses(query('recorder', 'meetings.chat.target', { postId: randomUUID() }))).toBe('CHAT_POST_NOT_OPEN');
    // The worker login has no execute on the definer.
    expect(await refuses(worker.query('meetings.chat.target', { postId: begun.postId }, { actor: asUser('recorder'), orgId }))).not.toBeNull();
    const target = await query<{ keyId: string; envelope: string }>('recorder', 'meetings.chat.target', { postId: begun.postId });
    expect(vault.open({ keyId: target.keyId, envelope: Buffer.from(target.envelope, 'base64') }, { orgId, provider: 'meeting-chat', externalAccountId: channel })).toBe(SLACK_URL);
    // The binding matters: the same bytes do not open for another channel's id.
    expect(() => vault.open({ keyId: target.keyId, envelope: Buffer.from(target.envelope, 'base64') }, { orgId, provider: 'meeting-chat', externalAccountId: randomUUID() })).toThrow();
    await exec('recorder', 'meetings.chat.settle', { postId: begun.postId, state: 'sent', httpStatus: 200, code: null });
    expect(await refuses(query('recorder', 'meetings.chat.target', { postId: begun.postId }))).toBe('CHAT_POST_NOT_OPEN');
    // A post older than two minutes opens nothing either.
    const second = await exec<{ postId: string }>('recorder', 'meetings.chat.begin', { meetingId: meeting, channelId: channel, factsKey: view.factsKey, textHash, confirmRepeat: true });
    await sqlAdmin(`UPDATE crove_meetings.chat_post SET created_at = now() - interval '3 minutes' WHERE org_id = $1 AND id = $2`, [orgId, second.postId]);
    expect(await refuses(query('recorder', 'meetings.chat.target', { postId: second.postId }))).toBe('CHAT_POST_NOT_OPEN');
  });

  it('checks the host again at the send: a sealed address on another host is never called', async () => {
    const meeting = await seedMeeting(true);
    const id = randomUUID();
    const sealed = vault.seal(`https://evil.example.com/${SVC}`, { orgId, provider: 'meeting-chat', externalAccountId: id });
    await exec('owner', 'meetings.chat.channel_save', { id, kind: 'slack', label: 'Sai host', host: 'hooks.slack.com', keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') });
    expect(await post(meeting, id)).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('records a failure, not a call, when the sealed address no longer opens (a lost or rotated key)', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const other = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const view = await preview(meeting);
    const result = await postMinutesFromClick(deps({ broker: other }), scope('recorder'), { meetingId: meeting, channelId: channel, factsKey: view.factsKey, confirmRepeat: false });
    expect(result).toMatchObject({ state: 'failed', code: 'CHANNEL_ADDRESS_UNREADABLE' });
    expect(sent).toHaveLength(0);
    expect(await posts(meeting)).toEqual([expect.objectContaining({ state: 'failed', code: 'CHANNEL_ADDRESS_UNREADABLE' })]);
  });

  it('says so when the deployment has no credential key, and removing a channel removes its address and its log', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    expect(await refuses(saveMinutesChannel(deps({ broker: { id: 'none', seal: vault.seal.bind(vault), open: vault.open.bind(vault) } }), scope('owner'), { kind: 'slack', label: 'x', url: SLACK_URL }))).toBe('BROKER_NOT_CONFIGURED');
    expect(await post(meeting, channel)).toMatchObject({ state: 'sent' });
    expect(await refuses(exec('recorder', 'meetings.chat.channel_remove', { id: channel }))).not.toBeNull();
    await exec('admin', 'meetings.chat.channel_remove', { id: channel });
    expect((await sqlAdmin('SELECT 1 FROM crove_meetings.chat_channel_target WHERE org_id = $1', [orgId])).rowCount).toBe(0);
    expect(await posts(meeting)).toEqual([]);
  });

  it('keeps the address out of the logs', async () => {
    const meeting = await seedMeeting(true);
    const { id: channel } = await saveChannel('owner', 'slack', SLACK_URL);
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      next = { fail: 'network' };
      await post(meeting, channel);
      const other = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
      await postMinutesFromClick(deps({ broker: other }), scope('recorder'), { meetingId: meeting, channelId: channel, factsKey: (await preview(meeting)).factsKey, confirmRepeat: true });
    } finally {
      console.warn = warn;
    }
    for (const line of logged) for (const bit of SECRET_BITS) expect(line).not.toContain(bit);
  });
});
