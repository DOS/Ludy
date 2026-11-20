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
  BRIEF_DEALS_MAX,
  BRIEF_DECISIONS_MAX,
  BRIEF_ITEMS_MAX,
  zAskStarted,
  zBriefEmpty,
  zBriefFacts,
  zBriefStatus,
  zBriefTarget,
  type BriefDeal,
  type BriefFacts,
  type BriefStatus,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
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
      .selectFrom('crove_meetings.meeting')
      .select(['series_id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', orgId)
      .where('id', '=', target.meetingId)
      .executeTakeFirstOrThrow();
    return { meetingId: target.meetingId, seriesId: row.series_id, at: row.at };
  }
  // A calendar event is the member's own: row security shows no other member's.
  const event = await trx
    .selectFrom('crove_meetings.calendar_agenda')
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
      .selectFrom('crove_meetings.meeting_result')
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
    const links = await ctx.trx.selectFrom('crove_meetings.meeting_link').select(['party_id', 'deal_id']).where('org_id', '=', ctx.orgId).where('meeting_id', '=', id).orderBy('created_at').orderBy('id').execute();
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
    const party = await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', '=', partyId).executeTakeFirst();
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

export const briefCommands = [briefStart];
export const briefQueries = [briefFacts, briefStatus];
