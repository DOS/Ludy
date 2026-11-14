// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy summarizing a meeting, the module's side (#2580, M6 part B, ADR-0047 point 8, ADR-0049 decision 8). The model's answer lands in the
// recorder's own Vy result (the row is sealed to them). This command is the recorder's own click that copies it into their DRAFT: the summary and the
// decisions, and one action item per suggestion, all marked as the model's text (tainted) until the recorder edits it. Code, not the model, then decides
// what each item says about who and when: the "who" is matched to an attendee only when exactly one attendee answers to that name, the "when" is parsed
// against the meeting's own date, and a link, email address or phone number in a title is flagged. Nothing is shared by this; the recorder's publish does that.
import { sql } from 'kysely';
import { zSummaryCopy, zSummaryCopied, zSummaryResult, ITEMS_PER_MEETING_MAX, sectionsToText, templateSections } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { itemFlags } from './results.ts';
import { dayAfter, vnDay } from './retention.ts';
import { SUMMARY_FEATURE as FEATURE, isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// "Nguyễn Văn Nam" and "nguyen van nam" are one name: no marks, lower case, single spaces.
export function plainName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The one attendee a said name belongs to, or null: the whole name or one word of it (a Vietnamese is often called by the last word) of exactly one
 * attendee. Two attendees who answer to it, or none, leave the item for a person to name.
 */
export function matchAttendee(who: string, people: ReadonlyArray<{ userId: string; name: string }>): string | null {
  const said = plainName(who);
  if (said === '') return null;
  const hits = people.filter((p) => {
    const name = plainName(p.name);
    return name === said || name.split(' ').includes(said);
  });
  return hits.length === 1 ? (hits[0] as { userId: string }).userId : null;
}

const WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ['thu hai', 1],
  ['thu ba', 2],
  ['thu tu', 3],
  ['thu nam', 4],
  ['thu sau', 5],
  ['thu bay', 6],
  ['chu nhat', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
  ['sunday', 0],
];

const validDay = (year: number, month: number, day: number): string | null => {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
};
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/**
 * The calendar day a said "when" means, read by code against the meeting's own day (YYYY-MM-DD, Vietnam time), or null when it does not name one day for
 * sure: a date (2026-11-13, 13/11, 13/11/2026), today, tomorrow, the day after, or a weekday (the next one after the meeting day). A "next week" or a
 * "soon" is null, and a date earlier than the meeting is null: a person decides.
 */
export function parseWhen(text: string, meetingDay: string): string | null {
  const said = plainName(text);
  if (said === '') return null;
  const found = new Set<string>();
  // Whole words only ("thu ba" is not the start of "thu bay"): the text with everything but letters, digits and the date marks turned into single spaces.
  const words = ` ${said.replace(/[^\p{L}\p{N}/-]+/gu, ' ').trim()} `;
  const has = (phrase: string): boolean => words.includes(` ${phrase} `);
  const iso = /(?:^|\D)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(said);
  if (iso) found.add(validDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? 'x');
  const dm = /(?:^|\D)(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/.exec(said);
  if (dm) found.add(validDay(dm[3] ? Number(dm[3]) : Number(meetingDay.slice(0, 4)), Number(dm[2]), Number(dm[1])) ?? 'x');
  if (has('hom nay') || has('today')) found.add(meetingDay);
  if (has('ngay mai') || has('tomorrow')) found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), 1));
  if (has('ngay kia')) found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), 2));
  for (const [phrase, weekday] of WEEKDAYS) {
    if (!has(phrase)) continue;
    const from = new Date(`${meetingDay}T12:00:00Z`).getUTCDay();
    found.add(dayAfter(new Date(`${meetingDay}T12:00:00Z`), ((weekday - from + 6) % 7) + 1));
  }
  // "next week", "last Friday": a weekday or date with a week named is a different day than the nearest one, so a person decides.
  if (has('tuan') || has('next') || has('last') || has('previous')) return null;
  if (found.size !== 1) return null;
  const day = [...found][0] as string;
  if (day === 'x' || dayNumber(day) < dayNumber(meetingDay)) return null;
  return day;
}

export const summaryCopyResult = defineCommand({
  name: 'meetings.summary.copy_result',
  input: zSummaryCopy,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Summaries by Vy are not turned on here; type the summary by hand');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can copy its summary');
    // The recorder's own result, read in the recorder's own context (the row is sealed to its member). A run of another meeting or feature is not this one.
    const found = await ctx
      .query<{ status: string; feature: string; subjectType: string; subjectId: string; body: string | null; expiresAt: string }>('kernel.member_vy.result.get', { runId: input.runId })
      .catch((error: unknown) => {
        // The kernel's own refusal for a run that is not the caller's or does not exist.
        if (error instanceof DomainError && error.code === 'RESULT_NOT_FOUND') throw new DomainError('SUMMARY_RESULT_NOT_FOUND', 404, 'No summary result for this meeting');
        throw error;
      });
    if (found.status !== 'ok') throw new DomainError('SUMMARY_RESULT_NOT_FOUND', 404, 'No summary result for this meeting');
    const result = found.value;
    if (result.feature !== FEATURE || result.subjectType !== 'meeting' || result.subjectId !== input.meetingId) {
      throw new DomainError('SUMMARY_RESULT_NOT_FOUND', 404, 'No summary result for this meeting');
    }
    // An answer past its expiry is gone for the member, as the kernel's own read treats it: it is not copied into a draft.
    if (new Date(result.expiresAt).getTime() <= ctx.now.getTime()) throw new DomainError('SUMMARY_RESULT_NOT_FOUND', 404, 'No summary result for this meeting');
    if (result.status !== 'ready' || result.body === null) throw new DomainError('SUMMARY_RESULT_NOT_READY', 409, 'The summary is not finished');
    // The body is the model's, checked once by the agent package; it is read back strictly here and never trusted for its shape.
    let body;
    try {
      body = zSummaryResult.parse(JSON.parse(result.body));
    } catch {
      throw new DomainError('SUMMARY_RESULT_INVALID', 422, 'The summary result cannot be read');
    }
    // The meeting's day and who may be named: the recorder and the attendees, by the names the org knows them by (member_profiles answers for members only).
    const row = await ctx.trx.selectFrom('crove_meetings.meeting').select(['started_at', 'summary_template']).where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    const meetingDay = vnDay(row.started_at ?? new Date());
    // A4 (#3162): a run was asked for one template; if the recorder picked another since, its sections would not fit the headings they now type under, so it is not copied.
    if (body.template !== row.summary_template) throw new DomainError('SUMMARY_TEMPLATE_CHANGED', 409, 'The minutes template changed since Vy wrote this; ask Vy again');
    // On a template the sections become the one summary text, by code (the headings are code's, the text is the model's, already checked); on the general template the summary is as it was.
    const defs = templateSections(body.template);
    const summaryText = defs.length === 0 ? body.summary : sectionsToText(body.template, body.sections.filter((x) => defs.some((d) => d.key === x.key)));
    const readers = await ctx.trx.selectFrom('crove_meetings.meeting_reader').select('user_id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).execute();
    const ids = [userId, ...readers.map((r) => r.user_id)];
    const { rows: profiles } = await sql<{ user_id: string; email: string; display_name: string | null }>`SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
    const people = profiles.map((p) => ({ userId: p.user_id, name: p.display_name ?? p.email.split('@')[0] ?? '' }));

    // One copy of a run: a run already copied (its rows carry its id, read or not) is not copied again, which would duplicate its items.
    const already = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('source_run_id', '=', input.runId)
      .unionAll(ctx.trx.selectFrom('crove_meetings.meeting_result').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('source_run_id', '=', input.runId))
      .executeTakeFirst();
    if (already) throw new DomainError('SUMMARY_ALREADY_COPIED', 409, 'This summary was already copied into the draft');
    // The earlier model-written drafts go (the recorder asked for a new run); what the recorder typed, or read and kept, stays, and a summary of theirs that is
    // still there is not replaced: they share it or save over it first.
    await ctx.trx.deleteFrom('crove_meetings.meeting_result').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').where('tainted', '=', true).execute();
    const mine = await ctx.trx.selectFrom('crove_meetings.meeting_result').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').executeTakeFirst();
    if (mine && (summaryText !== '' || body.decisions.length > 0)) throw new DomainError('DRAFT_SUMMARY_EXISTS', 409, 'You already have a summary draft; share it or save over it before copying Vy\'s');
    await ctx.trx
      .deleteFrom('crove_meetings.action_item')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'draft')
      .where('status', '=', 'suggested')
      .where('tainted', '=', true)
      .execute();
    if (summaryText !== '' || body.decisions.length > 0) {
      // A second click at the same moment waits on the first's row and then meets the one draft a meeting may hold: the same answer as a draft that is there.
      await ctx.trx
        .insertInto('crove_meetings.meeting_result')
        .values({
          org_id: ctx.orgId,
          meeting_id: input.meetingId,
          summary: summaryText === '' ? body.decisions[0] ?? '-' : summaryText,
          decisions: sql`${JSON.stringify(body.decisions)}::jsonb`,
          feature: FEATURE,
          stage: 'draft',
          tainted: true,
          source_run_id: input.runId,
        })
        .execute()
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '23505') throw new DomainError('DRAFT_SUMMARY_EXISTS', 409, 'You already have a summary draft; share it or save over it before copying Vy\'s');
          throw error;
        });
    }
    const kept = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    const room = Math.max(0, ITEMS_PER_MEETING_MAX - kept.n);
    const items = body.items.slice(0, room);
    for (const item of items) {
      await ctx.trx
        .insertInto('crove_meetings.action_item')
        .values({
          org_id: ctx.orgId,
          meeting_id: input.meetingId,
          title: item.title,
          who_drafted: itemFlags(item.who).length > 0 ? '' : item.who,
          who_parsed: matchAttendee(item.who, people),
          when_drafted: itemFlags(item.when).length > 0 ? '' : item.when,
          when_parsed: parseWhen(item.when, meetingDay),
          transcript_seconds: item.seconds,
          stage: 'draft',
          flags: sql`${JSON.stringify(itemFlags(item.title))}::jsonb`,
          tainted: true,
          source_run_id: input.runId,
        })
        .execute();
    }
    ctx.audit({ meetingId: input.meetingId, runId: input.runId, decisionCount: body.decisions.length, itemCount: items.length, dropped: body.dropped });
    return zSummaryCopied.parse({ meetingId: input.meetingId, decisions: body.decisions.length, items: items.length, dropped: body.dropped + (body.items.length - items.length) });
  },
});

export const summaryCommands = [summaryCopyResult];
