// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168, plan docs/plan/meetings-integrations.md section 5.2), by a worker job like the minutes webhook's (A6). The org's
// channels are rows an owner or admin saves (the webhook address itself is sealed by the API route and kept in a definer-only table; the API never reads it back). The recorder of a meeting with a
// published result reads the exact message, picks a channel and presses "Gửi":
//   meetings.chat.preview   (the recorder; sensitive: it reads the published text) the message as it would go, the key of the facts it was built from, the channels and where this recorder's earlier posts of
//                           this meeting stand.
//   meetings.chat.post      (the recorder; R2, it is the click that sends) rebuilds the message from the PUBLISHED result at this moment, refuses it when the recorder read another version (STALE_CHAT),
//                           checks the tick for a repeat, the one post at a time and the day's limit, and QUEUES the post: the row (ids, hashes, never text) and its message, in the recorder's own transaction
//                           (the system context cannot read meetings). Nothing leaves in this request.
//   meetings.chat.status    (the recorder) how their newest post to a channel stands, for the dialog to poll: a state and a fixed code.
// The worker's side, all of the system actor (apps/kernel meeting-chat-job.ts, meeting-chat-sweep.ts, credential-reseal.ts): meetings.chat.delivery reads a queued post (the message), meetings.chat.target the
// sealed address of its channel (only while the channel stands), meetings.chat.queued notes a hand-over, meetings.chat.record records an outcome and DELETES the message, meetings.chat.reseal reseals an
// address after a credential key rotation. The log (crove_meetings.chat_post) holds ids, a state, the status, a code, an attempt count and hashes, never the text. No model is involved.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import {
  CHAT_CHANNELS_MAX,
  CHAT_POSTS_PER_MEETING_PER_DAY,
  buildChatMessage,
  chatMessageCanonical,
  chatMessageTooLong,
  zChatChannelList,
  zChatChannelRemove,
  zChatChannelRemoved,
  zChatChannelSave,
  zChatChannelSaved,
  zChatEmpty,
  zChatPostCommand,
  zChatPostRef,
  zChatPreview,
  zChatPosted,
  zChatRecord,
  zChatReseal,
  zChatStatus,
  zChatStatusInput,
  zChatTarget,
  zChatTargetInput,
  zMeetingRef,
  type ChatBody,
  type ChatChannelList,
  type ChatChannelSaved,
  type ChatDeliveryRow,
  type ChatMessage,
  type ChatPreview,
  type ChatPreviewChannel,
  type ChatPosted,
  type ChatStatus,
  type ChatTarget,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, sha256Hex, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { meetingFacts, publishedFacts } from './followup.ts';
import { recorderMeeting } from './results.ts';
import { openMeeting, userOf } from './transcript.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
type Trx = QueryContext['trx'];

// The message and the key of the facts it was built from. The key digests the published result (its id and time, so a result shared again or unpublished is a different key) with the title and the
// language and day the message states.
async function messageOf(trx: Trx, orgId: string, meetingId: string): Promise<{ message: ChatMessage; key: string }> {
  const published = await publishedFacts(trx, orgId, meetingId);
  const { lang, day } = await meetingFacts(trx, orgId, meetingId);
  const row = await trx.selectFrom('crove_meetings.meeting').select('title').where('org_id', '=', orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  const message = buildChatMessage({ lang, title: row.title, day, facts: published.facts });
  return { message, key: sha256Hex(JSON.stringify([published.key, message.title, message.lang, message.day])) };
}

export const chatTextHash = (message: ChatMessage): string => sha256Hex(chatMessageCanonical(message));

const staleChat = () => new DomainError('STALE_CHAT', 409, 'Biên bản của cuộc họp đã thay đổi từ lúc bạn mở hộp gửi; hãy mở lại để xem nội dung mới');
const systemOnly = (ctx: { actor: { type: string } }, what: string) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, `Only a system actor may ${what}`);
};

// One post per meeting at a time, and the day's count read under the same lock, so two clicks cannot both pass the limit or both queue. Held to the end of the transaction.
async function lockChat(ctx: { trx: Trx; orgId: string }, meetingId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.chat:${ctx.orgId}:${meetingId.toLowerCase()}`}, 0))`.execute(ctx.trx);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
export const chatChannels = defineQuery({
  name: 'meetings.chat.channels',
  input: zChatEmpty,
  access: EDITORS,
  handler: async (ctx): Promise<ChatChannelList> => {
    const rows = await ctx.trx
      .selectFrom('crove_meetings.chat_channel')
      .select(['id', 'kind', 'label', 'host', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return zChatChannelList.parse({ channels: rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, host: r.host, createdAt: r.created_at.toISOString() })) });
  },
});

// Saves a channel, or a new address for one. It receives the SEALED address (the route checked it and sealed it for the binding org, 'meeting-chat', this id); the address itself never gets here.
export const chatChannelSave = defineCommand({
  name: 'meetings.chat.channel_save',
  input: zChatChannelSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<ChatChannelSaved> => {
    const userId = userOf(ctx.actor);
    const existing = await ctx.trx.selectFrom('crove_meetings.chat_channel').select(['id', 'kind']).where('org_id', '=', ctx.orgId).where('id', '=', input.id).forUpdate().executeTakeFirst();
    if (existing && existing.kind !== input.kind) throw new DomainError('CHAT_KIND_FIXED', 409, 'Không đổi được loại kênh; hãy thêm một kênh mới');
    if (!existing) {
      const count = await ctx.trx.selectFrom('crove_meetings.chat_channel').select(sql<string>`count(*)`.as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
      if (Number(count.n) >= CHAT_CHANNELS_MAX) throw new DomainError('CHAT_CHANNELS_LIMIT', 422, `Tối đa ${CHAT_CHANNELS_MAX} kênh nhận biên bản`);
      await ctx.trx.insertInto('crove_meetings.chat_channel').values({ org_id: ctx.orgId, id: input.id, kind: input.kind, label: input.label, host: input.host, created_by: userId }).execute();
    } else {
      await ctx.trx
        .updateTable('crove_meetings.chat_channel')
        .set({ label: input.label, host: input.host, created_by: userId, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .execute();
    }
    try {
      await sql`SELECT crove_meetings.chat_target_put(${input.id}::uuid, ${input.keyId}, pg_catalog.decode(${input.envelope}, 'base64'))`.execute(ctx.trx);
    } catch (error) {
      if (error instanceof Error && /CREDENTIAL_FORBIDDEN/.test(error.message)) throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới thêm được kênh nhận biên bản');
      throw error;
    }
    // Ids and the kind: no address, no label.
    ctx.audit({ channelId: input.id, kind: input.kind, created: !existing });
    return zChatChannelSaved.parse({ id: input.id, kind: input.kind, label: input.label, host: input.host });
  },
});

// Removing a channel removes its sealed address, its queued posts (and their messages) and the log of posts to it (the rows cascade). What was already posted stays in the channel: a webhook cannot
// recall it.
export const chatChannelRemove = defineCommand({
  name: 'meetings.chat.channel_remove',
  input: zChatChannelRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const removed = await ctx.trx.deleteFrom('crove_meetings.chat_channel').where('org_id', '=', ctx.orgId).where('id', '=', input.id).returning('id').execute();
    if (removed.length === 0) throw new DomainError('CHAT_CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
    ctx.audit({ channelId: input.id });
    return zChatChannelRemoved.parse({ id: input.id });
  },
});

// ---------------------------------------------------------------------------
// The dialog and the click
// ---------------------------------------------------------------------------
interface PostRow {
  channel_id: string;
  state: string;
  created_at: Date;
}

// How the recorder's newest post of this meeting to each channel stands, and whether a repeat needs the tick: any earlier post that went or may have gone, whatever the newest one did (the
// command counts every earlier post). A queued post is `busy`; one dropped (its channel or its text no longer stood) put nothing in the channel, so it reads as failed.
function lastOf(posts: readonly PostRow[], channelId: string): { last: ChatPreviewChannel['last']; at: Date | null; needsTick: boolean } {
  const mine = posts.filter((p) => p.channel_id === channelId);
  const row = mine[0];
  const needsTick = mine.some((p) => p.state === 'sent' || p.state === 'ambiguous');
  if (!row) return { last: 'none', at: null, needsTick };
  const last = row.state === 'queued' ? 'busy' : row.state === 'dropped' ? 'failed' : (row.state as ChatPreviewChannel['last']);
  return { last, at: row.created_at, needsTick };
}

// Posts of the caller's own for this meeting, newest first (row security shows the recorder their own and nobody else's).
async function postsOf(trx: Trx, orgId: string, meetingId: string): Promise<PostRow[]> {
  return trx
    .selectFrom('crove_meetings.chat_post')
    .select(['channel_id', 'state', 'created_at'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

async function postsLast24h(trx: Trx, orgId: string, meetingId: string): Promise<number> {
  const row = await trx
    .selectFrom('crove_meetings.chat_post')
    .select(sql<string>`count(*)`.as('n'))
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('state', 'in', ['queued', 'sent', 'ambiguous'])
    .where(sql<boolean>`created_at > pg_catalog.now() - interval '24 hours'`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export const chatPreview = defineQuery({
  name: 'meetings.chat.preview',
  input: zMeetingRef,
  access: EDITORS,
  // The message is the meeting's text, so a read of it leaves an audit row naming the meeting.
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<ChatPreview> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can post its minutes');
    const { message, key } = await messageOf(ctx.trx, ctx.orgId, input.meetingId);
    const channels = await ctx.trx.selectFrom('crove_meetings.chat_channel').select(['id', 'kind', 'label', 'host']).where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').execute();
    const posts = await postsOf(ctx.trx, ctx.orgId, input.meetingId);
    return zChatPreview.parse({
      meetingId: input.meetingId,
      factsKey: key,
      message,
      tooLong: chatMessageTooLong(message),
      // The route puts the address in (it holds the app's URL); the module has none.
      link: null,
      channels: channels.map((c): ChatPreviewChannel => {
        const { last, at, needsTick } = lastOf(posts, c.id);
        return { id: c.id, kind: c.kind, label: c.label, host: c.host, last, lastAt: at ? at.toISOString() : null, needsTick };
      }),
      postsLeft: Math.max(0, CHAT_POSTS_PER_MEETING_PER_DAY - (await postsLast24h(ctx.trx, ctx.orgId, input.meetingId))),
    });
  },
});

// The click. The route has the key of what the recorder read; this rebuilds the message from the published result itself and agrees only to the same version. The post and its message are stored in this
// transaction; the worker's job sends them.
export const chatPost = defineCommand({
  name: 'meetings.chat.post',
  input: zChatPostCommand,
  // It queues a message to a channel outside Ludy: an effect outside it (R2), always from the recorder's own click.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input): Promise<ChatPosted> => {
    const { userId } = await recorderMeeting(ctx, input.meetingId, 'post its minutes');
    await lockChat(ctx, input.meetingId);
    const { message, key } = await messageOf(ctx.trx, ctx.orgId, input.meetingId);
    if (key !== input.factsKey) throw staleChat();
    if (chatMessageTooLong(message)) throw new DomainError('CHAT_MESSAGE_TOO_LONG', 422, 'Biên bản quá dài để gửi vào kênh; hãy rút gọn tóm tắt rồi chia sẻ lại');
    const channel = await ctx.trx.selectFrom('crove_meetings.chat_channel').select(['kind', 'created_by']).where('org_id', '=', ctx.orgId).where('id', '=', input.channelId).executeTakeFirst();
    if (!channel) throw new DomainError('CHAT_CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
    // The address belongs to the member who saved it: while they are not an owner or admin any more, nothing is posted to it (the database checks again, and also that they are not disabled).
    const saver = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', channel.created_by).executeTakeFirst();
    if (!saver || (saver.role !== 'owner' && saver.role !== 'admin')) {
      throw new DomainError('CHAT_CHANNEL_OWNER_LEFT', 409, 'Người đã thêm kênh này không còn là chủ sở hữu hoặc quản trị viên; hãy nhờ chủ sở hữu hoặc quản trị viên dán lại địa chỉ');
    }
    if ((await postsLast24h(ctx.trx, ctx.orgId, input.meetingId)) >= CHAT_POSTS_PER_MEETING_PER_DAY) {
      throw new DomainError('CHAT_LIMIT', 429, `Cuộc họp này đã gửi biên bản ${CHAT_POSTS_PER_MEETING_PER_DAY} lần trong 24 giờ qua; hãy thử lại sau`);
    }
    const posts = (await postsOf(ctx.trx, ctx.orgId, input.meetingId)).filter((p) => p.channel_id === input.channelId);
    if (posts.some((p) => p.state === 'queued')) throw new DomainError('CHAT_POST_BUSY', 409, 'Biên bản đang chờ được gửi vào kênh này; hãy đợi một chút');
    // A post that went, or may have gone (sent, ambiguous), needs the recorder's tick to be repeated; one that failed or was dropped put nothing in the channel.
    const reachedChannel = posts.filter((p) => p.state === 'sent' || p.state === 'ambiguous');
    if (reachedChannel.length > 0 && !input.confirmRepeat) {
      throw new DomainError('CHAT_ALREADY_POSTED', 409, 'Biên bản này đã được gửi (hoặc có thể đã được gửi) vào kênh này; gửi lại cần xác nhận', { audit: { repeats: reachedChannel.length } });
    }
    const inserted = await ctx.trx
      .insertInto('crove_meetings.chat_post')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, channel_id: input.channelId, user_id: userId, facts_key: key, text_hash: chatTextHash(message) })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The message, kept only while the post is queued (the database deletes it when the post settles). The database refuses a body that does not fit, and a channel that no longer stands.
    const body: ChatBody = { ...message, link: input.link };
    try {
      await sql`SELECT crove_meetings.chat_post_enqueue(${inserted.id}::uuid, ${JSON.stringify(body)}::jsonb)`.execute(ctx.trx);
    } catch (error) {
      if (error instanceof Error && /CHAT_POST_NOT_FOUND/.test(error.message)) throw new DomainError('CHAT_CHANNEL_OWNER_LEFT', 409, 'Người đã thêm kênh này không còn là chủ sở hữu hoặc quản trị viên; hãy nhờ chủ sở hữu hoặc quản trị viên dán lại địa chỉ');
      throw error;
    }
    // Ids and counts: no word of the message, no address.
    ctx.audit({ meetingId: input.meetingId, channelId: input.channelId, postId: inserted.id, kind: channel.kind, repeated: reachedChannel.length });
    return zChatPosted.parse({ postId: inserted.id, state: 'queued' });
  },
});

// How the recorder's newest post of this meeting to a channel stands (a state and a fixed code), for the dialog to poll after the click. Not sensitive: no text.
export const chatStatus = defineQuery({
  name: 'meetings.chat.status',
  input: zChatStatusInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<ChatStatus> => {
    userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('crove_meetings.chat_post')
      .select(['state', 'code', 'http_status', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('channel_id', '=', input.channelId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return zChatStatus.parse(row ? { state: row.state, code: row.code, httpStatus: row.http_status, at: row.created_at.toISOString() } : { state: 'none', code: null, httpStatus: null, at: null });
  },
});

// ---------------------------------------------------------------------------
// The worker's side (the system actor)
// ---------------------------------------------------------------------------
// A queued post for the job that sends it: the kind of its channel, its state and its message. The owner's exception of 2026-11-15 names the function behind this (chat_post_get).
export const chatDelivery = defineQuery({
  name: 'meetings.chat.delivery',
  input: zChatPostRef,
  access: 'system',
  handler: async (ctx, input): Promise<ChatDeliveryRow | null> => {
    systemOnly(ctx, 'read a queued post');
    const { rows } = await sql<{ id: string; channel_id: string; kind: ChatDeliveryRow['kind']; status: ChatDeliveryRow['status']; body: ChatBody | null; attempts: number }>`
      SELECT id, channel_id, kind, status, body, attempts FROM crove_meetings.chat_post_get(${ctx.orgId}::uuid, ${input.id}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? { id: r.id, channelId: r.channel_id, kind: r.kind, status: r.status, body: r.body, attempts: r.attempts } : null;
  },
});

// The sealed address of a channel (key id and sealed bytes), only while the channel stands; null otherwise. For the delivery job and the key rotation pass.
export const chatTarget = defineQuery({
  name: 'meetings.chat.target',
  input: zChatTargetInput,
  access: 'system',
  handler: async (ctx, input): Promise<ChatTarget | null> => {
    systemOnly(ctx, 'read the address of a channel');
    const { rows } = await sql<{ key_id: string; envelope: Buffer }>`SELECT key_id, envelope FROM crove_meetings.chat_target_get(${input.channelId}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? zChatTarget.parse({ keyId: r.key_id, envelope: Buffer.from(r.envelope).toString('base64') }) : null;
  },
});

// Notes that a queued post was handed to the queue now.
export const chatQueued = defineCommand({
  name: 'meetings.chat.queued',
  input: zChatPostRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    systemOnly(ctx, 'note a hand-over');
    const { rows } = await sql<{ ok: boolean }>`SELECT crove_meetings.chat_touch(${input.id}::uuid) AS ok`.execute(ctx.trx);
    return { id: input.id, queued: rows[0]?.ok === true };
  },
});

// The outcome of one attempt: sent, failed or ambiguous settle the post (and delete its message); retry keeps it for the queue's next try; dropped and expired end a post that can no longer be sent.
export const chatRecord = defineCommand({
  name: 'meetings.chat.record',
  input: zChatRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    systemOnly(ctx, 'record the outcome of a post');
    const { rows } = await sql<{ ok: boolean }>`SELECT crove_meetings.chat_record(${input.id}::uuid, ${input.outcome}, ${input.httpStatus}::int, ${input.code}) AS ok`.execute(ctx.trx);
    // Ids, the outcome and a fixed code: no address, no word of the message.
    ctx.audit({ postId: input.id, outcome: input.outcome, status: input.httpStatus, code: input.code });
    return { id: input.id, recorded: rows[0]?.ok === true };
  },
});

// Stores a resealed address after a credential key rotation, only if the stored envelope is still the one the worker read.
export const chatReseal = defineCommand({
  name: 'meetings.chat.reseal',
  input: zChatReseal,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    systemOnly(ctx, 'reseal the address of a channel');
    const { rows } = await sql<{ ok: boolean }>`
      SELECT crove_meetings.chat_target_reseal(${input.channelId}::uuid, ${input.fromKeyId}, ${input.fromSha256}, ${input.keyId}, pg_catalog.decode(${input.envelope}, 'base64')) AS ok`.execute(ctx.trx);
    ctx.audit({ channelId: input.channelId, keyId: input.keyId });
    return { channelId: input.channelId, resealed: rows[0]?.ok === true };
  },
});

export const chatQueries = [chatChannels, chatPreview, chatStatus, chatDelivery, chatTarget];
export const chatCommands = [chatChannelSave, chatChannelRemove, chatPost, chatQueued, chatRecord, chatReseal];
