// SPDX-License-Identifier: AGPL-3.0-only
// Suggesting the minutes template of a meeting from the meeting itself (#4772, plan docs/plan/meetings.md row L16). The recorder picks a template by hand today (meetings.minutes.set_template) and most people leave the
// general summary. This is the CODE FIRST half, with no model: for a meeting with a transcript that is still on the general summary, four signals read under the recorder's own row security vote for one of the four
// other built-in templates:
//   series   the previous meeting of its series (#3542) is on that template;
//   deal     a CRM deal is linked to it (a deal means a customer meeting);
//   title    the title has a word of that kind (a fixed, accent-folded list below: giao ban, 1:1, báo giá, nhà cung cấp, ...);
//   people   exactly two people (the recorder and one reader), only ever a corroboration of a one-to-one that another signal already voted for, never a reason on its own.
// Code suggests when exactly one template got votes. No vote, or two templates in conflict, is "cannot tell": the recorder may then click to have their own Vy read the transcript (the run below, the status and the
// start are the commitments' and open points' guards). The answer is a template code and fixed reason codes the app words; no text of the meeting or of a model is in it. A meeting has no project link (its links
// are a party, a deal and a calendar event), so a project is no signal. Nothing here writes: the recorder accepts with the existing meetings.minutes.set_template.
// The Vy run takes a random subject like the brief's and open points' runs: its result row holds counts only.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  SUGGESTABLE_TEMPLATES,
  zSummaryRef,
  zSummaryStart,
  zSummaryStarted,
  zSummaryStatus,
  zTemplateSuggestion,
  type SuggestableTemplate,
  type TemplateReason,
  type TemplateSuggestion,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { lockMeetingMedia, markAudioUsed } from './media-record.ts';
import { plainName } from './plain-name.ts';
import { previousMeetingOf } from './series.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const TEMPLATE_SUGGEST_FEATURE = 'meetings.template_suggest';
type Trx = QueryContext['trx'];

// The words of a title that name a kind of meeting, in the accent-folded form plainName gives. A word counts whole (not inside another word). Short and fixed: a word code is unsure of is left out, and the
// recorder can still ask Vy.
const TITLE_WORDS: Readonly<Record<SuggestableTemplate, readonly string[]>> = {
  briefing: ['giao ban', 'stand up', 'standup', 'stand-up', 'daily', 'weekly', 'sprint', 'hop tuan'],
  one_on_one: ['1:1', '1on1', '1 on 1', 'one on one', 'one-on-one', 'mot kem mot', 'gap rieng'],
  customer: ['khach hang', 'bao gia', 'demo', 'tu van', 'ban hang', 'sales', 'customer', 'client'],
  supplier: ['nha cung cap', 'ncc', 'nhap hang', 'dat hang', 'giao hang', 'cung ung', 'nguyen lieu', 'supplier', 'vendor'],
};
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TITLE_PATTERNS: ReadonlyArray<readonly [SuggestableTemplate, RegExp]> = SUGGESTABLE_TEMPLATES.map((template) => [template, new RegExp(`(?:^|[^a-z0-9])(?:${TITLE_WORDS[template].map(escapeRegex).join('|')})(?:$|[^a-z0-9])`)] as const);

/** The templates whose words a title holds, in the order of SUGGESTABLE_TEMPLATES. */
export function titleTemplates(title: string): SuggestableTemplate[] {
  const folded = plainName(title);
  return TITLE_PATTERNS.filter(([, pattern]) => pattern.test(folded)).map(([template]) => template);
}

export interface TemplateSignals {
  // The template the previous meeting of the series is on, when there is one and it is a suggestable built-in.
  seriesTemplate: SuggestableTemplate | null;
  hasDeal: boolean;
  title: string;
  // The recorder and the people who may read the meeting.
  people: number;
}

/**
 * Code's vote: exactly one template with a vote is a suggestion with its reasons; none, or two in conflict, is "cannot tell". The number of people only adds a reason to a one-to-one another signal chose.
 */
export function suggestTemplateFrom(signals: TemplateSignals): { state: 'suggested'; template: SuggestableTemplate; reasons: TemplateReason[] } | { state: 'unknown'; template: null; reasons: [] } {
  const votes = new Map<SuggestableTemplate, TemplateReason[]>();
  const vote = (template: SuggestableTemplate, reason: TemplateReason) => votes.set(template, [...(votes.get(template) ?? []), reason]);
  if (signals.seriesTemplate !== null) vote(signals.seriesTemplate, 'series');
  if (signals.hasDeal) vote('customer', 'deal');
  for (const template of titleTemplates(signals.title)) vote(template, 'title');
  if (votes.size !== 1) return { state: 'unknown', template: null, reasons: [] };
  const [template, reasons] = [...votes][0] as [SuggestableTemplate, TemplateReason[]];
  if (template === 'one_on_one' && signals.people === 2) reasons.push('people');
  return { state: 'suggested', template, reasons };
}

const notApplicable = (meetingId: string): TemplateSuggestion => zTemplateSuggestion.parse({ meetingId, state: 'not_applicable', template: null, reasons: [] });

// Code's answer for one meeting (see the header). Only the recorder of a meeting with a transcript that is still on the general summary gets anything but "not applicable".
export const templateSuggest = defineQuery({
  name: 'meetings.template.suggest',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input): Promise<TemplateSuggestion> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) return notApplicable(input.meetingId);
    const row = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['title', 'summary_template', 'series_id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    if (row.summary_template !== 'general') return notApplicable(input.meetingId);
    const segment = await ctx.trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!segment) return notApplicable(input.meetingId);
    const answer = suggestTemplateFrom({
      seriesTemplate: await seriesTemplateOf(ctx.trx, ctx.orgId, input.meetingId, row.series_id, row.at),
      hasDeal: (await ctx.trx.selectFrom('ludy_meetings.meeting_link').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('deal_id', 'is not', null).limit(1).executeTakeFirst()) !== undefined,
      title: row.title,
      people: await peopleOf(ctx.trx, ctx.orgId, input.meetingId, meeting.recorder_user_id),
    });
    return zTemplateSuggestion.parse({ meetingId: input.meetingId, ...answer });
  },
});

// The built-in template the previous meeting of the series (the latest earlier one this caller reads) is on, when it is one of the four.
async function seriesTemplateOf(trx: Trx, orgId: string, meetingId: string, seriesId: string | null, at: Date): Promise<SuggestableTemplate | null> {
  if (seriesId === null) return null;
  const previous = await previousMeetingOf(trx, orgId, seriesId, at, meetingId);
  if (!previous) return null;
  const used = await trx.selectFrom('ludy_meetings.meeting').select('summary_template').where('org_id', '=', orgId).where('id', '=', previous.id).executeTakeFirst();
  return (SUGGESTABLE_TEMPLATES as readonly string[]).includes(used?.summary_template ?? '') ? (used?.summary_template as SuggestableTemplate) : null;
}

// The recorder and the people who may read the meeting, counted once each.
async function peopleOf(trx: Trx, orgId: string, meetingId: string, recorderId: string): Promise<number> {
  const readers = await trx
    .selectFrom('ludy_meetings.meeting_reader')
    .select(sql<string>`count(distinct user_id)::text`.as('n'))
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('user_id', '<>', recorderId)
    .executeTakeFirstOrThrow();
  return 1 + Number(readers.n);
}

// Starts the recorder's own Vy run that suggests a template when code could not tell: the recorder only, with the deployment's switch on and a transcript to read, not while this meeting is being transcribed. The kernel's
// run.start then checks vy.use, the kill switches, the global ai switch and the budget, and makes the member's Vy and this run. Nothing is read or sent here.
export const templateSuggestStart = defineCommand({
  name: 'meetings.template_suggest.start',
  input: zSummaryStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to suggest the minutes template');
    // The meeting's media lock and a FOR SHARE hold on the meeting, as the summary's, the chapters' and the commitments' start take them (#3187).
    await lockMeetingMedia(ctx, input.meetingId);
    await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe', subjectId: input.meetingId });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    const any = await ctx.trx.selectFrom('ludy_meetings.transcript_segment').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).limit(1).executeTakeFirst();
    if (!any) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to read yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: TEMPLATE_SUGGEST_FEATURE, subjectType: TEMPLATE_SUGGEST_FEATURE, subjectId: randomUUID() });
    // The answer rests on the transcript of the recording: it is in use from here on (#3187), under the media lock a replacement takes.
    await markAudioUsed(ctx, input.meetingId);
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zSummaryStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// Whether this deployment lets the recorder's Vy suggest a template, for the button.
export const templateSuggestStatus = defineQuery({
  name: 'meetings.template_suggest.status',
  input: zSummaryRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = !isSummaryEnabled() ? ('off' as const) : meeting.recorder_user_id !== userId ? ('not_recorder' as const) : null;
    return zSummaryStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason });
  },
});

export const templateSuggestCommands = [templateSuggestStart];
export const templateSuggestQueries = [templateSuggest, templateSuggestStatus];
