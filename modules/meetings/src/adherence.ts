// SPDX-License-Identifier: AGPL-3.0-only
// Agenda adherence, the module's side (#3959): "did the meeting cover what it was meant to". It is the recorder's own click and no private Vy result row is read: the facts are read by code in the recorder's own
// transaction, and the start of the run is the recorder's own click. Nothing is stored.
//
// meetings.adherence.agenda  for a meeting: the open items of the series as of the previous meeting (the same pick as the brief and the series' open items, #3542), and whether the recorder's transcript is there
//                            and short enough for the check. It works with AI off, so the recorder sees the agenda list either way. Only the recorder gets anything; any other member gets an empty answer.
// meetings.adherence.facts   for one check: the agenda lines (up to 8 the recorder typed, then the open items, 12 at most) and the numbered transcript lines the recorder reads, each cleaned and cut. Recorder only.
//                            `eligible` is false when there is nothing to ask: no agenda line, no transcript, or a transcript longer than the model is given (never cut).
// meetings.adherence.status  whether Vy may be asked now (the same switches as asking across meetings), for the recorder of the meeting.
// meetings.adherence.start   starts the recorder's own Vy run for one check (the kernel's run.start checks vy.use, the kill switches and the budget).
// The model call, the checks on its answer and the counts-only result row are in apps/kernel (member-vy-ports.ts) and packages/agent (member-vy/meetings-adherence.ts).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  ADHERENCE_AGENDA_MAX,
  ADHERENCE_LINE_CHARS,
  ADHERENCE_TRANSCRIPT_BYTES_MAX,
  ADHERENCE_TRANSCRIPT_LINES_MAX,
  ADHERENCE_TRANSCRIPT_LINE_CHARS,
  zAdherenceAgenda,
  zAdherenceAsk,
  zAdherenceFacts,
  zAdherenceRef,
  zAdherenceStatus,
  zAskStarted,
  type AdherenceAgenda,
  type AdherenceAgendaLine,
  type AdherenceFacts,
  type AdherenceStatus,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { vyReason } from './ask.ts';
import { openItemsOf, previousMeetingOf } from './series.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const ADHERENCE_FEATURE = 'meetings.adherence';
type Trx = QueryContext['trx'];

// One line of text as the model and the page read it: control, format and line-break characters gone, runs of white space one space, cut at a character count (never inside a surrogate pair).
const oneLine = (value: string, max: number): string => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()).slice(0, max).join('');

// The open items of the series as of the previous meeting, as agenda lines: the title only (an item's person, date and task status are not agenda).
async function openItemLines(trx: Trx, orgId: string, meetingId: string): Promise<{ previous: { id: string; title: string; at: Date } | null; lines: string[] }> {
  const meeting = await trx
    .selectFrom('crove_meetings.meeting')
    .select(['series_id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
    .where('org_id', '=', orgId)
    .where('id', '=', meetingId)
    .executeTakeFirstOrThrow();
  if (meeting.series_id === null) return { previous: null, lines: [] };
  const previous = await previousMeetingOf(trx, orgId, meeting.series_id, meeting.at, meetingId);
  if (!previous) return { previous: null, lines: [] };
  const items = await openItemsOf(trx, orgId, previous.id);
  return { previous, lines: items.map((item) => oneLine(item.title, ADHERENCE_LINE_CHARS)).filter((line) => line !== '') };
}

// The lines the recorder reads as the transcript: while a draft exists it is the draft, else the published lines (the two never both, so a line is not counted twice).
async function transcriptOf(trx: Trx, orgId: string, meetingId: string, limit: number): Promise<{ startSeconds: number; text: string; stage: string }[]> {
  const rows = await trx
    .selectFrom('crove_meetings.transcript_segment')
    .select([sql<string>`start_seconds::text`.as('start_seconds'), 'text', 'stage'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .orderBy('start_seconds')
    .orderBy('id')
    .limit(limit)
    .execute();
  const stage = rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
  return rows.filter((r) => r.stage === stage).map((r) => ({ startSeconds: Number(r.start_seconds), text: r.text, stage: r.stage }));
}

export const adherenceAgenda = defineQuery({
  name: 'meetings.adherence.agenda',
  input: zAdherenceRef,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<AdherenceAgenda> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const empty = (): AdherenceAgenda => zAdherenceAgenda.parse({ meetingId: input.meetingId, previous: null, items: [], transcriptLines: 0, transcriptFits: false });
    if (meeting.recorder_user_id !== userId) return empty();
    const { previous, lines } = await openItemLines(ctx.trx, ctx.orgId, input.meetingId);
    // Counted in the database over the lines the recorder reads (the draft, else the published ones), so a very long transcript is never loaded to be counted.
    const counted = await sql<{ n: string; bytes: string }>`
      WITH s AS (
        SELECT text, stage FROM crove_meetings.transcript_segment WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${input.meetingId}::uuid
      ), pick AS (
        SELECT text FROM s WHERE stage = CASE WHEN EXISTS (SELECT 1 FROM s WHERE stage = 'draft') THEN 'draft' ELSE 'published' END
      )
      SELECT count(*)::text AS n, coalesce(sum(least(octet_length(text), ${ADHERENCE_TRANSCRIPT_LINE_CHARS * 4})), 0)::text AS bytes FROM pick`.execute(ctx.trx);
    const n = Number(counted.rows[0]?.n ?? 0);
    const bytes = Number(counted.rows[0]?.bytes ?? 0);
    return zAdherenceAgenda.parse({
      meetingId: input.meetingId,
      previous: previous ? { meetingId: previous.id, title: previous.title, startedAt: previous.at.toISOString() } : null,
      items: lines.slice(0, ADHERENCE_AGENDA_MAX).map((text) => ({ text })),
      transcriptLines: n,
      transcriptFits: n > 0 && n <= ADHERENCE_TRANSCRIPT_LINES_MAX && bytes <= ADHERENCE_TRANSCRIPT_BYTES_MAX,
    });
  },
});

export const adherenceFacts = defineQuery({
  name: 'meetings.adherence.facts',
  input: zAdherenceAsk,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<AdherenceFacts> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to check its agenda');
    const none = (reason: 'no_agenda' | 'no_transcript' | 'too_long'): AdherenceFacts => zAdherenceFacts.parse({ eligible: false, reason, agenda: [], transcript: [] });
    // The typed lines first (what the recorder meant), then the open items of the series; a line that repeats an earlier one (case and marks folded away) is dropped.
    const typed = input.typed.map((t) => oneLine(t, ADHERENCE_LINE_CHARS)).filter((t) => t !== '');
    const { lines: items } = await openItemLines(ctx.trx, ctx.orgId, input.meetingId);
    const seen = new Set<string>();
    const agenda: AdherenceAgendaLine[] = [];
    for (const [text, source] of [...typed.map((t) => [t, 'typed'] as const), ...items.map((t) => [t, 'open_item'] as const)]) {
      const key = text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
      if (seen.has(key) || agenda.length >= ADHERENCE_AGENDA_MAX) continue;
      seen.add(key);
      agenda.push({ n: agenda.length + 1, text, source });
    }
    if (agenda.length === 0) return none('no_agenda');
    const rows = await transcriptOf(ctx.trx, ctx.orgId, input.meetingId, ADHERENCE_TRANSCRIPT_LINES_MAX + 1);
    if (rows.length === 0) return none('no_transcript');
    if (rows.length > ADHERENCE_TRANSCRIPT_LINES_MAX) return none('too_long');
    const transcript = rows.map((r, index) => ({ n: index + 1, startSeconds: r.startSeconds, text: oneLine(r.text, ADHERENCE_TRANSCRIPT_LINE_CHARS) }));
    if (transcript.reduce((sum, line) => sum + Buffer.byteLength(line.text, 'utf8'), 0) > ADHERENCE_TRANSCRIPT_BYTES_MAX) return none('too_long');
    return zAdherenceFacts.parse({ eligible: true, reason: null, agenda, transcript });
  },
});

// Whether Vy may be asked now: the deployment's switch, the recorder's right to work with Vy, a kill switch of the org, the meetings module or the operator, and this month's budget. The kernel's run.start decides
// again at the click, so this is the answer for the button, not the gate. The expected cost is added by the route, which knows the prices.
export const adherenceStatus = defineQuery({
  name: 'meetings.adherence.status',
  input: zAdherenceRef,
  access: ROLES,
  handler: async (ctx, input): Promise<AdherenceStatus> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const reason = meeting.recorder_user_id !== userId ? ('not_recorder' as const) : await vyReason(ctx);
    return zAdherenceStatus.parse({ meetingId: input.meetingId, enabled: reason === null, reason, estimate: null });
  },
});

// Starts the recorder's own Vy run for one check: the recorder of the meeting only, with the deployment's switch on. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global
// ai switch and the budget, makes the member's Vy and this run, and binds the run to a fresh subject ('meetings.adherence' and an id no screen sees). Nothing is read or sent here, and the run's result row will hold
// counts only (the route stores them), never an agenda line or a transcript line.
export const adherenceStart = defineCommand({
  name: 'meetings.adherence.start',
  input: zAdherenceRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('ADHERENCE_OFF', 422, 'Vy checking an agenda is not turned on here');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to check its agenda');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: ADHERENCE_FEATURE, subjectType: ADHERENCE_FEATURE, subjectId: randomUUID() });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return zAskStarted.parse({ runId: started.runId });
  },
});

export const adherenceCommands = [adherenceStart];
export const adherenceQueries = [adherenceAgenda, adherenceFacts, adherenceStatus];
