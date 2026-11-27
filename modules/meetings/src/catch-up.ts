// SPDX-License-Identifier: AGPL-3.0-only
// Catch-up summary for a member who missed a meeting (L33, #5130, ADR-0049):
//   meetings.catch_up.status   readers only (non-readers get 404; recorder gets reason: 'is_recorder'); checks published minutes and redaction,
//                              builds `yourItems` deterministically in code (`who_parsed === userId` or folded display-name match), and adds Vy readiness.
//   meetings.catch_up.facts    internal query returning only published summary, published decisions, published action items, language and askerName (no transcript/draft/notes).
//   meetings.catch_up.start    R1 command that starts the member's own Vy run under meetings.catch_up after enforcing reader, published, redaction, AI-off, permission, and budget gates.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  CATCH_UP_YOUR_ITEMS_MAX,
  REDACTION_MARK_BY_KIND,
  zCatchUpFacts,
  zCatchUpStarted,
  zCatchUpStatus,
  zMeetingRef,
  type CatchUpFacts,
  type CatchUpStatus,
  type CatchUpYourItem,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { ASSIGNEE_HONORIFICS } from './assignee-match.ts';
import { vyReason } from './ask.ts';
import { plainName } from './plain-name.ts';
import { cleanName } from './speaker.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

const CATCH_UP_FEATURE = 'meetings.catch_up';
const REDACTION_MARKS = Object.values(REDACTION_MARK_BY_KIND);
const FOLDED_HONORIFICS = new Set(ASSIGNEE_HONORIFICS.map((word) => plainName(word)));

export interface CatchUpActionRow {
  id: string;
  title: string;
  who_drafted: string;
  who_parsed: string | null;
  when_drafted: string;
  when_parsed: string | null;
  status: 'suggested' | 'accepted';
  task_id: string | null;
}

function nameWords(raw: string, stripHonorifics: boolean): string[] {
  const withoutParens = raw.replace(/\([^)]*\)/g, ' ');
  const folded = plainName(withoutParens);
  if (folded === '') return [];
  const words = folded.split(/\s+/).filter((w) => w !== '');
  while (stripHonorifics && words[0] !== undefined && FOLDED_HONORIFICS.has(words[0])) {
    words.shift();
  }
  return words;
}

function matchesReaderName(whoDrafted: string, askerName: string): boolean {
  const askerWords = nameWords(askerName, false);
  const whoWords = nameWords(whoDrafted, true);
  if (askerWords.length === 0 || whoWords.length === 0) return false;
  if (whoWords.length > askerWords.length) return false;
  const offset = askerWords.length - whoWords.length;
  return whoWords.every((word, idx) => askerWords[offset + idx] === word);
}

function matchCatchUpItem(row: CatchUpActionRow, userId: string, askerName: string): 'user_id' | 'name' | null {
  if (row.who_parsed === userId) return 'user_id';
  if (row.who_parsed !== null) return null;
  return matchesReaderName(row.who_drafted, askerName) ? 'name' : null;
}

/** Returns true if any text in the published minutes contains a redaction mark. */
export function hasRedactedMinutes(texts: readonly string[]): boolean {
  return texts.some((text) => REDACTION_MARKS.some((mark) => text.includes(mark)));
}

/** Builds a reader's deterministic "Việc của bạn" list from published action items (capped at 25). */
export function yourCatchUpItems(items: readonly CatchUpActionRow[], userId: string, askerName: string): CatchUpYourItem[] {
  const out: CatchUpYourItem[] = [];
  for (const row of items) {
    const matchedBy = matchCatchUpItem(row, userId, askerName);
    if (matchedBy === null) continue;
    out.push({
      itemId: row.id,
      title: row.title,
      who: row.who_drafted,
      when: row.when_drafted,
      whenDate: row.when_parsed,
      status: row.status,
      taskId: row.task_id,
      matchedBy,
    });
    if (out.length >= CATCH_UP_YOUR_ITEMS_MAX) break;
  }
  return out;
}

async function askerDisplayName(ctx: CommandContext | QueryContext, userId: string): Promise<string> {
  const { rows } = await sql<{ display_name: string | null }>`SELECT display_name FROM ludy_kernel.member_profiles(ARRAY[${userId}]::uuid[])`.execute(ctx.trx);
  return cleanName(rows[0]?.display_name);
}

function parseDecisions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

async function readPublishedForCatchUp(ctx: CommandContext | QueryContext, meetingId: string) {
  const row = await ctx.trx
    .selectFrom('ludy_meetings.meeting_result')
    .select(['id', 'summary', 'decisions'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .executeTakeFirst();
  if (!row) return null;
  const decisions = parseDecisions(row.decisions);
  const published = { id: row.id, summary: row.summary, decisions };
  const rows = await ctx.trx
    .selectFrom('ludy_meetings.action_item')
    .select(['id', 'status', 'title', 'who_drafted', 'who_parsed', 'when_drafted', sql<string | null>`when_parsed::text`.as('when_parsed'), 'task_id'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .orderBy('transcript_seconds')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const items: CatchUpActionRow[] = rows.map((item) => ({
    id: item.id,
    title: item.title,
    who_drafted: item.who_drafted,
    who_parsed: item.who_parsed,
    when_drafted: item.when_drafted,
    when_parsed: item.when_parsed,
    status: item.status,
    task_id: item.task_id,
  }));
  const texts = [published.summary, ...published.decisions, ...items.flatMap((i) => [i.title, i.who_drafted, i.when_drafted])];
  return { published, items, redacted: hasRedactedMinutes(texts) };
}

/** Reader-only catch-up readiness and deterministic "Việc của bạn" list (works with AI off). */
const catchUpStatus = defineQuery({
  name: 'meetings.catch_up.status',
  input: zMeetingRef,
  output: zCatchUpStatus,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<CatchUpStatus> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id === userId) {
      return { meetingId: input.meetingId, available: false, reason: 'is_recorder', yourItems: [], estimate: null };
    }
    const data = await readPublishedForCatchUp(ctx, input.meetingId);
    if (!data) {
      return { meetingId: input.meetingId, available: false, reason: 'not_published', yourItems: [], estimate: null };
    }
    if (data.redacted) {
      return { meetingId: input.meetingId, available: false, reason: 'redacted', yourItems: [], estimate: null };
    }
    const askerName = await askerDisplayName(ctx, userId);
    const yourItems = yourCatchUpItems(data.items, userId, askerName);
    const vy = await vyReason(ctx);
    if (vy === 'forbidden' || vy === 'budget' || vy === 'off' || vy === 'paused') {
      return { meetingId: input.meetingId, available: false, reason: vy, yourItems, estimate: null };
    }
    return { meetingId: input.meetingId, available: true, reason: null, yourItems, estimate: null };
  },
});

/** Route-only query returning published minutes and items for Vy's catch-up prompt (never transcript/draft/notes). */
const catchUpFacts = defineQuery({
  name: 'meetings.catch_up.facts',
  input: zMeetingRef,
  output: zCatchUpFacts,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<CatchUpFacts> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id === userId) throw new DomainError('FORBIDDEN', 403, 'The meeting recorder does not need a catch-up; this card is for readers');
    const data = await readPublishedForCatchUp(ctx, input.meetingId);
    if (!data) throw new DomainError('CATCH_UP_NOT_PUBLISHED', 422, 'Meeting minutes are not published yet');
    if (data.redacted) throw new DomainError('CATCH_UP_REDACTED', 422, 'Meeting minutes contain redacted content');
    const meetingRow = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select('language')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    const askerName = await askerDisplayName(ctx, userId);
    return {
      meetingId: input.meetingId,
      language: meetingRow.language === 'en' ? 'en' : 'vi',
      askerName,
      summary: data.published.summary,
      decisions: data.published.decisions,
      items: data.items.map((row) => ({
        id: row.id,
        title: row.title,
        who: row.who_drafted,
        when: row.when_drafted,
        isYours: matchCatchUpItem(row, userId, askerName) !== null,
      })),
    };
  },
});

/** Starts the reader's own ephemeral Vy run under meetings.catch_up after enforcing all gates. */
const catchUpStart = defineCommand({
  name: 'meetings.catch_up.start',
  input: zMeetingRef,
  output: zCatchUpStarted,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id === userId) throw new DomainError('FORBIDDEN', 403, 'The meeting recorder does not need a catch-up; this card is for readers');
    const data = await readPublishedForCatchUp(ctx, input.meetingId);
    if (!data) throw new DomainError('CATCH_UP_NOT_PUBLISHED', 422, 'Meeting minutes are not published yet');
    if (data.redacted) throw new DomainError('CATCH_UP_REDACTED', 422, 'Meeting minutes contain redacted content');
    const vy = await vyReason(ctx);
    if (vy === 'off') throw new DomainError('CATCH_UP_OFF', 422, 'Vy catch-up is turned off for this workspace');
    if (vy === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'You do not have permission to use Vy');
    if (vy === 'paused' || vy === 'budget') throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy is paused or out of monthly AI budget');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', {
      feature: CATCH_UP_FEATURE,
      subjectType: CATCH_UP_FEATURE,
      subjectId: randomUUID(),
    });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return { meetingId: input.meetingId, runId: started.runId };
  },
});

export const catchUpCommands = [catchUpStart];
export const catchUpQueries = [catchUpStatus, catchUpFacts];
