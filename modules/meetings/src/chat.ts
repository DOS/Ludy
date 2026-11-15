// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168, plan docs/plan/meetings-integrations.md section 5.2). The org's channels are rows an owner or admin saves (the
// webhook address itself is sealed by the API route and kept in a definer-only table; nothing here reads it back as text). The recorder of a meeting with a published result reads the exact message,
// picks a channel and presses "Gửi":
//   meetings.chat.preview   (the recorder; sensitive: it reads the published text) the message as it would go, the key of the facts it was built from, the channels and where this recorder's earlier posts of this
//                           meeting ended.
//   meetings.chat.begin     (the recorder; R2, it is the click that sends) rebuilds the message from the PUBLISHED result at this moment, refuses it when the recorder read another version (STALE_CHAT),
//                           checks the tick for a repeat and the day's limit, and writes the post `started` in its own committed transaction BEFORE any call leaves. Returns ids, never text.
//   meetings.chat.target    (the recorder, for the API process) the sealed address of the channel of the recorder's own `started` post, as key id and sealed bytes. The route opens it with the credential
//                           broker and posts once through the egress guard; the address never reaches a command, a query answer sent to the browser, an audit row or a log.
//   meetings.chat.settle    (the recorder) records how the call ended: sent, failed or ambiguous, with the HTTP status and a fixed code. An unsettled post older than two minutes is read as ambiguous.
// The log (crove_meetings.chat_post) holds ids, a state, the status, a code and hashes of the facts and the message, never the text. No model is involved; nothing is sent without the recorder's own
// begin command, and a person runs it.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import {
  CHAT_BUSY_SECONDS,
  CHAT_CHANNELS_MAX,
  CHAT_POSTS_PER_MEETING_PER_DAY,
  buildChatMessage,
  chatMessageCanonical,
  chatMessageTooLong,
  zChatBegin,
  zChatBegun,
  zChatChannelList,
  zChatEmpty,
  zChatChannelRemove,
  zChatChannelRemoved,
  zChatChannelSave,
  zChatChannelSaved,
  zChatPreview,
  zChatSettle,
  zChatSettled,
  zChatTarget,
  zChatTargetInput,
  zMeetingRef,
  type ChatBegun,
  type ChatChannelList,
  type ChatChannelSaved,
  type ChatMessage,
  type ChatPreview,
  type ChatPreviewChannel,
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

// One post per meeting at a time, and the day's count read under the same lock, so two clicks cannot both pass the limit or both send. Held to the end of the transaction.
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

// Removing a channel removes its sealed address and the log of posts to it (the rows cascade). What was already posted stays in the channel: a webhook cannot recall it.
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

// How the recorder's last post of this meeting to each channel ended. A row `started` and older than the busy window is read as ambiguous: the request that made it died before it recorded an outcome.
function lastOf(posts: readonly PostRow[], channelId: string, now: number): { last: ChatPreviewChannel['last']; at: Date | null; needsTick: boolean } {
  const mine = posts.filter((p) => p.channel_id === channelId);
  const row = mine[0];
  // The tick looks at every earlier post, as meetings.chat.begin does: one that went, may have gone, or never recorded its outcome, whatever the newest one did.
  const needsTick = mine.some((p) => p.state === 'sent' || p.state === 'ambiguous' || p.state === 'started');
  if (!row) return { last: 'none', at: null, needsTick };
  if (row.state === 'started') return { last: now - row.created_at.getTime() < CHAT_BUSY_SECONDS * 1000 ? 'busy' : 'ambiguous', at: row.created_at, needsTick };
  return { last: row.state as ChatPreviewChannel['last'], at: row.created_at, needsTick };
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
    .where('state', 'in', ['started', 'sent', 'ambiguous'])
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
    const now = Date.now();
    return zChatPreview.parse({
      meetingId: input.meetingId,
      factsKey: key,
      message,
      tooLong: chatMessageTooLong(message),
      // The route puts the address in (it holds the app's URL); the module has none.
      link: null,
      channels: channels.map((c): ChatPreviewChannel => {
        const { last, at, needsTick } = lastOf(posts, c.id, now);
        return { id: c.id, kind: c.kind, label: c.label, host: c.host, last, lastAt: at ? at.toISOString() : null, needsTick };
      }),
      postsLeft: Math.max(0, CHAT_POSTS_PER_MEETING_PER_DAY - (await postsLast24h(ctx.trx, ctx.orgId, input.meetingId))),
    });
  },
});

// The click, before anything leaves. The route has built the message it is about to send and hashed it; this rebuilds the message from the published result itself and agrees only if it is the same one.
export const chatBegin = defineCommand({
  name: 'meetings.chat.begin',
  input: zChatBegin,
  // It stands behind a message to a channel outside Ludy: an effect outside it (R2), always from the recorder's own click.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input): Promise<ChatBegun> => {
    const { userId } = await recorderMeeting(ctx, input.meetingId, 'post its minutes');
    await lockChat(ctx, input.meetingId);
    const { message, key } = await messageOf(ctx.trx, ctx.orgId, input.meetingId);
    if (key !== input.factsKey || chatTextHash(message) !== input.textHash) throw staleChat();
    if (chatMessageTooLong(message)) throw new DomainError('CHAT_MESSAGE_TOO_LONG', 422, 'Biên bản quá dài để gửi vào kênh; hãy rút gọn tóm tắt rồi chia sẻ lại');
    const channel = await ctx.trx.selectFrom('crove_meetings.chat_channel').select(['kind', 'host', 'created_by']).where('org_id', '=', ctx.orgId).where('id', '=', input.channelId).executeTakeFirst();
    if (!channel) throw new DomainError('CHAT_CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
    // The address belongs to the member who saved it: while they are not an owner or admin any more, nothing is posted to it (chat_target_for_post checks again, and also that they are not disabled).
    const saver = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', channel.created_by).executeTakeFirst();
    if (!saver || (saver.role !== 'owner' && saver.role !== 'admin')) {
      throw new DomainError('CHAT_CHANNEL_OWNER_LEFT', 409, 'Người đã thêm kênh này không còn là chủ sở hữu hoặc quản trị viên; hãy nhờ chủ sở hữu hoặc quản trị viên dán lại địa chỉ');
    }
    if ((await postsLast24h(ctx.trx, ctx.orgId, input.meetingId)) >= CHAT_POSTS_PER_MEETING_PER_DAY) {
      throw new DomainError('CHAT_LIMIT', 429, `Cuộc họp này đã gửi biên bản ${CHAT_POSTS_PER_MEETING_PER_DAY} lần trong 24 giờ qua; hãy thử lại sau`);
    }
    const posts = (await postsOf(ctx.trx, ctx.orgId, input.meetingId)).filter((p) => p.channel_id === input.channelId);
    const now = Date.now();
    const busy = posts.some((p) => p.state === 'started' && now - p.created_at.getTime() < CHAT_BUSY_SECONDS * 1000);
    if (busy) throw new DomainError('CHAT_POST_BUSY', 409, 'Biên bản đang được gửi vào kênh này; hãy đợi một chút');
    // A post that went, or may have gone (sent, ambiguous, or one whose request died before it recorded an outcome), needs the recorder's tick to be repeated; one that failed put nothing in the channel.
    const reachedChannel = posts.filter((p) => p.state === 'sent' || p.state === 'ambiguous' || p.state === 'started');
    if (reachedChannel.length > 0 && !input.confirmRepeat) {
      throw new DomainError('CHAT_ALREADY_POSTED', 409, 'Biên bản này đã được gửi (hoặc có thể đã được gửi) vào kênh này; gửi lại cần xác nhận', { audit: { repeats: reachedChannel.length } });
    }
    const inserted = await ctx.trx
      .insertInto('crove_meetings.chat_post')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, channel_id: input.channelId, user_id: userId, facts_key: key, text_hash: input.textHash })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Ids and counts: no word of the message, no address.
    ctx.audit({ meetingId: input.meetingId, channelId: input.channelId, postId: inserted.id, kind: channel.kind, repeated: reachedChannel.length });
    return zChatBegun.parse({ postId: inserted.id, kind: channel.kind, host: channel.host });
  },
});

// The sealed address for the recorder's own post in flight: the key id and the sealed bytes (base64), for the API route to open with the credential broker. The definer answers only the API process, only
// for a `started` post of this caller made under two minutes ago on a meeting they record.
export const chatTarget = defineQuery({
  name: 'meetings.chat.target',
  input: zChatTargetInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<ChatTarget> => {
    try {
      const { rows } = await sql<{ key_id: string; envelope: Buffer }>`SELECT key_id, envelope FROM crove_meetings.chat_target_for_post(${input.postId}::uuid)`.execute(ctx.trx);
      const row = rows[0];
      if (!row) throw new DomainError('CHAT_POST_NOT_OPEN', 409, 'Lần gửi này đã hết hạn; hãy bấm Gửi lại');
      return zChatTarget.parse({ keyId: row.key_id, envelope: Buffer.from(row.envelope).toString('base64') });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && /CHAT_POST_NOT_OPEN/.test(error.message)) throw new DomainError('CHAT_POST_NOT_OPEN', 409, 'Lần gửi này đã hết hạn; hãy bấm Gửi lại');
      throw error;
    }
  },
});

export const chatSettle = defineCommand({
  name: 'meetings.chat.settle',
  input: zChatSettle,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const updated = await ctx.trx
      .updateTable('crove_meetings.chat_post')
      .set({ state: input.state, http_status: input.httpStatus, code: input.code, settled_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .where('state', '=', 'started')
      .returning('id')
      .execute();
    // A post already settled (a retry of this call) or not the caller's (row security shows none) is left as it is.
    ctx.audit({ postId: input.postId, state: input.state, status: input.httpStatus, code: input.code, changed: updated.length });
    return zChatSettled.parse({ postId: input.postId, state: input.state });
  },
});

export const chatQueries = [chatChannels, chatPreview, chatTarget];
export const chatCommands = [chatChannelSave, chatChannelRemove, chatBegin, chatSettle];
