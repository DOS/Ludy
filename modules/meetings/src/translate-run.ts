// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy translating the summary of a meeting, the parts that never read a private result row (meetings integrations E1, #3184, plan section 7a, ADR-0049 stage A):
// what the member may translate (the text they read, in their own context), the button's status, the start of the run and the member's own translations. The copy of a
// finished result into the member's private translation row, which reads the result, is in translate.ts. A translation is the member's alone: no task, mail, post, webhook,
// search hit or export reads it, and only the commands of these two files and the database's own purge and erasure functions touch the table.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import {
  zMeetingRef,
  zTranslateStart,
  zTranslateStarted,
  zTranslationRef,
  zTranslationSource,
  zTranslationStatus,
  zTranslations,
  type MeetingLanguage,
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
  input: zTranslateStart,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
    // The same read the run will make: a reader of the stage with text to translate, or a refusal before any run exists.
    await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, input.stage);
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

export const translateRunCommands = [translateStart];
export const translateRunQueries = [translationSource, translationStatus, translationGet];
