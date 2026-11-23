// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, issue #2590, plan docs/plan/meetings.md section 11 and 15, ADR-0047; personal note & unpublished draft #4292). The recorder of a meeting with a
// published summary (or, for the recorder alone, a reviewed/manual unpublished draft) opens a follow-up draft, picks either the structured minutes layout or a personal note prose style,
// edits the text and recipients, and sends it:
// - meetings.followup.draft (the recorder): the facts of the chosen stage (published by default when available, else draft), fixed words in the meeting's language, suggested recipients
//   (on published: meeting readers + linked contacts; on unpublished draft: linked external contacts only, never internal members by default) and sends left today.
// - meetings.followup.note_status / meetings.followup.note_start (the recorder): gating and member-scoped Vy run start for drafting a personal note under meetings.followup_note.
// - meetings.followup.send (the recorder; R2, it sends mail): queues one mail per address through the kernel's mail queue, audited with counts and ids only.
// The facts are rebuilt from the chosen stage at send time (refusing STALE_FOLLOWUP if edited or published since), and every text is cleaned and checked in code.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
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
  followupNoteProblem,
  followupSubjectProblem,
  followupWordsProblem,
  zFollowupDraft,
  zFollowupDraftAsk,
  zFollowupMail,
  zFollowupNoteStart,
  zFollowupNoteStarted,
  zFollowupNoteStatus,
  zFollowupSend,
  zMeetingRef,
  type FollowupDraft,
  type FollowupFacts,
  type FollowupMail,
  type FollowupRecipient,
  type FollowupSent,
  type FollowupStage,
  type FollowupTextProblem,
  type FollowupWords,
} from '@ludy/kernel-contract';
import { createMailMessage, mailAddressHash } from '@ludy/kernel';
import { DomainError, defineCommand, defineQuery, sha256Hex, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { lockFollowup } from './followup-erase.ts';
import { recorderMeeting } from './results.ts';
import { vnDay } from './retention.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { openMeeting, userOf } from './transcript.ts';

export const FOLLOWUP_NOTE_FEATURE = 'meetings.followup_note';

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
const noDraft = () => new DomainError('NO_DRAFT_SUMMARY', 409, 'Cuộc họp chưa có bản nháp tóm tắt hoặc việc cần làm để soạn thư cảm ơn');
const staleFollowup = () =>
  new DomainError('STALE_FOLLOWUP', 409, 'Tóm tắt của cuộc họp đã thay đổi từ lúc bạn mở bản nháp; hãy mở lại bản nháp để xem nội dung mới');
const draftNotReviewed = () =>
  new DomainError('DRAFT_NOT_REVIEWED', 409, 'Hãy đọc và xác nhận bản nháp Vy viết trước khi soạn thư cảm ơn');

export interface Published {
  facts: FollowupFacts;
  key: string;
}

export interface StageFacts extends Published {
  stage: FollowupStage;
}

async function stageFacts(trx: Trx, orgId: string, meetingId: string, stage: FollowupStage): Promise<StageFacts | null> {
  const result = await trx
    .selectFrom('ludy_meetings.meeting_result')
    .select(['id', 'summary', 'decisions', 'updated_at', 'tainted'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .executeTakeFirst();
  const items = await trx
    .selectFrom('ludy_meetings.action_item')
    .select(['id', 'title', 'who_drafted', 'when_drafted', 'updated_at', 'tainted', 'status'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .orderBy('transcript_seconds')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (!result && items.length === 0) return null;
  if (stage === 'draft' && (result?.tainted === true || items.some((i) => i.status === 'suggested' && i.tainted === true))) {
    throw draftNotReviewed();
  }
  const facts: FollowupFacts = {
    summary: result?.summary ?? '',
    decisions: Array.isArray(result?.decisions) ? (result.decisions as unknown[]).filter((d): d is string => typeof d === 'string') : [],
    items: items.map((i) => ({ title: i.title, who: i.who_drafted ?? '', when: i.when_drafted ?? '' })),
  };
  const stamp = result ? `${result.id}:${new Date(result.updated_at).toISOString()}` : 'items-only';
  const itemStamps = items.map((i) => `${i.id}:${new Date(i.updated_at).toISOString()}`);
  return { stage, facts, key: sha256Hex(JSON.stringify([stage, stamp, facts, itemStamps])) };
}

async function stageAvailable(trx: Trx, orgId: string, meetingId: string, stage: FollowupStage): Promise<boolean> {
  const result = await trx
    .selectFrom('ludy_meetings.meeting_result')
    .select(['id', 'tainted'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .executeTakeFirst();
  const items = await trx
    .selectFrom('ludy_meetings.action_item')
    .select(['id', 'tainted', 'status'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .execute();
  if (!result && items.length === 0) return false;
  if (stage === 'draft' && (result?.tainted === true || items.some((i) => i.status === 'suggested' && i.tainted === true))) return false;
  return true;
}

async function resolveStageFacts(trx: Trx, orgId: string, meetingId: string, requested?: FollowupStage): Promise<StageFacts> {
  if (requested === 'published') {
    const pub = await stageFacts(trx, orgId, meetingId, 'published');
    if (!pub) throw noSummary();
    return pub;
  }
  if (requested === 'draft') {
    const draft = await stageFacts(trx, orgId, meetingId, 'draft');
    if (!draft) throw noDraft();
    return draft;
  }
  const pub = await stageFacts(trx, orgId, meetingId, 'published');
  if (pub) return pub;
  const draft = await stageFacts(trx, orgId, meetingId, 'draft');
  if (draft) return draft;
  throw noSummary();
}

// The facts of the mail from the published result (used by channel posting and tests).
export async function publishedFacts(trx: Trx, orgId: string, meetingId: string): Promise<Published> {
  const pub = await stageFacts(trx, orgId, meetingId, 'published');
  if (!pub) throw noSummary();
  return { facts: pub.facts, key: pub.key };
}

async function memberProfiles(trx: Trx, userIds: readonly string[]): Promise<Array<{ userId: string; email: string; name: string }>> {
  if (userIds.length === 0) return [];
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`SELECT user_id, email, display_name FROM ludy_kernel.member_profiles(${userIds}::uuid[])`.execute(trx);
  return rows.map((p) => ({ userId: p.user_id, email: p.email, name: p.display_name ?? p.email.split('@')[0] ?? '' }));
}

interface Candidate {
  kind: 'attendee' | 'party';
  id: string;
  name: string;
  email: string;
}

// The people the draft suggests, and the addresses the mail may go to without a tick:
// - for published minutes: the meeting's readers that are members, then the contacts linked to it (L1);
// - for an unpublished draft: ONLY linked external party contacts with emails (internal org member attendees are not auto-suggested).
// The recorder is the sender, so they are not suggested. A contact is read under the caller's own policies.
async function candidates(trx: Trx, orgId: string, meetingId: string, recorder: string, stage: FollowupStage = 'published'): Promise<Candidate[]> {
  const people =
    stage === 'published'
      ? await (async () => {
          const readers = await trx
            .selectFrom('ludy_meetings.meeting_reader')
            .select('user_id')
            .where('org_id', '=', orgId)
            .where('meeting_id', '=', meetingId)
            .orderBy('created_at')
            .orderBy('id')
            .execute();
          return memberProfiles(
            trx,
            readers.map((r) => r.user_id).filter((id) => id !== recorder),
          );
        })()
      : [];
  const links = await trx
    .selectFrom('ludy_meetings.meeting_link')
    .select('party_id')
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('party_id', 'is not', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const partyIds = links.flatMap((l) => (l.party_id ? [l.party_id] : []));
  const parties =
    partyIds.length === 0
      ? []
      : await trx.selectFrom('ludy_kernel.party').select(['id', 'name', 'email']).where('org_id', '=', orgId).where('id', 'in', partyIds).execute();
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
    .selectFrom('ludy_kernel.mail_message')
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
    .selectFrom('ludy_kernel.mail_message')
    .select(sql<string | null>`payload ->> 'batch'`.as('batch'))
    .where('org_id', '=', ctx.orgId)
    .where('source', '=', FOLLOWUP_MAIL_SOURCE)
    .where('source_id', '=', meetingId)
    .where(sql<boolean>`created_at > pg_catalog.now() - interval '24 hours'`)
    .execute();
  return new Set(rows.map((r) => r.batch ?? '')).size;
}

export async function meetingFacts(trx: Trx, orgId: string, meetingId: string): Promise<{ lang: Lang; day: string }> {
  const row = await trx.selectFrom('ludy_meetings.meeting').select(['language', 'started_at', 'created_at']).where('org_id', '=', orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  return { lang: row.language === 'en' ? 'en' : 'vi', day: vnDay(row.started_at ?? row.created_at) };
}

async function orgName(trx: Trx, orgId: string): Promise<string> {
  const row = await trx.selectFrom('ludy_kernel.tenant').select('name').where('org_id', '=', orgId).executeTakeFirstOrThrow();
  return followupClean(row.name, true).slice(0, 200);
}

export const followupDraft = defineQuery({
  name: 'meetings.followup.draft',
  input: zFollowupDraftAsk,
  access: EDITORS,
  // The facts are the meeting's text, so a read of them leaves an audit row naming the meeting.
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<FollowupDraft> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can write its follow-up');
    const resolved = await resolveStageFacts(ctx.trx, ctx.orgId, input.meetingId, input.stage);
    const hasPublished = resolved.stage === 'published' ? true : await stageAvailable(ctx.trx, ctx.orgId, input.meetingId, 'published');
    const hasDraft = resolved.stage === 'draft' ? true : await stageAvailable(ctx.trx, ctx.orgId, input.meetingId, 'draft');
    const { lang, day } = await meetingFacts(ctx.trx, ctx.orgId, input.meetingId);
    const suggested = (await candidates(ctx.trx, ctx.orgId, input.meetingId, userId, resolved.stage)).slice(0, FOLLOWUP_RECIPIENTS_MAX);
    const sent = await alreadySentTo(ctx, input.meetingId, suggested.map((c) => c.email));
    const recipients: FollowupRecipient[] = suggested.map((c) => ({ kind: c.kind, id: c.id, name: c.name, email: c.email, alreadySent: sent.has(c.email) }));
    return zFollowupDraft.parse({
      meetingId: input.meetingId,
      lang,
      org: await orgName(ctx.trx, ctx.orgId),
      stage: resolved.stage,
      hasPublished,
      hasDraft,
      factsKey: resolved.key,
      facts: resolved.facts,
      words: followupFixedWords(lang, day),
      recipients,
      sendsLeft: Math.max(0, FOLLOWUP_SENDS_PER_MEETING_PER_DAY - (await sendsToday(ctx, input.meetingId))),
    });
  },
});

// Whether this deployment lets the recorder's Vy draft a personal-note follow-up email.
export const followupNoteStatus = defineQuery({
  name: 'meetings.followup.note_status',
  input: zMeetingRef,
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = meeting.recorder_user_id !== userId ? ('not_recorder' as const) : await vyReason(ctx);
    return zFollowupNoteStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

// Starts the recorder's own Vy run for drafting a personal-note follow-up email (#4292): recorder only, deployment switch on,
// and facts available (and reviewed if draft stage). The kernel's run.start enforces vy.use, kill switches and budget.
export const followupNoteStart = defineCommand({
  name: 'meetings.followup.note_start',
  input: zFollowupNoteStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for a follow-up note');
    const resolved = await resolveStageFacts(ctx.trx, ctx.orgId, input.meetingId, input.stage);
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', {
      feature: FOLLOWUP_NOTE_FEATURE,
      subjectType: 'meeting',
      subjectId: input.meetingId,
    });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId, stage: resolved.stage });
    return zFollowupNoteStarted.parse({ meetingId: input.meetingId, runId: started.runId, stage: resolved.stage });
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
    await lockFollowup(ctx, input.meetingId);

    // The facts are rebuilt from the chosen stage now; the recorder reviewed another version when the key differs (or when a draft was published since).
    let loaded: StageFacts | null;
    if (input.stage === 'published') {
      loaded = await stageFacts(ctx.trx, ctx.orgId, input.meetingId, 'published');
      if (!loaded) throw noSummary();
    } else {
      loaded = await stageFacts(ctx.trx, ctx.orgId, input.meetingId, 'draft');
      if (!loaded) {
        const pub = await stageFacts(ctx.trx, ctx.orgId, input.meetingId, 'published');
        if (pub) throw staleFollowup();
        throw noDraft();
      }
    }
    if (loaded.key !== input.factsKey) throw staleFollowup();
    if (input.stage === 'draft' && !input.confirmUnpublished) {
      throw new DomainError('UNPUBLISHED_NOT_CONFIRMED', 409, 'Bản tóm tắt này chưa chia sẻ với người dự họp; hãy đánh dấu xác nhận gửi từ bản nháp trước khi gửi');
    }

    // The text is checked here, every time, whatever its origin. `fromVy` + `reviewed` is the recorder's statement that they read Vy's words;
    // it adds a requirement and never removes a check.
    if (input.fromVy && !input.reviewed) throw new DomainError('FOLLOWUP_NOT_REVIEWED', 409, 'Đọc lại phần Vy viết và chọn "Tôi đã đọc" trước khi gửi');
    const subject = followupClean(input.subject, true);
    const subjectProblem = followupSubjectProblem(subject);
    if (subjectProblem) throw invalidText('subject', subjectProblem);

    const { lang } = await meetingFacts(ctx.trx, ctx.orgId, input.meetingId);
    const org = await orgName(ctx.trx, ctx.orgId);
    const batchId = randomUUID();
    let payload: FollowupMail;
    if (input.style === 'personal_note') {
      const body = followupClean(input.body ?? '', false);
      const bodyProblem = followupNoteProblem(body);
      if (bodyProblem) throw invalidText('body', bodyProblem);
      payload = { style: 'personal_note', lang, org, batch: batchId, body };
    } else {
      const greeting = followupClean(input.greeting, true);
      const lead = followupClean(input.lead, false);
      const closing = followupClean(input.closing, false);
      for (const [field, text, max] of [
        ['greeting', greeting, FOLLOWUP_GREETING_MAX],
        ['lead', lead, FOLLOWUP_LEAD_MAX],
        ['closing', closing, FOLLOWUP_CLOSING_MAX],
      ] as const) {
        const problem = followupWordsProblem(text, max);
        if (problem) throw invalidText(field, problem);
      }
      payload = { lang, org, batch: batchId, greeting, lead, closing, facts: loaded.facts };
    }

    // The recipients: valid mailboxes, each once.
    const addresses: string[] = [];
    for (const raw of input.recipients) {
      const address = followupAddress(raw);
      if (address === null) throw new DomainError('RECIPIENT_INVALID', 422, 'Có địa chỉ email người nhận không hợp lệ');
      if (!addresses.includes(address)) addresses.push(address);
    }
    if (addresses.length > FOLLOWUP_RECIPIENTS_MAX) throw new DomainError('TOO_MANY_RECIPIENTS', 422, `Một thư cảm ơn gửi tối đa cho ${FOLLOWUP_RECIPIENTS_MAX} người`);
    // Anyone who is not a suggested recipient for this stage (and not the recorder) is flagged: the recorder ticks each such address before the send.
    const known = new Set((await candidates(ctx.trx, ctx.orgId, input.meetingId, userId, input.stage)).map((c) => c.email));
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
    // Counts, ids and enum metadata only: no address, no word of the mail.
    ctx.audit({
      meetingId: input.meetingId,
      batchId,
      recipientCount: addresses.length,
      outsiders: outsiders.length,
      repeated: repeats.size,
      queued,
      suppressed,
      fromVy: input.fromVy,
      style: input.style,
      stage: input.stage,
    });
    return { meetingId: input.meetingId, batchId, queued, suppressed };
  },
});

export const followupQueries = [followupDraft, followupNoteStatus];
export const followupCommands = [followupSend, followupNoteStart];
