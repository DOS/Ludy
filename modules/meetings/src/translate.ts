// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy translating the summary of a meeting, the module's side (meetings integrations E1, #3184, plan section 7a, ADR-0049 decision 8). The model's answer lands in the
// member's own Vy result (the row is sealed to them). This command is the member's own click that keeps it: one private row for the member, meeting, stage and language,
// marked as the model's text (tainted) for as long as it exists, named after the run it came from. The row is read by the member alone (row security), shown beside the original as
// "Bản dịch máy", and never the source of anything: no task, mail, post, webhook, search hit or export is made from it. Code, not the model, decided in the agent package what
// each segment shows (a refused segment holds no text); here the answer is read back strictly and held to the text the member reads now.
import { sql } from 'kysely';
import { zTranslationCopy, zTranslationCopied, zTranslationResult } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { TRANSLATE_FEATURE, readTranslationSource } from './translate-run.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

const notFound = () => new DomainError('TRANSLATION_RESULT_NOT_FOUND', 404, 'No translation result for this meeting');

export const translationCopyResult = defineCommand({
  name: 'meetings.translation.copy_result',
  input: zTranslationCopy,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    // The member's own result, read in the member's own context (the row is sealed to its member). A run of another meeting or feature is not this one.
    const found = await ctx
      .query<{ status: string; feature: string; subjectType: string; subjectId: string; body: string | null; expiresAt: string }>('kernel.member_vy.result.get', { runId: input.runId })
      .catch((error: unknown) => {
        // The kernel's own refusal for a run that is not the caller's or does not exist.
        if (error instanceof DomainError && error.code === 'RESULT_NOT_FOUND') throw notFound();
        throw error;
      });
    if (found.status !== 'ok') throw notFound();
    const result = found.value;
    if (result.feature !== TRANSLATE_FEATURE || result.subjectType !== 'meeting' || result.subjectId !== input.meetingId) throw notFound();
    // An answer past its expiry is gone for the member, as the kernel's own read treats it.
    if (new Date(result.expiresAt).getTime() <= ctx.now.getTime()) throw notFound();
    if (result.status !== 'ready' || result.body === null) throw new DomainError('TRANSLATION_RESULT_NOT_READY', 409, 'The translation is not finished');
    // The body is the model's, checked once by the agent package; it is read back strictly here and never trusted for its shape.
    let body;
    try {
      body = zTranslationResult.parse(JSON.parse(result.body));
    } catch {
      throw new DomainError('TRANSLATION_RESULT_INVALID', 422, 'The translation result cannot be read');
    }
    // Held to what the member reads NOW: the same original (its hash), the language pair of the meeting and the same segments in the same order. A summary edited, replaced or
    // unpublished while the model worked makes the answer stale, and a stale answer is never kept as if it were of the text on screen.
    const source = await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, body.stage).catch((error: unknown) => {
      if (error instanceof DomainError && (error.code === 'TRANSLATION_NOT_FOUND' || error.code === 'TRANSLATION_NOTHING')) throw new DomainError('TRANSLATION_STALE', 409, 'The summary changed while it was being translated; translate again');
      throw error;
    });
    if (source.hash !== body.hash || source.from !== body.from || source.to !== body.to || source.segments.length !== body.segments.length || source.segments.some((s, i) => s.key !== body.segments[i]?.key)) {
      throw new DomainError('TRANSLATION_STALE', 409, 'The summary changed while it was being translated; translate again');
    }
    // One translation for the member, meeting, stage and language: a new one replaces the earlier (the member asked again), and the model's text stays tainted.
    await ctx.trx
      .deleteFrom('crove_meetings.translation')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('member_user_id', '=', userId)
      .where('kind', '=', 'summary')
      .where('target_language', '=', body.to)
      .where('source_stage', '=', body.stage)
      .execute();
    await ctx.trx
      .insertInto('crove_meetings.translation')
      .values({
        org_id: ctx.orgId,
        meeting_id: input.meetingId,
        member_user_id: userId,
        kind: 'summary',
        target_language: body.to,
        source_stage: body.stage,
        source_hash: body.hash,
        body: sql`${JSON.stringify(body.segments)}::jsonb`,
        tainted: true,
        source_run_id: input.runId,
      })
      .execute();
    const refused = body.segments.filter((s) => s.state === 'refused').length;
    const warned = body.segments.filter((s) => s.state === 'warn').length;
    // Ids, the stage, the language and counts: never a word of either text (the audit trail is anchored and cannot be erased).
    ctx.audit({ meetingId: input.meetingId, runId: input.runId, stage: body.stage, language: body.to, segments: body.segments.length, refused, warned });
    return zTranslationCopied.parse({ meetingId: input.meetingId, stage: body.stage, segments: body.segments.length, refused, warned });
  },
});

export const translateCommands = [translationCopyResult];
