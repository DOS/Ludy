// SPDX-License-Identifier: AGPL-3.0-only
// This week's decisions and what is still open, across the meetings a member reads, the module's side (#3949, plan docs/plan/meetings.md §1 "the weekly job"). It reads no private Vy result row: the facts are read
// by code in the member's own transaction, and the start of a recap is the member's own click.
//
// meetings.digest.facts   the meetings the caller reads that started in the last 7, 14 or 30 days (row security: a meeting the caller does not read is not there; a meeting past its text date is gone from its
//                         day), each with its PUBLISHED decisions (never a draft) and its still-open published action items, through the same open-items read as the series (#3542). Newest meeting first, at
//                         most 30 decisions and 30 items in all, and the answer says when it cut. Nothing is stored. With no decision and no open item the answer says `empty`.
// meetings.digest.status  whether Vy may write the few sentences now (the same switches as asking across meetings); the facts above work with AI off.
// meetings.digest.start   starts the member's own Vy run for one recap (the kernel's run.start checks vy.use, the kill switches and the budget).
// The model call, the checks of its sentences and the counts-only result row are in apps/kernel (member-vy-ports.ts) and packages/agent (member-vy/meetings-digest.ts).
import { randomUUID } from 'node:crypto';
import {
  DIGEST_DECISIONS_MAX,
  DIGEST_ITEMS_MAX,
  DIGEST_MEETINGS_MAX,
  zAskStarted,
  zBriefEmpty,
  zDigestAsk,
  zDigestFacts,
  zDigestStatus,
  type DigestFacts,
  type DigestMeeting,
  type DigestStatus,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { vyReason } from './ask.ts';
import { vnDay } from './retention.ts';
import { openItemsOf } from './series.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, userOf } from './transcript.ts';

export const DIGEST_FEATURE = 'meetings.digest';
const DAY_MS = 86_400_000;

export const digestFacts = defineQuery({
  name: 'meetings.digest.facts',
  input: zDigestAsk,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<DigestFacts> => {
    userOf(ctx.actor);
    const since = new Date(Date.now() - input.days * DAY_MS);
    // The meetings the caller reads (row security), not yet past their text date, that have something published (a result or an action item), newest first. A meeting with only a draft, or still being recorded, takes no
    // place: the limit counts the meetings that can show something. One more than the limit is read, to know whether the limit cut.
    const readable = await ctx.trx
      .selectFrom('ludy_meetings.meeting as m')
      .select(['m.id', 'm.title', 'm.started_at'])
      .where('m.org_id', '=', ctx.orgId)
      .where('m.started_at', '>=', since)
      .where((eb) => eb.or([eb('m.text_retention_date', 'is', null), eb('m.text_retention_date', '>', vnDay(new Date()))]))
      .where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('ludy_meetings.meeting_result as r').select('r.id').whereRef('r.org_id', '=', 'm.org_id').whereRef('r.meeting_id', '=', 'm.id').where('r.stage', '=', 'published')),
          eb.exists(eb.selectFrom('ludy_meetings.action_item as a').select('a.id').whereRef('a.org_id', '=', 'm.org_id').whereRef('a.meeting_id', '=', 'm.id').where('a.stage', '=', 'published')),
        ]),
      )
      .orderBy('m.started_at', 'desc')
      .orderBy('m.id')
      .limit(DIGEST_MEETINGS_MAX + 1)
      .execute();
    const meetings = readable.slice(0, DIGEST_MEETINGS_MAX);
    if (meetings.length === 0) return zDigestFacts.parse({ days: input.days, meetings: [], cut: false, empty: true });
    const ids = meetings.map((m) => m.id);
    // Published decisions only, read under the caller's own row security (a published result is read by the readers of its meeting).
    const results = await ctx.trx
      .selectFrom('ludy_meetings.meeting_result')
      .select(['meeting_id', 'decisions'])
      .where('org_id', '=', ctx.orgId)
      .where('stage', '=', 'published')
      .where('meeting_id', 'in', ids)
      .execute();
    const decisionsOf = new Map(
      results.map((r) => [r.meeting_id, (Array.isArray(r.decisions) ? (r.decisions as unknown[]) : []).filter((d): d is string => typeof d === 'string' && d.trim() !== '')] as const),
    );
    // Only the meetings that have a published item are asked for their open items (one read each).
    const withItems = new Set(
      (await ctx.trx.selectFrom('ludy_meetings.action_item').select('meeting_id').distinct().where('org_id', '=', ctx.orgId).where('stage', '=', 'published').where('meeting_id', 'in', ids).execute()).map((r) => r.meeting_id),
    );
    const out: DigestMeeting[] = [];
    let decisionsLeft = DIGEST_DECISIONS_MAX;
    let itemsLeft = DIGEST_ITEMS_MAX;
    // Meetings left unread because of the limit are a cut too.
    let cut = readable.length > DIGEST_MEETINGS_MAX;
    for (const meeting of meetings) {
      const allDecisions = decisionsOf.get(meeting.id) ?? [];
      const allItems = withItems.has(meeting.id) ? await openItemsOf(ctx.trx, ctx.orgId, meeting.id) : [];
      if (allDecisions.length === 0 && allItems.length === 0) continue;
      const decisions = allDecisions.slice(0, decisionsLeft);
      const items = allItems.slice(0, itemsLeft);
      if (decisions.length < allDecisions.length || items.length < allItems.length) cut = true;
      decisionsLeft -= decisions.length;
      itemsLeft -= items.length;
      if (decisions.length > 0 || items.length > 0) out.push({ meetingId: meeting.id, title: meeting.title, startedAt: new Date(meeting.started_at as Date | string).toISOString(), decisions, items });
    }
    return zDigestFacts.parse({ days: input.days, meetings: out, cut, empty: out.length === 0 });
  },
});

// Whether Vy may write the sentences now: the deployment's switch, the member's right to work with Vy, a kill switch of the org, the meetings module or the operator, and this month's budget of the org or the
// module. The kernel's run.start decides again at the click, so this is the answer for the button, not the gate. The expected cost is added by the route, which knows the prices.
export const digestStatus = defineQuery({
  name: 'meetings.digest.status',
  input: zBriefEmpty,
  access: ROLES,
  handler: async (ctx): Promise<DigestStatus> => {
    userOf(ctx.actor);
    const reason = await vyReason(ctx);
    return zDigestStatus.parse({ enabled: reason === null, reason, estimate: null });
  },
});

// Starts the member's own Vy run for one recap: any member with the deployment's switch on. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and the budget,
// makes the member's Vy and this run, and binds the run to a fresh subject ('meetings.digest' and an id no screen sees). Nothing is read or sent here, and the run's result row will hold counts only (the route
// stores them), never a decision or a sentence.
export const digestStart = defineCommand({
  name: 'meetings.digest.start',
  input: zBriefEmpty,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx) => {
    userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('DIGEST_OFF', 422, 'Vy writing the weekly recap is not turned on here');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: DIGEST_FEATURE, subjectType: DIGEST_FEATURE, subjectId: randomUUID() });
    ctx.audit({ runId: started.runId });
    return zAskStarted.parse({ runId: started.runId });
  },
});

export const digestCommands = [digestStart];
export const digestQueries = [digestFacts, digestStatus];
