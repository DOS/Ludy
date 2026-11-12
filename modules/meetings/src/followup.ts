// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, issue #2590, plan docs/plan/meetings.md section 11 and 15, ADR-0047). The recorder of a meeting with a published summary opens a
// draft, edits the words around the facts and the recipients, and sends it:
// - meetings.followup.draft (the recorder): the facts as the published result holds them, the fixed words in the meeting's language, the suggested recipients (the meeting's
//   readers that are members and the contacts linked to it, each with an email address) and the sends left today. Nothing is stored: the dialog holds the draft until the
//   recorder sends it. Vy's own words for the lead-in and the closing are asked apart (meetings.followup.wording in apps/kernel), as a read, so the draft works with AI off.
// - meetings.followup.send (the recorder; R2, it sends mail): queues one mail per address through the kernel's mail queue, audited. Nothing is sent without this command,
//   and a person runs it.
// The facts (summary, decisions, action items) are rebuilt here from the PUBLISHED result at the moment of the send, so only what the readers of the meeting read goes into a
// mail; the caller supplies the words around them and the key of the facts they reviewed, and the send is refused (STALE_FOLLOWUP) when the result was unpublished or
// published again since. The audit names counts and ids, never an address or a word.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import {
  FOLLOWUP_CLOSING_MAX,
  FOLLOWUP_GREETING_MAX,
  FOLLOWUP_LEAD_MAX,
  FOLLOWUP_MAIL_SOURCE,
  FOLLOWUP_MAIL_TEMPLATE,
  FOLLOWUP_RECIPIENTS_MAX,
  FOLLOWUP_SENDS_PER_MEETING_PER_DAY,
  followupAddress,
  followupClean,
  followupSubjectProblem,
  followupWordsProblem,
  zFollowupDraft,
  zFollowupMail,
  zFollowupSend,
  zMeetingRef,
  type FollowupFacts,
  type FollowupDraft,
  type FollowupMail,
  type FollowupRecipient,
  type FollowupSent,
  type FollowupTextProblem,
  type FollowupWords,
} from '@crove/kernel-contract';
import { createMailMessage, mailAddressHash } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, sha256Hex, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { recorderMeeting } from './results.ts';
import { vnDay } from './retention.ts';
import { openMeeting, userOf } from './transcript.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// A mail in these states went (or is going) to the person; a suppressed or failed one did not.
const SENT_STATES = ['queued', 'sending', 'sent', 'delivered', 'ambiguous'] as const;
// The mail table keeps a payload of at most 64 KB; one under this goes in whole.
const PAYLOAD_MAX_BYTES = 60_000;

type Lang = 'vi' | 'en';
type Trx = QueryContext['trx'];

// The fixed words, the same whatever model is on: what a draft holds with AI off and what a person starts from.
const WORDS: Record<Lang, { subject: (day: string) => string; greeting: string; lead: string; closing: string }> = {
  vi: {
    subject: (day) => `Tóm tắt cuộc họp ${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`,
    greeting: 'Xin chào,',
    lead: 'Cảm ơn bạn đã dành thời gian cho cuộc họp. Dưới đây là tóm tắt, các quyết định và việc cần làm sau cuộc họp.',
    closing: 'Nếu có điều gì chưa đúng, bạn hãy báo lại để mình chỉnh. Cảm ơn bạn.',
  },
  en: {
    subject: (day) => `Meeting summary, ${day}`,
    greeting: 'Hello,',
    lead: 'Thank you for your time in the meeting. Below are the summary, the decisions and the action items from it.',
    closing: 'If anything looks wrong, please let me know. Thank you.',
  },
};

export function followupFixedWords(lang: Lang, day: string): FollowupWords {
  const w = WORDS[lang];
  return { subject: w.subject(day), greeting: w.greeting, lead: w.lead, closing: w.closing };
}

const noSummary = () => new DomainError('NO_PUBLISHED_SUMMARY', 409, 'Chia sẻ tóm tắt của cuộc họp trước khi soạn thư cảm ơn');

interface Published {
  facts: FollowupFacts;
  key: string;
}

// The facts of the mail, from what the readers of the meeting read: the published summary, its decisions and the published action items. The key digests them with the
// published result's id and time, so a result shared again (a new row) or unpublished is a different key.
async function publishedFacts(trx: Trx, orgId: string, meetingId: string): Promise<Published> {
  const result = await trx
    .selectFrom('crove_meetings.meeting_result')
    .select(['id', 'summary', 'decisions', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .executeTakeFirst();
  const items = await trx
    .selectFrom('crove_meetings.action_item')
    .select(['id', 'title', 'who_drafted', 'when_drafted'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .orderBy('transcript_seconds')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (!result && items.length === 0) throw noSummary();
  const facts: FollowupFacts = {
    summary: result?.summary ?? '',
    decisions: Array.isArray(result?.decisions) ? (result.decisions as unknown[]).filter((d): d is string => typeof d === 'string') : [],
    items: items.map((i) => ({ title: i.title, who: i.who_drafted ?? '', when: i.when_drafted ?? '' })),
  };
  const stamp = result ? `${result.id}:${new Date(result.updated_at).toISOString()}` : 'items-only';
  return { facts, key: sha256Hex(JSON.stringify([stamp, facts, items.map((i) => i.id)])) };
}

async function memberProfiles(trx: Trx, userIds: readonly string[]): Promise<Array<{ userId: string; email: string; name: string }>> {
  if (userIds.length === 0) return [];
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${userIds}::uuid[])`.execute(trx);
  return rows.map((p) => ({ userId: p.user_id, email: p.email, name: p.display_name ?? p.email.split('@')[0] ?? '' }));
}

interface Candidate {
  kind: 'attendee' | 'party';
  id: string;
  name: string;
  email: string;
}

// The people the draft suggests, and the addresses the mail may go to without a tick: the readers of the meeting that are members, then the contacts linked to it (L1). The
// recorder is the sender, so they are not suggested. A contact is read under the caller's own policies.
async function candidates(trx: Trx, orgId: string, meetingId: string, recorder: string): Promise<Candidate[]> {
  const readers = await trx.selectFrom('crove_meetings.meeting_reader').select('user_id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).orderBy('created_at').orderBy('id').execute();
  const people = await memberProfiles(trx, readers.map((r) => r.user_id).filter((id) => id !== recorder));
  const links = await trx.selectFrom('crove_meetings.meeting_link').select('party_id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).where('party_id', 'is not', null).orderBy('created_at').orderBy('id').execute();
  const partyIds = links.flatMap((l) => (l.party_id ? [l.party_id] : []));
  const parties = partyIds.length === 0 ? [] : await trx.selectFrom('crove_kernel.party').select(['id', 'name', 'email']).where('org_id', '=', orgId).where('id', 'in', partyIds).execute();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate) => {
    const email = followupAddress(candidate.email);
    if (email === null || seen.has(email)) return;
    seen.add(email);
    out.push({ ...candidate, email });
  };
  for (const p of people) add({ kind: 'attendee', id: p.userId, name: p.name, email: p.email });
  for (const p of parties) if (p.email) add({ kind: 'party', id: p.id, name: p.name, email: p.email });
  return out;
}

// Which of these addresses already got a mail of this meeting (queued, sent or delivered): the repeat needs the recorder's tick.
async function alreadySentTo(ctx: { trx: Trx; orgId: string }, meetingId: string, addresses: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (addresses.length === 0) return out;
  const byHash = new Map<string, string>();
  for (const address of addresses) byHash.set(await mailAddressHash({ trx: ctx.trx }, address), address);
  const rows = await ctx.trx
    .selectFrom('crove_kernel.mail_message')
    .select('to_hash')
    .where('org_id', '=', ctx.orgId)
    .where('source', '=', FOLLOWUP_MAIL_SOURCE)
    .where('source_id', '=', meetingId)
    .where('status', 'in', [...SENT_STATES])
    .where('to_hash', 'in', [...byHash.keys()])
    .execute();
  for (const row of rows) {
    const address = byHash.get(row.to_hash);
    if (address) out.add(address);
  }
  return out;
}

// The sends (batches) of this meeting in the last 24 hours, each counted once whatever its recipients.
async function sendsToday(ctx: { trx: Trx; orgId: string }, meetingId: string): Promise<number> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.mail_message')
    .select(sql<string | null>`payload ->> 'batch'`.as('batch'))
    .where('org_id', '=', ctx.orgId)
    .where('source', '=', FOLLOWUP_MAIL_SOURCE)
    .where('source_id', '=', meetingId)
    .where(sql<boolean>`created_at > pg_catalog.now() - interval '24 hours'`)
    .execute();
  return new Set(rows.map((r) => r.batch ?? '')).size;
}

async function meetingFacts(trx: Trx, orgId: string, meetingId: string): Promise<{ lang: Lang; day: string }> {
  const row = await trx.selectFrom('crove_meetings.meeting').select(['language', 'started_at', 'created_at']).where('org_id', '=', orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  return { lang: row.language === 'en' ? 'en' : 'vi', day: vnDay(row.started_at ?? row.created_at) };
}

async function orgName(trx: Trx, orgId: string): Promise<string> {
  const row = await trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', orgId).executeTakeFirstOrThrow();
  return followupClean(row.name, true).slice(0, 200);
}

export const followupDraft = defineQuery({
  name: 'meetings.followup.draft',
  input: zMeetingRef,
  access: EDITORS,
  // The facts are the meeting's text, so a read of them leaves an audit row naming the meeting.
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<FollowupDraft> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can write its follow-up');
    const published = await publishedFacts(ctx.trx, ctx.orgId, input.meetingId);
    const { lang, day } = await meetingFacts(ctx.trx, ctx.orgId, input.meetingId);
    const suggested = (await candidates(ctx.trx, ctx.orgId, input.meetingId, userId)).slice(0, FOLLOWUP_RECIPIENTS_MAX);
    const sent = await alreadySentTo(ctx, input.meetingId, suggested.map((c) => c.email));
    const recipients: FollowupRecipient[] = suggested.map((c) => ({ kind: c.kind, id: c.id, name: c.name, email: c.email, alreadySent: sent.has(c.email) }));
    return zFollowupDraft.parse({
      meetingId: input.meetingId,
      lang,
      org: await orgName(ctx.trx, ctx.orgId),
      factsKey: published.key,
      facts: published.facts,
      words: followupFixedWords(lang, day),
      recipients,
      sendsLeft: Math.max(0, FOLLOWUP_SENDS_PER_MEETING_PER_DAY - (await sendsToday(ctx, input.meetingId))),
    });
  },
});

const invalidText = (field: string, problem: FollowupTextProblem) =>
  new DomainError('FOLLOWUP_TEXT_INVALID', 422, `Phần "${field}" của thư không dùng được (${problem})`, { field, problem });

export const followupSend = defineCommand({
  name: 'meetings.followup.send',
  input: zFollowupSend,
  // It queues mail to people outside Ludy: a send, an effect outside it (R2), always from the recorder's own click.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input): Promise<FollowupSent> => {
    const { userId } = await recorderMeeting(ctx, input.meetingId, 'send its follow-up');
    // One send per meeting at a time: a double click waits here and then meets the first one's mails.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.followup:${ctx.orgId}:${input.meetingId}`}, 0))`.execute(ctx.trx);

    // The facts are the published result's, rebuilt now; the recorder reviewed another version when the key differs.
    const published = await publishedFacts(ctx.trx, ctx.orgId, input.meetingId);
    if (published.key !== input.factsKey) {
      throw new DomainError('STALE_FOLLOWUP', 409, 'Tóm tắt của cuộc họp đã thay đổi từ lúc bạn mở bản nháp; hãy mở lại bản nháp để xem nội dung mới');
    }

    // The words are checked here, every time, whatever their origin. The server cannot know where a text came from (a client can claim anything, or nothing), so "this is
    // Vy's" is not a gate: the same refusals as for the model's own output apply to every text (empty, too long, a figure, a link or address), and the facts the mail states
    // are the summary's alone. `fromVy` + `reviewed` is the recorder's statement that they read Vy's words; it adds a requirement and never removes a check.
    if (input.fromVy && !input.reviewed) throw new DomainError('FOLLOWUP_NOT_REVIEWED', 409, 'Đọc lại phần Vy viết và chọn "Tôi đã đọc" trước khi gửi');
    const subject = followupClean(input.subject, true);
    const greeting = followupClean(input.greeting, true);
    const lead = followupClean(input.lead, false);
    const closing = followupClean(input.closing, false);
    const subjectProblem = followupSubjectProblem(subject);
    if (subjectProblem) throw invalidText('subject', subjectProblem);
    for (const [field, text, max] of [
      ['greeting', greeting, FOLLOWUP_GREETING_MAX],
      ['lead', lead, FOLLOWUP_LEAD_MAX],
      ['closing', closing, FOLLOWUP_CLOSING_MAX],
    ] as const) {
      const problem = followupWordsProblem(text, max);
      if (problem) throw invalidText(field, problem);
    }

    // The recipients: valid mailboxes, each once.
    const addresses: string[] = [];
    for (const raw of input.recipients) {
      const address = followupAddress(raw);
      if (address === null) throw new DomainError('RECIPIENT_INVALID', 422, 'Có địa chỉ email người nhận không hợp lệ');
      if (!addresses.includes(address)) addresses.push(address);
    }
    if (addresses.length > FOLLOWUP_RECIPIENTS_MAX) throw new DomainError('TOO_MANY_RECIPIENTS', 422, `Một thư cảm ơn gửi tối đa cho ${FOLLOWUP_RECIPIENTS_MAX} người`);
    // Anyone who is neither a reader of the meeting nor a contact linked to it (and not the recorder) is flagged: the recorder ticks each such address before the send.
    const known = new Set((await candidates(ctx.trx, ctx.orgId, input.meetingId, userId)).map((c) => c.email));
    const confirmed = new Set(input.confirmedOutsiders.map((a) => followupAddress(a)).filter((a): a is string => a !== null));
    const own = (await memberProfiles(ctx.trx, [userId])).map((p) => followupAddress(p.email));
    const outsiders = addresses.filter((a) => !known.has(a) && !own.includes(a));
    const unconfirmed = outsiders.filter((a) => !confirmed.has(a));
    if (unconfirmed.length > 0) {
      throw new DomainError('RECIPIENT_NOT_CONFIRMED', 409, 'Có người nhận không thuộc cuộc họp này; hãy đánh dấu từng địa chỉ để xác nhận', { audit: { outsiders: unconfirmed.length } });
    }

    const batches = await sendsToday(ctx, input.meetingId);
    if (batches >= FOLLOWUP_SENDS_PER_MEETING_PER_DAY) {
      throw new DomainError('FOLLOWUP_LIMIT', 429, `Cuộc họp này đã gửi thư cảm ơn ${FOLLOWUP_SENDS_PER_MEETING_PER_DAY} lần trong 24 giờ qua; hãy thử lại sau`);
    }
    const repeats = await alreadySentTo(ctx, input.meetingId, addresses);
    if (repeats.size > 0 && !input.confirmRepeat) {
      throw new DomainError('ALREADY_SENT', 409, 'Đã gửi thư cảm ơn của cuộc họp này cho một số người nhận; gửi lại cần xác nhận', { audit: { repeated: repeats.size } });
    }

    const { lang } = await meetingFacts(ctx.trx, ctx.orgId, input.meetingId);
    const batchId = randomUUID();
    const payload: FollowupMail = { lang, org: await orgName(ctx.trx, ctx.orgId), batch: batchId, greeting, lead, closing, facts: published.facts };
    // The worker validates this at render; a mail it would refuse is refused here, before anything is queued or audited as sent.
    if (!zFollowupMail.safeParse(payload).success || Buffer.byteLength(JSON.stringify(payload), 'utf8') > PAYLOAD_MAX_BYTES) {
      throw new DomainError('FOLLOWUP_TOO_LARGE', 422, 'Nội dung thư quá dài để gửi; hãy rút gọn tóm tắt của cuộc họp rồi chia sẻ lại');
    }
    let queued = 0;
    let suppressed = 0;
    for (const address of addresses) {
      const mail = await createMailMessage(ctx, {
        stream: 'transactional',
        source: FOLLOWUP_MAIL_SOURCE,
        sourceId: input.meetingId,
        templateKey: FOLLOWUP_MAIL_TEMPLATE,
        to: address,
        subject,
        payload,
        status: 'queued',
      });
      if (mail.status === 'suppressed') suppressed += 1;
      else queued += 1;
    }
    // Counts and ids only: no address, no word of the mail.
    ctx.audit({ meetingId: input.meetingId, batchId, recipients: addresses.length, outsiders: outsiders.length, repeated: repeats.size, queued, suppressed, fromVy: input.fromVy });
    return { meetingId: input.meetingId, batchId, queued, suppressed };
  },
});

export const followupQueries = [followupDraft];
export const followupCommands = [followupSend];
