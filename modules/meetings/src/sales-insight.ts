// SPDX-License-Identifier: AGPL-3.0-only
// Sales call insights for a meeting linked to an open deal (#4920, L26, ADR-0049):
//   meetings.sales_insight.status   recorder only (non-recorders get 404); checks open linked deal (via crm.deal.get / crm.stage.list, never mutating CRM), transcript present, not transcribing, and Vy readiness.
//   meetings.sales_insight.facts    route-only audited read of transcript segments (with IDs), deal context and mapped internal/customer names for talk-share calculation.
//   meetings.sales_insight.start    recorder only; locks meeting/media (#3187), starts ephemeral member_vy run under meetings.sales_insight (randomUUID subject) and marks audio used.
import { randomUUID } from 'node:crypto';
import { zSalesInsightStatus, zMeetingRef, type SalesInsightStatus } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { lockMeetingMedia, markAudioUsed } from './media-record.ts';
import { memberNames } from './results.ts';
import { attendeeNames } from './speaker.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { openMeeting, ROLES, userOf } from './transcript.ts';

export const SALES_INSIGHT_FEATURE = 'meetings.sales_insight';

type Trx = QueryContext['trx'];

export interface SalesInsightSegmentFact {
  id: string;
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}

export interface SalesInsightFactsRead {
  meetingId: string;
  language: 'vi' | 'en';
  deal: { id: string; title: string; stage: string };
  segments: SalesInsightSegmentFact[];
  speakerMapping: {
    internalNames: string[];
    customerNames: string[];
  };
}

type LinkedDealResult =
  | { ok: true; deal: { id: string; title: string; stage: string; partyId: string } }
  | { ok: false; reason: 'no_crm' | 'no_deal' | 'deal_closed' };

async function linkedOpenDeal(ctx: { trx: Trx; orgId: string; query: QueryContext['query'] }, meetingId: string): Promise<LinkedDealResult> {
  const link = await ctx.trx
    .selectFrom('ludy_meetings.meeting_link')
    .select('deal_id')
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', '=', meetingId)
    .where('deal_id', 'is not', null)
    .executeTakeFirst();
  if (!link?.deal_id) return { ok: false, reason: 'no_deal' };
  let deal;
  try {
    deal = await ctx.query<{ id: string; title: string; stageId: string; stageKind: string; closedAt: string | null; partyId: string }>('crm.deal.get', { dealId: link.deal_id });
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'DEAL_NOT_FOUND') return { ok: false, reason: 'no_deal' };
    throw error;
  }
  if (deal.status !== 'ok') return { ok: false, reason: 'no_crm' };
  if (deal.value.closedAt !== null || deal.value.stageKind !== 'open') return { ok: false, reason: 'deal_closed' };
  const stages = await ctx.query<Array<{ id: string; name: string }>>('crm.stage.list', {});
  const stage = stages.status === 'ok' ? (stages.value.find((s) => s.id === deal.value.stageId)?.name ?? '') : '';
  return { ok: true, deal: { id: deal.value.id, title: deal.value.title, stage, partyId: deal.value.partyId } };
}

function noOpenDeal(reason: 'no_crm' | 'no_deal' | 'deal_closed'): DomainError {
  return reason === 'deal_closed'
    ? new DomainError('DEAL_CLOSED', 409, 'Cơ hội này đã đóng')
    : new DomainError('MEETING_NO_DEAL', 409, 'Cuộc họp này chưa liên kết với cơ hội nào');
}

async function recorderOf(ctx: { trx: Trx; orgId: string }, meetingId: string, userId: string): Promise<{ language: 'vi' | 'en'; recorderUserId: string }> {
  const meeting = await openMeeting(ctx.trx, ctx.orgId, meetingId);
  if (meeting.recorder_user_id !== userId) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
  const row = await ctx.trx.selectFrom('ludy_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  return { language: row.language === 'en' ? 'en' : 'vi', recorderUserId: meeting.recorder_user_id };
}

async function transcriptLinesOf(trx: Trx, orgId: string, meetingId: string): Promise<SalesInsightSegmentFact[]> {
  const rows = await trx
    .selectFrom('ludy_meetings.transcript_segment')
    .select(['id', 'stage', 'start_seconds', 'end_seconds', 'speaker_label', 'text'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .orderBy('start_seconds')
    .orderBy('id')
    .execute();
  const hasDraft = rows.some((r) => r.stage === 'draft');
  const stage = hasDraft ? 'draft' : 'published';
  return rows
    .filter((r) => r.stage === stage && r.text.trim() !== '')
    .map((r) => ({
      id: r.id,
      startSeconds: Number(r.start_seconds),
      endSeconds: Number(r.end_seconds),
      speakerLabel: r.speaker_label,
      text: r.text,
    }));
}

async function isTranscribing(ctx: { query: QueryContext['query'] }, meetingId: string): Promise<boolean> {
  const live = await ctx.query<{ live: boolean }>('kernel.member_vy.run.live', { feature: 'meetings.transcribe', subjectId: meetingId });
  return live.status !== 'ok' || live.value.live;
}

async function speakerMappingOf(ctx: QueryContext, meetingId: string, recorderUserId: string, dealPartyId: string): Promise<{ internalNames: string[]; customerNames: string[] }> {
  const [attendees, members, partyLinks] = await Promise.all([
    attendeeNames(ctx, meetingId, recorderUserId),
    memberNames(ctx),
    ctx.trx.selectFrom('ludy_meetings.meeting_link').select('party_id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', meetingId).where('party_id', 'is not', null).execute(),
  ]);
  const internalNames = [...new Set([...attendees.map((p) => p.name), ...members.map((p) => p.name)].map((n) => n.trim()).filter(Boolean))];
  const linkedPartyIds = partyLinks.flatMap((l) => (l.party_id ? [l.party_id] : []));
  const rootPartyIds = [...new Set([dealPartyId, ...linkedPartyIds])];
  const parties =
    rootPartyIds.length > 0
      ? await ctx.trx
          .selectFrom('ludy_kernel.party')
          .select('name')
          .where('org_id', '=', ctx.orgId)
          .where((eb) => eb.or([eb('id', 'in', rootPartyIds), eb('company_id', 'in', rootPartyIds), eb('duplicate_of', 'in', rootPartyIds)]))
          .execute()
      : [];
  const customerNames = [...new Set(parties.map((p) => p.name.trim()).filter(Boolean))];
  return { internalNames, customerNames };
}

// Recorder-only readiness check: non-recorders always get 404 (MEETING_NOT_FOUND).
export const salesInsightStatus = defineQuery({
  name: 'meetings.sales_insight.status',
  input: zMeetingRef,
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<SalesInsightStatus> => {
    const userId = userOf(ctx.actor);
    await recorderOf(ctx, input.meetingId, userId);
    const linked = await linkedOpenDeal(ctx, input.meetingId);
    const unavailable = (reason: NonNullable<SalesInsightStatus['reason']>, deal: SalesInsightStatus['deal']): SalesInsightStatus =>
      zSalesInsightStatus.parse({ meetingId: input.meetingId, available: false, enabled: false, reason, deal });
    if (!linked.ok) return unavailable(linked.reason, null);
    const dealSummary = { id: linked.deal.id, title: linked.deal.title, stage: linked.deal.stage };
    if (await isTranscribing(ctx, input.meetingId)) return unavailable('transcribe_running', dealSummary);
    const lines = await transcriptLinesOf(ctx.trx, ctx.orgId, input.meetingId);
    if (lines.length === 0) return unavailable('no_transcript', dealSummary);
    const reason = !isSummaryEnabled() ? ('off' as const) : await vyReason(ctx);
    return zSalesInsightStatus.parse({
      meetingId: input.meetingId,
      available: true,
      enabled: reason === null,
      reason,
      deal: dealSummary,
    });
  },
});

// Audited route-only read of transcript lines (with segment IDs), deal summary and speaker names for the recorder.
export const salesInsightFacts = defineQuery({
  name: 'meetings.sales_insight.facts',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<SalesInsightFactsRead> => {
    const userId = userOf(ctx.actor);
    const { language, recorderUserId } = await recorderOf(ctx, input.meetingId, userId);
    const linked = await linkedOpenDeal(ctx, input.meetingId);
    if (!linked.ok) throw noOpenDeal(linked.reason);
    if (await isTranscribing(ctx, input.meetingId)) {
      throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    }
    const segments = await transcriptLinesOf(ctx.trx, ctx.orgId, input.meetingId);
    if (segments.length === 0) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to read yet');
    const speakerMapping = await speakerMappingOf(ctx, input.meetingId, recorderUserId, linked.deal.partyId);
    return {
      meetingId: input.meetingId,
      language,
      deal: { id: linked.deal.id, title: linked.deal.title, stage: linked.deal.stage },
      segments,
      speakerMapping,
    };
  },
});

// Starts the recorder's own Vy run under meetings.sales_insight; non-recorder receives 404, no-open-deal refused before any run starts.
export const salesInsightStart = defineCommand({
  name: 'meetings.sales_insight.start',
  input: zMeetingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await recorderOf(ctx, input.meetingId, userId);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
    const linked = await linkedOpenDeal(ctx, input.meetingId);
    if (!linked.ok) throw noOpenDeal(linked.reason);
    await lockMeetingMedia(ctx, input.meetingId);
    await ctx.trx.selectFrom('ludy_meetings.meeting').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).forShare().execute();
    if (await isTranscribing(ctx, input.meetingId)) {
      throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    }
    const segments = await transcriptLinesOf(ctx.trx, ctx.orgId, input.meetingId);
    if (segments.length === 0) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to read yet');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', {
      feature: SALES_INSIGHT_FEATURE,
      subjectType: SALES_INSIGHT_FEATURE,
      subjectId: randomUUID(),
    });
    await markAudioUsed(ctx, input.meetingId);
    ctx.audit({ meetingId: input.meetingId, runId: started.runId, dealId: linked.deal.id });
    return { meetingId: input.meetingId, runId: started.runId };
  },
});

export const salesInsightCommands = [salesInsightStart];
export const salesInsightQueries = [salesInsightStatus, salesInsightFacts];
