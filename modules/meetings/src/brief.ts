// SPDX-License-Identifier: AGPL-3.0-only
// Vy's brief before a meeting, the module's side (#3543, plan docs/plan/meetings.md row L7, builds on the series of #3542). It reads no private Vy result row: the facts are read by code in the
// member's own transaction, and the start of the run is the member's own click.
//
// meetings.brief.facts    for a meeting the member reads, or a calendar event of their own agenda that is not recorded yet: the published decisions of the previous meeting of the series (only when the
//                         member reads it: row security, the same pick as the open items of #3542), the series' open items, the customer linked to the meeting (else to the previous meeting) and that
//                         customer's open deals with their stage, read through the CRM module's own queries (crm.deal.list and crm.stage.list: no table of another line is read). Nothing is stored. With no
//                         decision, no open item and no open deal the answer says `empty` and the page shows no brief.
// meetings.brief.status   whether Vy may write the few sentences now (the same switches as asking across meetings); the facts above work with AI off.
// meetings.brief.start    starts the member's own Vy run for one brief (the kernel's run.start checks vy.use, the kill switches and the budget).
// The model call, the checks of its sentences and the counts-only result row are in apps/kernel (member-vy-ports.ts) and packages/agent (member-vy/meeting-brief.ts).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  AGENDA_LIST_MAX,
  BRIEF_DEALS_MAX,
  BRIEF_DECISIONS_MAX,
  BRIEF_ITEMS_MAX,
  DAILY_BRIEF_MEETINGS_MAX,
  zAskStarted,
  zBriefEmpty,
  zBriefFacts,
  zBriefStatus,
  zBriefTarget,
  zDailyBriefFacts,
  zDailyBriefFactsInput,
  zDailyBriefStoreLinesInput,
  type BriefDeal,
  type BriefFacts,
  type BriefStatus,
  type DailyBriefFacts,
  type DailyBriefItem,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { openItemsOf, previousMeetingOf } from './series.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const BRIEF_FEATURE = 'meetings.brief';
type Trx = QueryContext['trx'];

// The meeting or the calendar event the brief is for: its series, when it starts (the previous meeting is the latest one before that) and the meeting itself when it is recorded.
async function targetOf(trx: Trx, orgId: string, target: { meetingId: string | null; agendaId: string | null }): Promise<{ meetingId: string | null; seriesId: string | null; at: Date }> {
  if (target.meetingId !== null) {
    await openMeeting(trx, orgId, target.meetingId);
    const row = await trx
      .selectFrom('ludy_meetings.meeting')
      .select(['series_id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', orgId)
      .where('id', '=', target.meetingId)
      .executeTakeFirstOrThrow();
    return { meetingId: target.meetingId, seriesId: row.series_id, at: row.at };
  }
  // A calendar event is the member's own: row security shows no other member's.
  const event = await trx
    .selectFrom('ludy_meetings.calendar_agenda')
    .select(['series_id', 'starts_at', 'meeting_id'])
    .where('org_id', '=', orgId)
    .where('id', '=', target.agendaId as string)
    .executeTakeFirst();
  if (!event) throw new DomainError('AGENDA_NOT_FOUND', 404, 'That calendar event is not in your calendar any more');
  return { meetingId: event.meeting_id, seriesId: event.series_id, at: new Date(event.starts_at) };
}

export const briefFacts = defineQuery({
  name: 'meetings.brief.facts',
  input: zBriefTarget,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<BriefFacts> => {
    userOf(ctx.actor);
    return briefFactsOf(ctx, input);
  },
});

/**
 * The facts of one brief, read in the caller's own transaction (row security on every one): shared by `meetings.brief.facts` and the Today view (#3955), so a day's briefs are exactly the briefs the member would open
 * one by one. Throws MEETING_NOT_FOUND for a meeting the caller does not read and AGENDA_NOT_FOUND for a calendar event that is not in their agenda.
 */
export async function briefFactsOf(ctx: { trx: Trx; orgId: string; query: QueryContext['query'] }, input: { meetingId: string | null; agendaId: string | null }, stageNames: StageNames = stageNamesOnce(ctx)): Promise<BriefFacts> {
  const target = await targetOf(ctx.trx, ctx.orgId, input);
  const previous = target.seriesId === null ? undefined : await previousMeetingOf(ctx.trx, ctx.orgId, target.seriesId, target.at, target.meetingId);
  let decisions: string[] = [];
  let items: BriefFacts['items'] = [];
  if (previous) {
    // Published decisions only, read under the caller's own row security (a published result is read by the readers of its meeting).
    const result = await ctx.trx
      .selectFrom('ludy_meetings.meeting_result')
      .select('decisions')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', previous.id)
      .where('stage', '=', 'published')
      .executeTakeFirst();
    decisions = (Array.isArray(result?.decisions) ? (result.decisions as unknown[]) : []).filter((d): d is string => typeof d === 'string' && d.trim() !== '').slice(0, BRIEF_DECISIONS_MAX);
    items = (await openItemsOf(ctx.trx, ctx.orgId, previous.id)).slice(0, BRIEF_ITEMS_MAX);
  }
  const { customer, deals } = await customerOf(ctx, target.meetingId, previous?.id ?? null, stageNames);
  return zBriefFacts.parse({
    previous: previous ? { meetingId: previous.id, title: previous.title, startedAt: previous.at.toISOString() } : null,
    decisions,
    items,
    customer,
    deals,
    empty: decisions.length === 0 && items.length === 0 && deals.length === 0,
  });
}

// The customer linked to the meeting, else to the previous meeting of the series (a party link, else the party of a linked deal), and that customer's open deals with their stage. A party is read under the
// caller's own policy; the deals and the stage names come from the CRM module's queries, which answer `not_installed` where the deployment has no CRM (then the customer is shown with no deals).
async function customerOf(ctx: { trx: Trx; orgId: string; query: QueryContext['query'] }, meetingId: string | null, previousId: string | null, stageNames: StageNames): Promise<{ customer: { partyId: string; name: string } | null; deals: BriefDeal[] }> {
  const none = { customer: null, deals: [] };
  for (const id of [meetingId, previousId]) {
    if (id === null) continue;
    const links = await ctx.trx.selectFrom('ludy_meetings.meeting_link').select(['party_id', 'deal_id']).where('org_id', '=', ctx.orgId).where('meeting_id', '=', id).orderBy('created_at').orderBy('id').execute();
    let partyId = links.find((l) => l.party_id !== null)?.party_id ?? null;
    if (partyId === null) {
      const dealId = links.find((l) => l.deal_id !== null)?.deal_id ?? null;
      if (dealId !== null) {
        try {
          const deal = await ctx.query<{ partyId: string }>('crm.deal.get', { dealId });
          if (deal.status === 'ok') partyId = deal.value.partyId;
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'DEAL_NOT_FOUND')) throw error;
        }
      }
    }
    if (partyId === null) continue;
    const party = await ctx.trx.selectFrom('ludy_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', '=', partyId).executeTakeFirst();
    // A party the caller may not read is no customer for them.
    if (!party) continue;
    const deals = await openDealsOf(ctx, party.id, stageNames);
    return { customer: { partyId: party.id, name: party.name }, deals };
  }
  return none;
}

/** The names of the CRM stages by id, read when first asked for. */
export type StageNames = () => Promise<Map<string, string>>;

/**
 * A reader of the CRM stage names that asks the CRM module at most once, however many times it is called: the Today view briefs up to 20 events in one transaction and the stages are the same for all of them.
 * Nothing is read until a brief has a deal to name (a day with no deal reads no stage). The module answers `not_installed` where the deployment has no CRM: no names then.
 */
export function stageNamesOnce(ctx: { query: QueryContext['query'] }): StageNames {
  let pending: Promise<Map<string, string>> | undefined;
  return () =>
    (pending ??= (async () => {
      const stages = await ctx.query<Array<{ id: string; name: string }>>('crm.stage.list', {});
      return new Map(stages.status === 'ok' ? stages.value.map((s) => [s.id, s.name] as const) : []);
    })());
}

async function openDealsOf(ctx: { query: QueryContext['query'] }, partyId: string, stageNames: StageNames): Promise<BriefDeal[]> {
  const listed = await ctx.query<{ items: Array<{ id: string; title: string; amount: string; stageId: string; expectedClose: string | null }> }>('crm.deal.list', { partyId, status: 'open', limit: BRIEF_DEALS_MAX });
  if (listed.status !== 'ok') return [];
  // No deal, no stage name to look up.
  if (listed.value.items.length === 0) return [];
  const names = await stageNames();
  return listed.value.items.slice(0, BRIEF_DEALS_MAX).map((d) => ({
    id: d.id,
    title: d.title,
    stage: names.get(d.stageId) ?? '',
    // A decimal string from the CRM module, kept as it is; a deal with no amount yet has "0".
    amount: /^0+(?:\.0+)?$/.test(d.amount) ? null : d.amount,
    expectedClose: d.expectedClose,
  }));
}

// Whether Vy may write the sentences now: the deployment's switch, the member's right to work with Vy, a kill switch of the org, the meetings module or the operator, and this month's budget of the org or
// the module. The kernel's run.start decides again at the click, so this is the answer for the button, not the gate. The expected cost is added by the route, which knows the prices.
export const briefStatus = defineQuery({
  name: 'meetings.brief.status',
  input: zBriefEmpty,
  access: ROLES,
  handler: async (ctx): Promise<BriefStatus> => {
    userOf(ctx.actor);
    const reason = await vyReason(ctx);
    return zBriefStatus.parse({ enabled: reason === null, reason, estimate: null });
  },
});

// Starts the member's own Vy run for one brief: any member with the deployment's switch on. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and the
// budget, makes the member's Vy and this run, and binds the run to a fresh subject ('meetings.brief' and an id no screen sees). Nothing is read or sent here, and the run's result row will hold counts
// only (the route stores them), never a fact or a sentence.
export const briefStart = defineCommand({
  name: 'meetings.brief.start',
  input: zBriefEmpty,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx) => {
    userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('BRIEF_OFF', 422, 'Vy writing a brief is not turned on here');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: BRIEF_FEATURE, subjectType: BRIEF_FEATURE, subjectId: randomUUID() });
    ctx.audit({ runId: started.runId });
    return zAskStarted.parse({ runId: started.runId });
  },
});

const DAILY_BRIEF_SCAN_MAX = 20;

const agendaLinkRank = (row: { meeting_id: string | null; series_id: string | null }): number =>
  row.meeting_id !== null ? 2 : row.series_id !== null ? 1 : 0;

// Daily briefing facts for a member's own scheduled calendar window (#5073 Step 2b-1):
// queries ludy_meetings.calendar_agenda directly (calendar_connection RLS hides rows from member-scoped Vy),
// deduplicates identical provider occurrences across connections, and reuses briefFactsOf under the caller's RLS.
export const briefDailyFacts = defineQuery({
  name: 'meetings.brief.daily_facts',
  input: zDailyBriefFactsInput,
  access: ROLES,
  memberVy: { reads: ['crm.deal.get', 'crm.deal.list', 'crm.stage.list'] },
  handler: async (ctx, input): Promise<DailyBriefFacts> => {
    if (!ctx.memberVy) throw new DomainError('FORBIDDEN', 403, 'Chỉ Vy cá nhân mới được chạy truy vấn này');
    if (input.connectionIds !== undefined && input.connectionIds.length === 0) {
      return zDailyBriefFacts.parse({ items: [] });
    }
    let query = ctx.trx
      .selectFrom('ludy_meetings.calendar_agenda')
      .select(['id', 'external_id', 'starts_at', 'meeting_id', 'series_id'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.memberVy.memberUserId)
      .where('starts_at', '>=', new Date(input.from))
      .where('starts_at', '<', new Date(input.to));
    if (input.connectionIds !== undefined) {
      query = query.where('connection_id', 'in', input.connectionIds);
    }
    const rows = await query.orderBy('starts_at').orderBy('id').limit(AGENDA_LIST_MAX).execute();

    const deduped = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.external_id}\0${row.starts_at.toISOString()}`;
      const existing = deduped.get(key);
      if (!existing || agendaLinkRank(row) > agendaLinkRank(existing)) {
        deduped.set(key, row);
      }
    }

    const items: DailyBriefItem[] = [];
    const stageNames = stageNamesOnce(ctx);
    for (const row of [...deduped.values()].slice(0, DAILY_BRIEF_SCAN_MAX)) {
      if (items.length >= DAILY_BRIEF_MEETINGS_MAX) break;
      let brief: BriefFacts;
      try {
        brief = await briefFactsOf(
          ctx,
          row.meeting_id !== null ? { meetingId: row.meeting_id, agendaId: null } : { meetingId: null, agendaId: row.id },
          stageNames,
        );
      } catch (error) {
        if (error instanceof DomainError && (error.code === 'MEETING_NOT_FOUND' || error.code === 'AGENDA_NOT_FOUND')) {
          continue;
        }
        throw error;
      }
      if (brief.empty) continue;
      items.push({
        agendaId: row.id,
        meetingId: row.meeting_id,
        startsAt: row.starts_at.toISOString(),
        brief,
      });
    }
    return zDailyBriefFacts.parse({ items });
  },
});

export const briefStoreLines = defineCommand({
  name: 'meetings.brief.store_lines',
  input: zDailyBriefStoreLinesInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<{ stored: boolean; lineCount: number }> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới lưu được dòng chuẩn bị buổi sáng');
    }
    try {
      await sql`
        SELECT ludy_meetings.morning_brief_lines_upsert(
          ${ctx.orgId}::uuid,
          ${input.userId}::uuid,
          ${input.meetingId}::uuid,
          ${JSON.stringify(input.lines)}::jsonb,
          ${input.expiresAt}::timestamptz
        )`.execute(ctx.trx);
    } catch (error: unknown) {
      const msg = (error as { message?: string } | null)?.message ?? '';
      if (msg.includes('BRIEF_LINES_NOT_ELIGIBLE')) {
        throw new DomainError('BRIEF_LINES_NOT_ELIGIBLE', 403, 'Thành viên không còn đủ điều kiện nhận gợi ý buổi sáng');
      }
      if (msg.includes('BRIEF_LINES_MEETING_MISSING')) {
        throw new DomainError('MEETING_NOT_FOUND', 404, 'Không tìm thấy cuộc họp');
      }
      if (msg.includes('BRIEF_LINES_INVALID') || msg.includes('BRIEF_LINES_EXPIRY_INVALID')) {
        const code = msg.includes('BRIEF_LINES_EXPIRY_INVALID') ? 'BRIEF_LINES_EXPIRY_INVALID' : 'BRIEF_LINES_INVALID';
        throw new DomainError(code, 422, 'Dữ liệu dòng chuẩn bị buổi sáng không hợp lệ');
      }
      throw error;
    }
    ctx.audit({ lineCount: input.lines.length });
    return { stored: true, lineCount: input.lines.length };
  },
});

export const briefCommands = [briefStart, briefStoreLines];
export const briefQueries = [briefFacts, briefDailyFacts, briefStatus];
