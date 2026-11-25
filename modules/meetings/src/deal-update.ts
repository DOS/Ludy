// SPDX-License-Identifier: AGPL-3.0-only
// Vy proposing the update of the deal a meeting is linked to, the module's side (#4766, ADR-0048, ADR-0049, docs/plan/meetings.md section 15). The deal and what it may be given belong to the CRM module
// (crm.deal.meeting_update.apply, crm/src/deal-meeting-update.ts); the minutes and who may use them belong here, so the recorder's command lives here and calls the CRM one.
//
// meetings.deal_update.status   the recorder of a meeting linked to an open deal with published minutes: whether the card shows and whether Vy may be asked now.
// meetings.deal_update.facts    (read by the route only) the published summary, decisions and action items, with the day each item's words gave, and the deal's title and stage. Audited.
// meetings.deal_update.start    starts the recorder's own Vy run (the kernel's run.start checks vy.use, the kill switches and the budget).
// meetings.deal_update.confirm  the recorder's click, with the proposal as they read and edited it: re-reads the link and the minutes (a proposal for minutes that changed is refused), cleans and checks both
//                               texts again, allows only a day the minutes wrote, and calls the CRM command. Nothing is written before it; nothing is written by the model.
// Works with AI off: the card is absent then, and the deal keeps its own screens.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  DEAL_UPDATE_NOTE_MAX,
  DEAL_UPDATE_STEP_MAX,
  dealUpdateTextProblem,
  followupClean,
  zDealUpdateAsk,
  zDealUpdateConfirm,
  zDealUpdateConfirmed,
  zDealUpdateStatus,
  zMeetingRef,
  zonedInstant,
  type DealUpdateStatus,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, sha256Hex, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { lockMeeting, openMeeting, userOf } from './transcript.ts';

export const DEAL_UPDATE_FEATURE = 'meetings.deal_update';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
type Trx = QueryContext['trx'];

interface MinutesItem {
  title: string;
  who: string;
  when: string;
  // The calendar day the meeting's own parser read from the item's words, or null.
  whenDate: string | null;
}
export interface DealUpdateMinutes {
  summary: string;
  decisions: string[];
  items: MinutesItem[];
}

const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

// The published minutes only: a draft is the recorder's to review first, and a deal's history is never written from an unreviewed text.
async function publishedMinutes(trx: Trx, orgId: string, meetingId: string): Promise<{ minutes: DealUpdateMinutes; key: string } | null> {
  const result = await trx
    .selectFrom('ludy_meetings.meeting_result')
    .select(['id', 'summary', 'decisions', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .executeTakeFirst();
  const items = await trx
    .selectFrom('ludy_meetings.action_item')
    .where('task_id', 'is', null)
    .select(['id', 'title', 'who_drafted', 'when_drafted', sql<string | null>`when_parsed::text`.as('when_parsed'), 'updated_at'])
    .where('org_id', '=', orgId)
    .where('meeting_id', '=', meetingId)
    .where('stage', '=', 'published')
    .orderBy('transcript_seconds')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (!result && items.length === 0) return null;
  const minutes: DealUpdateMinutes = {
    summary: result?.summary ?? '',
    decisions: Array.isArray(result?.decisions) ? (result.decisions as unknown[]).filter((d): d is string => typeof d === 'string') : [],
    items: items.map((i) => ({ title: i.title, who: i.who_drafted ?? '', when: i.when_drafted ?? '', whenDate: i.when_parsed !== null && DAY.test(i.when_parsed) ? i.when_parsed : null })),
  };
  if (minutes.summary.trim() === '' && minutes.decisions.every((d) => d.trim() === '') && minutes.items.length === 0) return null;
  const stamp = result ? `${result.id}:${new Date(result.updated_at).toISOString()}` : 'items-only';
  const key = sha256Hex(JSON.stringify(['deal_update', stamp, minutes, items.map((i) => `${i.id}:${new Date(i.updated_at).toISOString()}`)]));
  return { minutes, key };
}

type Linked = { ok: true; deal: { id: string; title: string; stage: string; version: number; partyId: string } } | { ok: false; reason: 'no_crm' | 'no_deal' | 'deal_closed' };

// The deal the meeting is linked to, as the caller may read it, through the CRM module's own queries (no CRM table is read; a deployment without CRM has none).
async function linkedDeal(ctx: { trx: Trx; orgId: string; query: QueryContext['query'] }, meetingId: string): Promise<Linked> {
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
    deal = await ctx.query<{ id: string; title: string; stageId: string; stageKind: string; closedAt: string | null; version: number; partyId: string }>('crm.deal.get', { dealId: link.deal_id });
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'DEAL_NOT_FOUND') return { ok: false, reason: 'no_deal' };
    throw error;
  }
  if (deal.status !== 'ok') return { ok: false, reason: 'no_crm' };
  if (deal.value.closedAt !== null || deal.value.stageKind !== 'open') return { ok: false, reason: 'deal_closed' };
  const stages = await ctx.query<Array<{ id: string; name: string }>>('crm.stage.list', {});
  const stage = stages.status === 'ok' ? (stages.value.find((s) => s.id === deal.value.stageId)?.name ?? '') : '';
  return { ok: true, deal: { id: deal.value.id, title: deal.value.title, stage, version: deal.value.version, partyId: deal.value.partyId } };
}

async function recorderOf(ctx: { trx: Trx; orgId: string }, meetingId: string, userId: string): Promise<{ language: 'vi' | 'en' }> {
  const meeting = await openMeeting(ctx.trx, ctx.orgId, meetingId);
  if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to update the deal');
  const row = await ctx.trx.selectFrom('ludy_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', meetingId).executeTakeFirstOrThrow();
  return { language: row.language === 'en' ? 'en' : 'vi' };
}

// Whether the card shows, and whether Vy may be asked now. A member who did not record the meeting gets 'not_recorder' and nothing about the deal.
export const dealUpdateStatus = defineQuery({
  name: 'meetings.deal_update.status',
  input: zMeetingRef,
  access: EDITORS,
  handler: async (ctx, input): Promise<DealUpdateStatus> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const none = (reason: NonNullable<DealUpdateStatus['reason']>): DealUpdateStatus =>
      zDealUpdateStatus.parse({ meetingId: input.meetingId, available: false, enabled: false, reason, deal: null, minutesKey: null });
    if (meeting.recorder_user_id !== userId) return none('not_recorder');
    const linked = await linkedDeal(ctx, input.meetingId);
    if (!linked.ok) return none(linked.reason);
    const published = await publishedMinutes(ctx.trx, ctx.orgId, input.meetingId);
    if (published === null) return none('no_minutes');
    const reason = await vyReason(ctx);
    return zDealUpdateStatus.parse({
      meetingId: input.meetingId,
      available: true,
      enabled: reason === null,
      reason,
      deal: { id: linked.deal.id, title: linked.deal.title, stage: linked.deal.stage },
      minutesKey: published.key,
    });
  },
});

export interface DealUpdateFactsRead {
  meetingId: string;
  language: 'vi' | 'en';
  deal: { id: string; title: string; stage: string };
  minutesKey: string;
  facts: DealUpdateMinutes;
}

// The facts of one proposal, for the route that asks the model (never an RPC route of its own). The minutes are the meeting's text, so a read leaves an audit row naming the meeting.
export const dealUpdateFacts = defineQuery({
  name: 'meetings.deal_update.facts',
  input: zDealUpdateAsk,
  access: EDITORS,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<DealUpdateFactsRead> => {
    const userId = userOf(ctx.actor);
    const { language } = await recorderOf(ctx, input.meetingId, userId);
    const linked = await linkedDeal(ctx, input.meetingId);
    if (!linked.ok) throw noDeal(linked.reason);
    const published = await publishedMinutes(ctx.trx, ctx.orgId, input.meetingId);
    if (!published) throw new DomainError('NO_PUBLISHED_SUMMARY', 409, 'Chia sẻ tóm tắt của cuộc họp trước khi cập nhật cơ hội');
    return { meetingId: input.meetingId, language, deal: { id: linked.deal.id, title: linked.deal.title, stage: linked.deal.stage }, minutesKey: published.key, facts: published.minutes };
  },
});

function noDeal(reason: 'no_crm' | 'no_deal' | 'deal_closed'): DomainError {
  return reason === 'deal_closed'
    ? new DomainError('DEAL_CLOSED', 409, 'Cơ hội này đã đóng, không cần cập nhật bước tiếp theo nữa')
    : new DomainError('MEETING_NO_DEAL', 409, 'Cuộc họp này chưa liên kết với cơ hội nào');
}

// Starts the recorder's own Vy run: recorder only, the deployment's switch on, a linked open deal and published minutes. The kernel's run.start enforces vy.use, kill switches and budget. The run's
// result row will hold counts only (the route stores them), never the proposal.
export const dealUpdateStart = defineCommand({
  name: 'meetings.deal_update.start',
  input: zMeetingRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
    await recorderOf(ctx, input.meetingId, userId);
    const linked = await linkedDeal(ctx, input.meetingId);
    if (!linked.ok) throw noDeal(linked.reason);
    if ((await publishedMinutes(ctx.trx, ctx.orgId, input.meetingId)) === null) throw new DomainError('NO_PUBLISHED_SUMMARY', 409, 'Chia sẻ tóm tắt của cuộc họp trước khi cập nhật cơ hội');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: DEAL_UPDATE_FEATURE, subjectType: 'meeting', subjectId: input.meetingId });
    ctx.audit({ meetingId: input.meetingId, runId: started.runId });
    return { meetingId: input.meetingId, runId: started.runId };
  },
});

const invalidText = (field: string, problem: string) => new DomainError('DEAL_UPDATE_TEXT_INVALID', 422, `Phần "${field}" không dùng được (${problem})`, { field, problem });

// The recorder's confirm. The texts are whatever the recorder left on screen, from Vy or typed: the checks here, not a flag from the client, are the gate. Creates nothing but through the CRM command.
export const dealUpdateConfirm = defineCommand({
  name: 'meetings.deal_update.confirm',
  input: zDealUpdateConfirm,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input) => {
    const userId = userOf(ctx.actor);
    // The meeting is held while the minutes are read and written against, so a republish cannot land between the key check and the write.
    await lockMeeting(ctx.trx, ctx.orgId, input.meetingId);
    await recorderOf(ctx, input.meetingId, userId);
    const linked = await linkedDeal(ctx, input.meetingId);
    if (!linked.ok) throw noDeal(linked.reason);
    // The deal named on screen is the one the meeting is linked to now (a link moved since the proposal was shown is refused, never followed).
    if (linked.deal.id !== input.dealId) throw new DomainError('STALE_DEAL_UPDATE', 409, 'Liên kết cơ hội của cuộc họp đã thay đổi; hãy mở lại đề xuất');
    const published = await publishedMinutes(ctx.trx, ctx.orgId, input.meetingId);
    if (!published) throw new DomainError('NO_PUBLISHED_SUMMARY', 409, 'Chia sẻ tóm tắt của cuộc họp trước khi cập nhật cơ hội');
    if (published.key !== input.minutesKey) throw new DomainError('STALE_DEAL_UPDATE', 409, 'Tóm tắt của cuộc họp đã thay đổi từ lúc Vy đề xuất; hãy nhờ Vy đề xuất lại');

    const stepText = input.nextStep ? followupClean(input.nextStep.text, true) : null;
    const note = input.note === null ? null : followupClean(input.note, true);
    if (stepText !== null) {
      const problem = dealUpdateTextProblem(stepText, DEAL_UPDATE_STEP_MAX);
      if (problem) throw invalidText('bước tiếp theo', problem);
    }
    if (note !== null) {
      const problem = dealUpdateTextProblem(note, DEAL_UPDATE_NOTE_MAX);
      if (problem) throw invalidText('ghi chú', problem);
    }
    if (stepText === null && note === null) throw new DomainError('DEAL_UPDATE_EMPTY', 422, 'Cần ít nhất một bước tiếp theo hoặc một ghi chú');
    // The day is one the meeting wrote for one of its action items, never one typed or made up: the minutes are the only source of a date.
    const dueOn = input.nextStep?.dueOn ?? null;
    if (dueOn !== null && !published.minutes.items.some((i) => i.whenDate === dueOn)) {
      throw new DomainError('DEAL_UPDATE_DATE_INVALID', 422, 'Ngày hạn phải là ngày được ghi trong việc cần làm của cuộc họp');
    }
    const due = dueOn === null ? null : new Date(zonedInstant('Asia/Ho_Chi_Minh', dueOn, 23 * 60 + 59)).toISOString();

    const applied = await ctx.run<{ dealId: string; taskId: string | null; noteSaved: boolean; remindersClosed: number }>('crm.deal.meeting_update.apply', {
      dealId: linked.deal.id,
      meetingId: input.meetingId,
      nextStep: stepText === null ? null : { text: stepText, dueOn },
      note,
      due,
    });
    // Ids, flags and counts only: the texts are the deal's and the task's, never the audit's.
    ctx.audit({ meetingId: input.meetingId, dealId: applied.dealId, taskId: applied.taskId, noteSaved: applied.noteSaved, remindersClosed: applied.remindersClosed });
    return zDealUpdateConfirmed.parse(applied);
  },
});

export const dealUpdateCommands = [dealUpdateStart, dealUpdateConfirm];
export const dealUpdateQueries = [dealUpdateStatus, dealUpdateFacts];
