// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy naming who an action item belongs to, the module's side (#3921, step 2). Step 1 (assignee-match.ts, `suggestion` on meetings.result.get) finds the person by code and works with AI off. This is the
// extra for the item code could not place, and it is the member's own click.
//
// meetings.assignee.facts   for an item the caller reads: the said name and the people the caller may give the work to (the attendees first, then the other members, each with the seats they hold now), read in
//                           the caller's own transaction. `eligible` is false when there is nothing to ask: the item already names a person or has a task, code finds a person, the text is empty or too long to
//                           be a name, or nobody can be offered. Nothing is stored.
// meetings.assignee.status  whether Vy may be asked now (the same switches as asking across meetings).
// meetings.assignee.start   starts the member's own Vy run for one question (the kernel's run.start checks vy.use, the kill switches and the budget).
// The model call, the checks on its answer and the counts-only result row are in apps/kernel (member-vy-ports.ts) and packages/agent (member-vy/meetings-assignee.ts).
import { randomUUID } from 'node:crypto';
import { ASSIGNEE_PEOPLE_MAX, zAskStarted, zAssigneeAsk, zAssigneeFacts, zAssigneeStatus, zBriefEmpty, type AssigneeFacts, type AssigneeStatus } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { vyReason } from './ask.ts';
import { memberNames, seatsOf } from './results.ts';
import { matchAssignee } from './assignee-match.ts';
import { attendeeNames } from './speaker.ts';
import { isSummaryEnabled } from './summary-run.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export const ASSIGNEE_FEATURE = 'meetings.assignee';

// A said name is a few words: a text longer than this is a sentence, which no model is asked about (the agent refuses the same bounds).
const SAID_CHARS_MAX = 80;
const SAID_WORDS_MAX = 8;

export const assigneeFacts = defineQuery({
  name: 'meetings.assignee.facts',
  input: zAssigneeAsk,
  access: ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<AssigneeFacts> => {
    userOf(ctx.actor);
    // The item as the caller may read it (row security: the recorder reads drafts and published items, a reader published ones).
    const item = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select(['meeting_id', 'status', 'who_drafted', 'who_parsed'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!item) throw new DomainError('ACTION_ITEM_NOT_FOUND', 404, 'Action item not found');
    const meeting = await openMeeting(ctx.trx, ctx.orgId, item.meeting_id);
    const said = item.who_drafted.trim();
    const none = (): AssigneeFacts => zAssigneeFacts.parse({ eligible: false, said: '', people: [] });
    if (item.status !== 'suggested' || item.who_parsed !== null || said === '' || said.length > SAID_CHARS_MAX || said.split(/\s+/u).length > SAID_WORDS_MAX) return none();
    const attendees = await attendeeNames(ctx, item.meeting_id, meeting.recorder_user_id);
    // In name order, so the numbers the model reads carry no hint of who joined first.
    const members = (await memberNames(ctx)).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    // Code first: the model is asked only when code found nobody. When code finds a person, finds the name ambiguous (two people answer to it: code refused to guess, and so does the model) or finds no name in the
    // text, there is nothing to ask.
    if (matchAssignee(said, attendees, members).kind !== 'none') return none();
    const room = new Set(attendees.map((p) => p.userId));
    const everyone = [...attendees.map((p) => ({ ...p, source: 'attendee' as const })), ...members.filter((p) => !room.has(p.userId)).map((p) => ({ ...p, source: 'member' as const }))];
    // Too many people: only the people in the room, and with more of them than the bound, nobody (a cut list would hide the right person).
    const people = everyone.length <= ASSIGNEE_PEOPLE_MAX ? everyone : everyone.filter((p) => p.source === 'attendee');
    if (people.length === 0 || people.length > ASSIGNEE_PEOPLE_MAX) return none();
    const seats = await seatsOf(ctx.trx, ctx.orgId, people.map((p) => p.userId));
    return zAssigneeFacts.parse({ eligible: true, said, people: people.map((p) => ({ userId: p.userId, name: p.name, source: p.source, positions: seats.get(p.userId) ?? [] })) });
  },
});

// Whether Vy may be asked now: the deployment's switch, the member's right to work with Vy, a kill switch of the org, the meetings module or the operator, and this month's budget. The kernel's run.start decides
// again at the click, so this is the answer for the button, not the gate.
export const assigneeStatus = defineQuery({
  name: 'meetings.assignee.status',
  input: zBriefEmpty,
  access: ROLES,
  handler: async (ctx): Promise<AssigneeStatus> => {
    userOf(ctx.actor);
    const reason = await vyReason(ctx);
    return zAssigneeStatus.parse({ enabled: reason === null, reason, estimate: null });
  },
});

// Starts the member's own Vy run for one question: any member with the deployment's switch on. The kernel's run.start then checks vy.use, the org, module and agent kill switches, the global ai switch and the
// budget, makes the member's Vy and this run, and binds the run to a fresh subject ('meetings.assignee' and an id no screen sees). Nothing is read or sent here, and the run's result row will hold counts only
// (the route stores them), never a name.
export const assigneeStart = defineCommand({
  name: 'meetings.assignee.start',
  input: zBriefEmpty,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx) => {
    userOf(ctx.actor);
    if (!isSummaryEnabled()) throw new DomainError('ASSIGNEE_OFF', 422, 'Vy naming who an action item belongs to is not turned on here');
    const started = await ctx.run<{ runId: string }>('kernel.member_vy.run.start', { feature: ASSIGNEE_FEATURE, subjectType: ASSIGNEE_FEATURE, subjectId: randomUUID() });
    ctx.audit({ runId: started.runId });
    return zAskStarted.parse({ runId: started.runId });
  },
});

export const assigneeCommands = [assigneeStart];
export const assigneeQueries = [assigneeFacts, assigneeStatus];
