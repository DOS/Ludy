// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168, plan docs/plan/meetings-integrations.md section 5.2). An owner or admin pastes the address of a Slack Incoming
// Webhook or of a Teams Workflows webhook; the recorder of a meeting with a published result reads the exact message, picks a channel and presses "Gửi". The post is made in the recorder's own
// click: the module builds the message from the published result and stores the click (chat_post, hashes and a state) with the message in a body row that is deleted when the post settles; the
// API route seals the address and never opens it (ADR-0025); a worker job (kernel-meeting-chat) opens the sealed address with the credential broker and posts once through the egress guard. No model.
//
// The message is one structured value (ChatMessage) built by code from the published facts; the app renders it for the recorder to read, the route renders it for Slack or Teams, and the post
// log keeps a hash of it. What the channel's readers get is what the recorder read: the title, the date, the summary, the decisions and the action items (title, owner as said, date), and a link
// back that only readers of the meeting can open. Never the transcript, the audio, the video or an attendee's contact details.
import { z } from 'zod';
import { followupClean } from './meeting-followup.ts';
import { ITEM_TITLE_MAX, ITEMS_PER_MEETING_MAX, RESULT_DECISION_MAX, RESULT_DECISIONS_MAX, RESULT_SUMMARY_MAX, zMeetingLanguage } from './meetings.ts';
import { zId } from './schemas.ts';

export const MEETING_CHAT_KINDS = ['slack', 'teams'] as const;
export type MeetingChatKind = (typeof MEETING_CHAT_KINDS)[number];
export const zMeetingChatKind = z.enum(MEETING_CHAT_KINDS);

// The binding the credential broker seals a channel's address for: (org, this provider, the channel's id).
export const MEETING_CHAT_PROVIDER = 'meeting-chat';
export const CHAT_LABEL_MAX = 200;
// The pasted address, as the browser sends it (a Teams Workflows address carries a long signature).
export const CHAT_URL_MAX = 1200;
export const CHAT_CHANNELS_MAX = 20;
// Posts a recorder makes of one meeting in a rolling 24 hours, whatever the channel (a repeat to the same channel also needs the recorder's tick).
export const CHAT_POSTS_PER_MEETING_PER_DAY = 6;
// The rendered text of a message, in characters. Slack takes more and Teams about 28 KB of card; this stays well under both [unverified, see the runbook] so a long summary is refused before any call.
export const CHAT_MESSAGE_MAX_CHARS = 12_000;
const CHAT_WHO_MAX = 200;
const CHAT_WHEN_MAX = 100;

export const zChatMessage = z.strictObject({
  v: z.literal(1),
  lang: zMeetingLanguage,
  title: z.string().min(1).max(200),
  // The meeting's day in Vietnam time, yyyy-mm-dd.
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string().max(RESULT_SUMMARY_MAX),
  decisions: z.array(z.string().min(1).max(RESULT_DECISION_MAX)).max(RESULT_DECISIONS_MAX),
  items: z
    .array(z.strictObject({ title: z.string().min(1).max(ITEM_TITLE_MAX), who: z.string().max(CHAT_WHO_MAX), when: z.string().max(CHAT_WHEN_MAX) }))
    .max(ITEMS_PER_MEETING_MAX),
});
export type ChatMessage = z.infer<typeof zChatMessage>;

export interface ChatFacts {
  summary: string;
  decisions: readonly string[];
  items: ReadonlyArray<{ title: string; who: string; when: string }>;
}

const cut = (text: string, max: number) => Array.from(text).slice(0, max).join('');

// The message of a meeting's published facts, in the form the server stores and sends: Unicode NFKC, no format or control characters (followupClean), cut to the limits above. The same call in the module
// (to hash it) and in the app (to show it) gives the same value, so what the recorder reads is what is hashed and sent.
export function buildChatMessage(input: { lang: 'vi' | 'en'; title: string; day: string; facts: ChatFacts }): ChatMessage {
  return {
    v: 1,
    lang: input.lang,
    title: cut(followupClean(input.title, true), 200) || '-',
    day: input.day,
    summary: cut(followupClean(input.facts.summary, false), RESULT_SUMMARY_MAX),
    decisions: input.facts.decisions.map((d) => cut(followupClean(d, true), RESULT_DECISION_MAX)).filter((d) => d !== '').slice(0, RESULT_DECISIONS_MAX),
    items: input.facts.items
      .map((i) => ({ title: cut(followupClean(i.title, true), ITEM_TITLE_MAX), who: cut(followupClean(i.who, true), CHAT_WHO_MAX), when: cut(followupClean(i.when, true), CHAT_WHEN_MAX) }))
      .filter((i) => i.title !== '')
      .slice(0, ITEMS_PER_MEETING_MAX),
  };
}

const LABELS = {
  vi: { summary: 'Tóm tắt', decisions: 'Quyết định', items: 'Việc cần làm', link: 'Xem cuộc họp' },
  en: { summary: 'Summary', decisions: 'Decisions', items: 'Action items', link: 'Open the meeting' },
} as const;

export function chatMessageLabels(lang: 'vi' | 'en') {
  return LABELS[lang];
}

// The day as people write it in Vietnam and in English texts.
function dayText(lang: 'vi' | 'en', day: string): string {
  return lang === 'vi' ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day;
}

export function chatItemLine(item: ChatMessage['items'][number]): string {
  const tail = [item.who, item.when].filter((s) => s !== '').join(', ');
  return tail === '' ? item.title : `${item.title} (${tail})`;
}

// The plain text of the message, as the recorder reads it in the dialog. The link is the address a reader opens; it is not part of the hashed message.
export function chatMessageText(message: ChatMessage, link: string | null): string {
  const l = LABELS[message.lang];
  const parts: string[] = [`${message.title}`, dayText(message.lang, message.day)];
  if (message.summary !== '') parts.push('', l.summary, message.summary);
  if (message.decisions.length > 0) parts.push('', l.decisions, ...message.decisions.map((d) => `• ${d}`));
  if (message.items.length > 0) parts.push('', l.items, ...message.items.map((i) => `• ${chatItemLine(i)}`));
  if (link) parts.push('', `${l.link}: ${link}`);
  return parts.join('\n');
}

/** Whether the rendered message is too long to post (CHAT_MESSAGE_MAX_CHARS, link included as 300 characters). */
export function chatMessageTooLong(message: ChatMessage): boolean {
  return Array.from(chatMessageText(message, 'x'.repeat(300))).length > CHAT_MESSAGE_MAX_CHARS;
}

// The bytes the hash is taken over: the message's keys in a fixed order, so the module and a test agree whatever the order of the object they hold.
export function chatMessageCanonical(message: ChatMessage): string {
  return JSON.stringify([message.v, message.lang, message.title, message.day, message.summary, message.decisions, message.items.map((i) => [i.title, i.who, i.when])]);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
// What the browser sends to add a channel (or to paste a new address into an existing one): the address is checked and sealed by the API route, which hands the command only the envelope.
export const zChatChannelSaveCall = z.strictObject({
  id: zId.optional(),
  kind: zMeetingChatKind,
  label: z.string().trim().min(1).max(CHAT_LABEL_MAX),
  url: z.string().trim().min(1).max(CHAT_URL_MAX),
});
export type ChatChannelSaveCall = z.infer<typeof zChatChannelSaveCall>;

// What the command receives: the sealed address ({keyId, envelope as base64}), never the address.
export const zChatChannelSave = z.strictObject({
  id: zId,
  kind: zMeetingChatKind,
  label: z.string().trim().min(1).max(CHAT_LABEL_MAX),
  host: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/),
  keyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  envelope: z.string().min(1).max(8192),
});
export type ChatChannelSave = z.infer<typeof zChatChannelSave>;

export const zChatChannelRemove = z.strictObject({ id: zId });
export const zChatChannelRef = z.strictObject({ id: zId });

export const zChatChannel = z.strictObject({
  id: zId,
  kind: zMeetingChatKind,
  label: z.string(),
  // The address's host, for the screen ("hooks.slack.com"); the rest of the address is never shown again.
  host: z.string(),
  createdAt: z.string(),
});
export type ChatChannel = z.infer<typeof zChatChannel>;
export const zChatChannelList = z.strictObject({ channels: z.array(zChatChannel) });
export type ChatChannelList = z.infer<typeof zChatChannelList>;
export const zChatChannelSaved = z.strictObject({ id: zId, kind: zMeetingChatKind, label: z.string(), host: z.string() });
export type ChatChannelSaved = z.infer<typeof zChatChannelSaved>;
export const zChatChannelRemoved = z.strictObject({ id: zId });

// ---------------------------------------------------------------------------
// The dialog and the click
// ---------------------------------------------------------------------------

export const zChatPreviewChannel = z.strictObject({
  id: zId,
  kind: zMeetingChatKind,
  label: z.string(),
  host: z.string(),
  // How this recorder's last post of this meeting to this channel stands: none, sent, ambiguous (maybe in the channel: a repeat needs the tick), failed (nothing went out; a dropped post is one), busy (one is queued).
  last: z.enum(['none', 'sent', 'ambiguous', 'failed', 'busy']),
  lastAt: z.string().nullable(),
  // Whether a post to this channel needs the recorder's tick: an earlier post of this meeting went, may have gone, or never recorded its outcome (whatever the newest one did).
  needsTick: z.boolean(),
});
export type ChatPreviewChannel = z.infer<typeof zChatPreviewChannel>;

// The recorder's read of the exact message: the facts' key (the post is refused when the published result changed since), the structured message, the channels and the posts left today.
export const zChatPreview = z.strictObject({
  meetingId: zId,
  factsKey: z.string().regex(/^[0-9a-f]{64}$/),
  message: zChatMessage,
  tooLong: z.boolean(),
  // The address the post carries back to the meeting, as the server will write it (the API's APP_URL or PUBLIC_URL); null when the server cannot make one. The dialog shows exactly this.
  link: z.string().nullable(),
  channels: z.array(zChatPreviewChannel),
  postsLeft: z.number().int().min(0),
});
export type ChatPreview = z.infer<typeof zChatPreview>;

// What the browser sends on "Gửi": the key of what the recorder read and the tick for a repeat.
export const zChatPostCall = z.strictObject({
  meetingId: zId,
  channelId: zId,
  factsKey: z.string().regex(/^[0-9a-f]{64}$/),
  confirmRepeat: z.boolean().default(false),
});
export type ChatPostCall = z.infer<typeof zChatPostCall>;

// The command behind the click: the recorder's own (R2, it sends). The route adds the link back, which only it knows (the app's address); the command rebuilds the message from the PUBLISHED result
// itself, refuses it when the recorder read another version (STALE_CHAT), and queues it: the post leaves by the worker's job, not in this request.
export const zChatPostCommand = z.strictObject({
  meetingId: zId,
  channelId: zId,
  factsKey: z.string().regex(/^[0-9a-f]{64}$/),
  confirmRepeat: z.boolean(),
  link: z
    .string()
    .max(500)
    .regex(/^https:\/\/\S+$/)
    .nullable(),
});
// The answer to the click: the post is queued, the worker's job sends it.
export const zChatPosted = z.strictObject({ postId: zId, state: z.literal('queued') });
export type ChatPosted = z.infer<typeof zChatPosted>;

// What the body of a queued post is: the message and the link back (the database's chat_body_ok checks the same shape).
export const zChatBody = zChatMessage.extend({
  link: z
    .string()
    .max(500)
    .regex(/^https:\/\/\S+$/)
    .nullable(),
});
export type ChatBody = z.infer<typeof zChatBody>;

// How the recorder's newest post of a meeting to a channel stands: polled by the dialog after the click until it is no longer queued.
export const CHAT_POST_STATES = ['queued', 'sent', 'failed', 'ambiguous', 'dropped'] as const;
export const zChatStatusInput = z.strictObject({ meetingId: zId, channelId: zId });
export const zChatStatus = z.strictObject({
  state: z.enum(['none', ...CHAT_POST_STATES]),
  // A fixed code of the adapter or the worker (CHANNEL_GONE, POST_EXPIRED ...), never the service's words.
  code: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  at: z.string().nullable(),
});
export type ChatStatus = z.infer<typeof zChatStatus>;

// The worker's side: the system actor of an org reads a queued post and the sealed address of its channel, hands posts to the queue and records outcomes. Ids, states and codes only, except the
// post's body and the sealed bytes.
export const zChatPostRef = z.strictObject({ id: zId });
export const zChatTargetInput = z.strictObject({ channelId: zId });
export const zChatTarget = z.strictObject({ keyId: z.string(), envelope: z.string() });
export type ChatTarget = z.infer<typeof zChatTarget>;
export const CHAT_RECORD_OUTCOMES = ['begin', 'sent', 'retry', 'failed', 'ambiguous', 'dropped', 'expired'] as const;
export type ChatRecordOutcome = (typeof CHAT_RECORD_OUTCOMES)[number];
export const zChatRecord = z.strictObject({
  id: zId,
  outcome: z.enum(CHAT_RECORD_OUTCOMES),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  code: z
    .string()
    .regex(/^[A-Z0-9_]{1,64}$/)
    .nullable(),
});
export const zChatReseal = z.strictObject({
  channelId: zId,
  fromKeyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  fromSha256: z.string().regex(/^[0-9a-f]{64}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  envelope: z.string().min(1).max(8192),
});
// One queued post as the delivery job reads it (chat_post_get).
export interface ChatDeliveryRow {
  id: string;
  channelId: string;
  kind: MeetingChatKind;
  status: 'queued' | 'sent' | 'failed' | 'ambiguous' | 'dropped';
  body: ChatBody | null;
  attempts: number;
}

export const zChatEmpty = z.strictObject({});
