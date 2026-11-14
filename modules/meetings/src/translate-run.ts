// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy translating the summary of a meeting, the parts that never read a private result row (meetings integrations E1, #3184, plan section 7a, ADR-0049 stage A):
// what the member may translate (the text they read, in their own context), the button's status, the start of the run and the member's own translations. The copy of a
// finished result into the member's private translation row, which reads the result, is in translate.ts. A translation is the member's alone: no task, mail, post, webhook,
// search hit or export reads it, and only the commands of these two files and the database's own purge and erasure functions touch the table.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import {
  TRANSCRIPT_TRANSLATE_CHUNKS_PER_RUN,
  TRANSCRIPT_TRANSLATE_CHUNK_BYTES,
  zMeetingRef,
  zTranscriptParts,
  zTranscriptTranslateStarted,
  zTranscriptTranslateStopped,
  zTranscriptTranslationStatus,
  zTranscriptTranslationView,
  zTranslateStarted,
  zTranslationRef,
  zTranslationSource,
  zTranslationStatus,
  zTranslations,
  type MeetingLanguage,
  type TranscriptPart,
  type TranscriptTranslationStatus,
  type TranscriptTranslationView,
  type TranslationSegment,
  type TranslationSource,
  type Translations,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const TRANSLATE_FEATURE = 'meetings.translate';
type Trx = QueryContext['trx'];
type Stage = 'draft' | 'published';

// One start or stop of a member's translation at a time: a transaction-level advisory lock per (org, member), as the transcription's (#3033). Without it two starts (two tabs) both pass the
// "a run is live" check before either commits, and the second supersedes the first run. Released at commit or rollback.
async function lockTranslation(trx: Trx, orgId: string, userId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.translate:${orgId}:${userId}`}, 0))`.execute(trx);
}

const otherLanguage = (language: MeetingLanguage): MeetingLanguage => (language === 'vi' ? 'en' : 'vi');
const notFound = () => new DomainError('TRANSLATION_NOT_FOUND', 404, 'There is no summary to translate');

/** The hash of the text a translation was made from: a changed original has another one, and the translation then reads as stale. Not a secret; the text is never recoverable from it. */
export function translationHash(segments: ReadonlyArray<{ key: string; text: string }>): string {
  return createHash('sha256').update(JSON.stringify(segments.map((s) => [s.key, s.text]))).digest('hex');
}

/** The size of what a translation sends to the model, in UTF-8 bytes (the numbered JSON of the segments): the route turns it into the cost shown before the click, without reading the text. */
export function translationBytes(segments: ReadonlyArray<{ text: string }>): number {
  return new TextEncoder().encode(JSON.stringify(segments.map((s, index) => ({ n: index + 1, text: s.text })))).length;
}

/**
 * The text of a stage of the meeting's summary that the caller reads, as the segments the model gets and the screen shows beside the translation: the summary, each decision and
 * the title of each action item of that stage (who and when stay as said). The rows are read under the caller's own row security: the published stage by any reader and the
 * recorder, the draft by the recorder alone, so a non-reader, an owner or an admin who is not a reader, finds nothing here and meets the same answer as for no summary.
 */
export async function readTranslationSource(trx: Trx, orgId: string, userId: string, meetingId: string, stage: Stage): Promise<TranslationSource> {
  const meeting = await trx.selectFrom('crove_meetings.meeting').select(['id', 'recorder_user_id', 'language']).where('org_id', '=', orgId).where('id', '=', meetingId).executeTakeFirst();
  // The text-retention gate, as for every other read of a meeting's text.
  await openMeeting(trx, orgId, meetingId);
  if (!meeting) throw notFound();
  if (stage === 'draft' && meeting.recorder_user_id !== userId) throw notFound();
  const result = await trx
    .selectFrom('crove_meetings.meeting_result')
    .select(['summary', 'decisions'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .executeTakeFirst();
  const items = await trx
    .selectFrom('crove_meetings.action_item')
    .select(['id', 'title'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', stage)
    .orderBy('transcript_seconds')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const segments: Array<{ key: string; text: string }> = [];
  if (result) {
    if (result.summary.trim() !== '') segments.push({ key: 'summary', text: result.summary });
    (Array.isArray(result.decisions) ? (result.decisions as unknown[]) : []).forEach((decision, index) => {
      if (typeof decision === 'string' && decision.trim() !== '') segments.push({ key: `decision:${index}`, text: decision });
    });
  }
  for (const item of items) if (item.title.trim() !== '') segments.push({ key: `item:${item.id}`, text: item.title });
  if (segments.length === 0) throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no summary to translate');
  const from = meeting.language as MeetingLanguage;
  return zTranslationSource.parse({ meetingId, stage, from, to: otherLanguage(from), hash: translationHash(segments), segments });
}

// The text the caller may translate (a read of the meeting's summary, so it is a sensitive read like meetings.result.get).
export const translationSource = defineQuery({
  name: 'meetings.translation.source',
  input: zTranslationRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TranslationSource> => readTranslationSource(ctx.trx, ctx.orgId, userOf(ctx.actor), input.meetingId, input.stage),
});

// What the button of a stage shows: whether the deployment lets Vy translate and whether there is text to translate. The expected cost is added by the route (it knows the prices).
export const translationStatus = defineQuery({
  name: 'meetings.translation.status',
  input: zTranslationRef,
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const row = await ctx.trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    const from = row.language as MeetingLanguage;
    let reason: 'off' | 'nothing' | null = isSummaryEnabled() ? null : 'off';
    let bytes = 0;
    if (reason === null) {
      try {
        bytes = translationBytes((await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, input.stage)).segments);
      } catch (error: unknown) {
        // A stage the caller does not read (another member's draft) stays a 404 (TRANSLATION_NOT_FOUND): only a stage they read with no text is "nothing".
        if (!(error instanceof DomainError) || error.code !== 'TRANSLATION_NOTHING') throw error;
        reason = 'nothing';
      }
    }
    // `bytes` is for the route only (it prices it); it is a size, never text.
    return { ...zTranslationStatus.parse({ meetingId: input.meetingId, stage: input.stage, enabled: reason === null, reason, from, to: otherLanguage(from), estimate: null }), bytes };
  },
});

// Starts the member's own Vy run for a translation of the summary they read: any member who reads the stage (the recorder for their draft), with the deployment's switch on
// and text to translate. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and the budget, makes the member's Vy and
// this run, and binds the run's subject to this meeting; nothing is read or sent here. The route that calls the model (apps/kernel) runs this first and reads the text after.
export const translateStart = defineCommand({
  name: 'meetings.translate.start',
  input: zTranslationRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
    // The same read the run will make: a reader of the stage with text to translate, or a refusal before any run exists.
    await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, input.stage);
    // A member has one translation run at a time (#3185): the kernel's start would cancel a live run of this feature, and a transcript translation takes minutes and costs budget,
    // so it is refused here instead of cut off.
    await lockTranslation(ctx.trx, ctx.orgId, userId);
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: TRANSLATE_FEATURE });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSLATE_RUNNING', 409, 'A translation of yours is still running; wait for it to finish or stop it');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: TRANSLATE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    ctx.audit({ meetingId: input.meetingId, stage: input.stage, runId: started.runId });
    return zTranslateStarted.parse({ meetingId: input.meetingId, runId: started.runId });
  },
});

// The caller's own translations of the meeting: row security shows a member their own rows, of a stage they still read, and nobody else's. A translation is stale when the original
// it was made from has changed since (its hash is not the original's now): the screen shows it as "Bản dịch cũ, dịch lại".
export const translationGet = defineQuery({
  name: 'meetings.translation.get',
  input: zMeetingRef,
  access: ROLES,
  // The translated text is read here, so each read leaves an audit row naming the meeting (as meetings.result.get does).
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<Translations> => {
    const userId = userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('crove_meetings.translation')
      .select(['source_stage', 'target_language', 'source_hash', 'body', sql<string>`created_at::text`.as('created_at')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('member_user_id', '=', userId)
      .where('kind', '=', 'summary')
      .orderBy('source_stage')
      .execute();
    const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    const from = meeting.language as MeetingLanguage;
    const translations: Translations['translations'] = [];
    for (const row of rows) {
      const stage = row.source_stage as Stage;
      let stale = true;
      try {
        stale = (await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, stage)).hash !== row.source_hash;
      } catch (error: unknown) {
        // The original is gone or no longer readable: the translation is stale (the database deletes it with the original, so this is the narrow window before that).
        if (!(error instanceof DomainError)) throw error;
      }
      translations.push({
        stage,
        from,
        to: row.target_language as MeetingLanguage,
        stale,
        createdAt: row.created_at,
        segments: Array.isArray(row.body) ? (row.body as TranslationSegment[]) : [],
      });
    }
    return zTranslations.parse({ meetingId: input.meetingId, translations });
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The transcript (meetings integrations E2, #3185): a background run of the member's Vy over chunks of the lines the member reads
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// A run takes the next batch of lines that have no current translation (at most TRANSCRIPT_TRANSLATE_CHUNKS_PER_RUN chunks), so what an earlier run kept is never paid for twice and a
// run that stops (a refused chunk, a stop, a lost job) loses nothing but the batch in flight. The run reads the text through the door the kernel gives it (it reads no table); the
// member's own copy command (translate.ts) keeps its parts in the member's row. Nothing here reads a private result row: the state of a run is the kernel's own (run.latest).

/** The hash of a line's text a stored part names it by (the first 16 hex digits of its sha256): a corrected line has another one and its part then reads as stale. The run computes the same. */
export function lineHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const utf8 = new TextEncoder();
// The weight of a line in a chunk and the cut into chunks: the rule of the agent package's planTranscriptChunks (a test ties the two), so the figures shown before the click are what is sent.
const lineWeight = (text: string): number => utf8.encode(JSON.stringify(text)).length + 14;
function chunkLines<T extends { text: string }>(lines: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const line of lines) {
    const weight = lineWeight(line.text);
    if (current.length > 0 && bytes + weight > TRANSCRIPT_TRANSLATE_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += weight;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
// The most lines one run's event carries (ids only, never text).
const BATCH_LINES_MAX = 400;

export interface TranscriptLine {
  id: string;
  text: string;
}
export interface TranscriptRead {
  stage: Stage;
  from: MeetingLanguage;
  to: MeetingLanguage;
  lines: TranscriptLine[];
}

/**
 * The transcript lines the caller reads, in the order the screen shows them: the recorder reads the draft (when there is one), anyone else the published lines (row security shows a
 * draft to its recorder only, so a non-reader meets the same answer as for no transcript). Null when there is nothing to translate.
 */
export async function readTranscriptLines(trx: Trx, orgId: string, meetingId: string): Promise<TranscriptRead | null> {
  const meeting = await trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', orgId).where('id', '=', meetingId).executeTakeFirst();
  // The text-retention gate, as for every other read of a meeting's text.
  await openMeeting(trx, orgId, meetingId);
  if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
  const rows = await trx
    .selectFrom('crove_meetings.transcript_segment')
    .select(['id', 'text', 'stage'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .orderBy('start_seconds')
    .orderBy('id')
    .execute();
  const stage: Stage = rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
  const lines = rows.filter((r) => r.stage === stage).map((r) => ({ id: r.id, text: r.text }));
  if (lines.length === 0) return null;
  const from = meeting.language as MeetingLanguage;
  return { stage, from, to: otherLanguage(from), lines };
}

// The member's kept parts for this transcript (an empty list when they have none): the row of the stage and language, read in the member's own context.
export async function keptParts(trx: Trx, orgId: string, userId: string, meetingId: string, stage: Stage, to: MeetingLanguage): Promise<{ parts: TranscriptPart[]; runId: string | null }> {
  const row = await trx
    .selectFrom('crove_meetings.translation')
    .select(['body', 'source_run_id'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('member_user_id', '=', userId)
    .where('kind', '=', 'transcript')
    .where('target_language', '=', to)
    .where('source_stage', '=', stage)
    .executeTakeFirst();
  if (!row) return { parts: [], runId: null };
  const parsed = zTranscriptParts.safeParse(row.body);
  return { parts: parsed.success ? parsed.data : [], runId: row.source_run_id };
}

/** Whether a line still needs a translation: it has no kept part, its part is of an older text, or the model skipped it last time (a refusal for any other reason is final: asking again would only spend budget). */
function needsTranslation(line: TranscriptLine, part: TranscriptPart | undefined): boolean {
  if (!part || part.h !== lineHash(line.text)) return true;
  return part.s === 'refused' && part.c.includes('MISSING');
}

async function transcriptState(ctx: { trx: Trx; orgId: string }, userId: string, meetingId: string, read: TranscriptRead) {
  const kept = await keptParts(ctx.trx, ctx.orgId, userId, meetingId, read.stage, read.to);
  const byLine = new Map(kept.parts.map((p) => [p.k, p]));
  let translated = 0;
  let stale = 0;
  const remaining: TranscriptLine[] = [];
  for (const line of read.lines) {
    const part = byLine.get(line.id);
    if (needsTranslation(line, part)) remaining.push(line);
    if (part && part.h === lineHash(line.text)) translated += 1;
    else if (part) stale += 1;
  }
  return { kept, byLine, translated, stale, remaining };
}

// What the button and the progress line of the transcript show: whether the deployment lets Vy translate, how far the member's translation has got, the state of their latest run and what is
// left to send. The text itself is not returned: the route prices the sizes (`bytes` is for it only).
export const transcriptTranslationStatus = defineQuery({
  name: 'meetings.translation.transcript_status',
  input: zMeetingRef,
  access: ROLES,
  handler: async (ctx, input): Promise<TranscriptTranslationStatus & { bytes: number }> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    const from = meeting.language as MeetingLanguage;
    const empty = { meetingId: input.meetingId, stage: null, from, to: otherLanguage(from), lines: 0, translated: 0, stale: 0, remaining: 0, chunksTotal: 0, chunksDone: 0, state: 'none' as const, runId: null, errorCode: null, needsCopy: false, estimate: null };
    const read = await readTranscriptLines(ctx.trx, ctx.orgId, input.meetingId);
    const off = !isSummaryEnabled();
    if (!read) return { ...zTranscriptTranslationStatus.parse({ ...empty, enabled: false, reason: off ? 'off' : 'nothing' }), bytes: 0 };
    const state = await transcriptState(ctx, userId, input.meetingId, read);
    const chunksTotal = chunkLines(read.lines).length;
    const chunksLeft = chunkLines(state.remaining).length;
    const latest = await ctx.query<{ runId: string; state: 'running' | 'ready' | 'failed'; errorCode: string | null } | null>('kernel.member_vy.run.latest', { feature: TRANSLATE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    const run = latest.status === 'ok' ? latest.value : null;
    // A finished run whose parts are not kept yet (the page asks for the copy once). A summary translation of this meeting is a run of the same feature: its row names it, so it is not asked for again.
    const summaryRuns = await ctx.trx
      .selectFrom('crove_meetings.translation')
      .select('source_run_id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('member_user_id', '=', userId)
      .where('kind', '=', 'summary')
      .execute();
    const copied = run !== null && (run.runId === state.kept.runId || summaryRuns.some((r) => r.source_run_id === run.runId));
    const bytes = state.remaining.reduce((n, l) => n + lineWeight(l.text), 0);
    return {
      ...zTranscriptTranslationStatus.parse({
        meetingId: input.meetingId,
        stage: read.stage,
        enabled: !off,
        reason: off ? 'off' : null,
        from: read.from,
        to: read.to,
        lines: read.lines.length,
        translated: state.translated,
        stale: state.stale,
        remaining: state.remaining.length,
        chunksTotal,
        chunksDone: chunksTotal - chunksLeft,
        state: run?.state ?? 'none',
        runId: run?.runId ?? null,
        errorCode: run?.errorCode ?? null,
        needsCopy: run !== null && run.state === 'ready' && !copied,
        estimate: null,
      }),
      bytes,
    };
  },
});

// The member's own translated parts of the transcript they read, one per line: row security shows a member their own row, of a stage they still read, and nobody else's. A part is stale
// when the line's text changed since (its hash is not the line's now): the screen shows it as "Bản dịch cũ, dịch lại".
export const transcriptTranslationGet = defineQuery({
  name: 'meetings.translation.transcript_get',
  input: zMeetingRef,
  access: ROLES,
  // The translated text is read here, so each read leaves an audit row naming the meeting (as meetings.translation.get does).
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TranscriptTranslationView> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    const from = meeting.language as MeetingLanguage;
    const read = await readTranscriptLines(ctx.trx, ctx.orgId, input.meetingId);
    if (!read) return zTranscriptTranslationView.parse({ meetingId: input.meetingId, stage: null, from, to: otherLanguage(from), parts: [] });
    const kept = await keptParts(ctx.trx, ctx.orgId, userId, input.meetingId, read.stage, read.to);
    const byLine = new Map(kept.parts.map((p) => [p.k, p]));
    const parts: TranscriptTranslationView['parts'] = [];
    for (const line of read.lines) {
      const part = byLine.get(line.id);
      if (part) parts.push({ lineId: line.id, text: part.t, state: part.s, codes: part.c, stale: part.h !== lineHash(line.text) });
    }
    return zTranscriptTranslationView.parse({ meetingId: input.meetingId, stage: read.stage, from: read.from, to: read.to, parts });
  },
});

// Starts the member's own Vy run over the next batch of lines they read that still need a translation: any member who reads the stage (the recorder for their draft), with the switch on.
// The kernel's run.start checks vy.use, the org, module and agent kill switches, the global ai switch and the budget, makes the member's Vy and this run and binds its subject to this
// meeting; the event carries ids only (the meeting, the run, the agent, the stage and the ids of the lines), and the worker reads the text through the door. A member has one translation
// run at a time (the summary's included): a live one refuses this start. The click is the person's approval of the spend (R2, as the transcription's start).
export const transcriptTranslateStart = defineCommand({
  name: 'meetings.translation.transcript_start',
  input: zMeetingRef,
  risk: 'R2',
  sideEffect: 'external',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    // The meeting row is held while the run is made, so a delete that races this start waits for it (and then removes the run through the trigger).
    await ctx.trx.selectFrom('crove_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    const read = await readTranscriptLines(ctx.trx, ctx.orgId, input.meetingId);
    if (!read) throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no transcript to translate');
    const state = await transcriptState(ctx, userId, input.meetingId, read);
    if (state.remaining.length === 0) throw new DomainError('TRANSLATION_DONE', 409, 'The transcript is already translated');
    // The next batch: the first chunks of what is left, whole (the run cuts the lines it is given by the same rule, so it sends exactly these chunks and no chunk is split between two runs),
    // at most the chunks one run takes and never more lines than the event carries.
    const batch: TranscriptLine[] = [];
    for (const chunk of chunkLines(state.remaining).slice(0, TRANSCRIPT_TRANSLATE_CHUNKS_PER_RUN)) {
      if (batch.length > 0 && batch.length + chunk.length > BATCH_LINES_MAX) break;
      batch.push(...chunk);
    }
    await lockTranslation(ctx.trx, ctx.orgId, userId);
    const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: TRANSLATE_FEATURE });
    if (live.status !== 'ok' || live.value.live) throw new DomainError('TRANSLATE_RUNNING', 409, 'A translation of yours is still running; wait for it to finish or stop it');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: TRANSLATE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    const agent = await ctx.trx
      .selectFrom('crove_kernel.agent')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'member_vy')
      .where('member_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    await ctx.emit('meetings.translate_run.requested', { meetingId: input.meetingId, runId: started.runId, agentId: agent.id, memberUserId: userId, stage: read.stage, lineIds: batch.map((l) => l.id) });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId, stage: read.stage, lines: batch.length });
    return zTranscriptTranslateStarted.parse({ meetingId: input.meetingId, runId: started.runId, lines: batch.length });
  },
});

// Stops the member's own translation run of this meeting (the kernel command ends a running run of the caller's own Vy and answers the same for any other): the batch in flight is lost, the
// parts earlier runs kept stay. Spends nothing and sends nothing: the member's own click (R1).
export const transcriptTranslateStop = defineCommand({
  name: 'meetings.translation.transcript_stop',
  input: zMeetingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    await lockTranslation(ctx.trx, ctx.orgId, userId);
    const latest = await ctx.query<{ runId: string } | null>('kernel.member_vy.run.latest', { feature: TRANSLATE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    if (latest.status !== 'ok' || latest.value === null) return zTranscriptTranslateStopped.parse({ meetingId: input.meetingId, stopped: false });
    const stopped = await ctx.run<{ cancelled: boolean }>('kernel.member_vy.run.cancel', { runId: latest.value.runId });
    ctx.audit({ meetingId: input.meetingId, runId: latest.value.runId, cancelled: stopped.cancelled });
    return zTranscriptTranslateStopped.parse({ meetingId: input.meetingId, stopped: stopped.cancelled });
  },
});

export const translateRunCommands = [translateStart, transcriptTranslateStart, transcriptTranslateStop];
export const translateRunQueries = [translationSource, translationStatus, translationGet, transcriptTranslationStatus, transcriptTranslationGet];
