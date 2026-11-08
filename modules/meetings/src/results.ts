// SPDX-License-Identifier: AGPL-3.0-only
// The summary, the decisions and the action items of a meeting (issue #2580, M6 part A, ADR-0047 points 2 and 8, ADR-0049 decision 8, meetings plan sections
// 5.3 and 8). Everything here is the recorder's own work or a reader's own click, in a signed-in member's context; none of it needs an AI:
//   meetings.summary.save         the recorder types the summary and the decisions: the draft (a new save replaces it).
//   meetings.action_item.create / edit / delete   the recorder's draft items. An edit clears the taint of that item; code recomputes its flags.
//   meetings.result.publish       the recorder's one click (`confirmed: true`): the drafts become published rows, which the meeting's readers read.
//   meetings.action_item.accept   a person makes a team task from an item with the title they confirmed, the date and the seat they picked: the recorder
//                                 from a draft, any reader once it is published. kernel.task.create_from_meeting makes the task (the transcript is never
//                                 copied into it), and the database function action_item_accept marks the item, once.
//   meetings.action_item.accept_clean   the same for every clean item at once (its attendee holds exactly one seat, its date is parsed, its title carries no
//                                 link, email or phone, no flag): never a seat picked for an attendee who holds none or several.
//   meetings.result.get / meetings.action_item.source   what the caller may read, and where a task came from.
// The model's output (part B) lands in the recorder's own member_vy_result and the recorder's own command copies it into the draft rows here, as the
// transcript's does; no agent context writes these tables. Audit rows carry ids and counts, never the text.
import { sql } from 'kysely';
import {
  ITEMS_PER_MEETING_MAX,
  zActionItemAccept,
  zActionItemAcceptClean,
  zActionItemCreate,
  zActionItemEdit,
  zActionItemRef,
  zActionItemSource,
  zMeetingRef,
  zMeetingResultSave,
  zResultPublish,
  type ActionItemView,
  type ItemFlag,
  type MeetingResults,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { vnDayStart } from './retention.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// What code finds wrong with an item's text: a link, an email address or a phone number in a title (a task is read by every member, and a title the model
// wrote from a transcript must not carry a way to reach someone off the page). Fixed words, never the text.
// Linear scans, no backtracking regex: a title is at most ITEM_TITLE_MAX (300) characters in the contract and in the table, and the scans are linear anyway.
const hasLink = (lower: string): boolean => lower.includes('http://') || lower.includes('https://') || lower.includes('www.');
// An email: a non-empty part before an '@' and, between two '@' or after the last, a part with a '.' that has a character on each side of it.
function hasEmail(token: string): boolean {
  const parts = token.split('@');
  for (let i = 1; i < parts.length; i += 1) {
    const before = parts[i - 1] as string;
    const after = parts[i] as string;
    const dot = after.indexOf('.', 1);
    if (before.length > 0 && dot > 0 && dot < after.length - 1) return true;
  }
  return false;
}
// A phone-like run: digits with spaces, dots and dashes between them, nine characters or more from the first digit to the last.
function hasPhone(text: string): boolean {
  let start = -1;
  let last = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const c = i < text.length ? (text[i] as string) : '';
    const digit = c >= '0' && c <= '9';
    if (digit) {
      if (start < 0) start = i;
      last = i;
    } else if (!(c === ' ' || c === '\t' || c === '\n' || c === '.' || c === '-')) {
      if (start >= 0 && last - start + 1 >= 9) return true;
      start = -1;
      last = -1;
    }
  }
  return false;
}
export function itemFlags(title: string): ItemFlag[] {
  const lower = title.toLowerCase();
  const found = hasLink(lower) || hasPhone(title) || lower.split(/\s+/).some((token) => hasEmail(token));
  return found ? ['contact_in_title'] : [];
}

// A clean item: no flag, an attendee matched, a date parsed, exactly one seat held by that attendee. Anything else a person decides one by one.
export function itemIsClean(item: { flags: readonly string[]; whoUserId: string | null; whenDate: string | null }, seats: number): boolean {
  return item.flags.length === 0 && item.whoUserId !== null && item.whenDate !== null && seats === 1;
}

const recorderOnly = (what: string) => new DomainError('FORBIDDEN', 403, `Only the meeting recorder can ${what}`);
const itemNotFound = () => new DomainError('ACTION_ITEM_NOT_FOUND', 404, 'Action item not found');

type Trx = QueryContext['trx'];

// The meeting, and that the caller is its recorder (404 when they cannot read it at all).
async function recorderMeeting(ctx: CommandContext, meetingId: string, what: string) {
  const userId = userOf(ctx.actor);
  const meeting = await openMeeting(ctx.trx, ctx.orgId, meetingId);
  if (meeting.recorder_user_id !== userId) throw recorderOnly(what);
  return { userId, meeting };
}

// An attendee the item may name: the recorder or a reader of the meeting.
async function checkAttendee(trx: Trx, orgId: string, meetingId: string, recorder: string, userId: string | null): Promise<void> {
  if (userId === null || userId === recorder) return;
  const row = await trx.selectFrom('crove_meetings.meeting_reader').select('id').where('org_id', '=', orgId).where('meeting_id', '=', meetingId).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw new DomainError('INVALID_READER', 422, 'An action item can name only the recorder or an attendee of the meeting');
}

export const meetingSummarySave = defineCommand({
  name: 'meetings.summary.save',
  input: zMeetingResultSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    await recorderMeeting(ctx, input.meetingId, 'write its summary');
    // A new save replaces the earlier draft; what the recorder typed is the recorder's own text, so it is not tainted.
    await ctx.trx.deleteFrom('crove_meetings.meeting_result').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').execute();
    await ctx.trx
      .insertInto('crove_meetings.meeting_result')
      .values({ org_id: ctx.orgId, meeting_id: input.meetingId, summary: input.summary, decisions: sql`${JSON.stringify(input.decisions)}::jsonb`, feature: 'manual', stage: 'draft', tainted: false })
      .execute();
    ctx.audit({ meetingId: input.meetingId, decisionCount: input.decisions.length });
    return { meetingId: input.meetingId, decisions: input.decisions.length };
  },
});

export const actionItemCreate = defineCommand({
  name: 'meetings.action_item.create',
  input: zActionItemCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const { userId } = await recorderMeeting(ctx, input.meetingId, 'add action items');
    await checkAttendee(ctx.trx, ctx.orgId, input.meetingId, userId, input.whoUserId);
    const count = await ctx.trx.selectFrom('crove_meetings.action_item').select(sql<string>`count(*)::text`.as('n')).where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).executeTakeFirstOrThrow();
    if (Number(count.n) >= ITEMS_PER_MEETING_MAX) throw new DomainError('TOO_MANY_ITEMS', 422, 'A meeting holds at most 100 action items');
    const row = await ctx.trx
      .insertInto('crove_meetings.action_item')
      .values({
        org_id: ctx.orgId,
        meeting_id: input.meetingId,
        title: input.title,
        who_drafted: input.who,
        who_parsed: input.whoUserId,
        when_drafted: input.when,
        when_parsed: input.whenDate,
        transcript_seconds: input.transcriptSeconds,
        flags: sql`${JSON.stringify(itemFlags(input.title))}::jsonb`,
        stage: 'draft',
        status: 'suggested',
        tainted: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ meetingId: input.meetingId, itemId: row.id });
    return { itemId: row.id };
  },
});

export const actionItemEdit = defineCommand({
  name: 'meetings.action_item.edit',
  input: zActionItemEdit,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    // RLS shows a draft to its recorder only, so any other caller meets the same answer as for an unknown id.
    const item = await ctx.trx.selectFrom('crove_meetings.action_item').select(['meeting_id', 'title']).where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).where('stage', '=', 'draft').executeTakeFirst();
    if (!item) throw itemNotFound();
    const meeting = await openMeeting(ctx.trx, ctx.orgId, item.meeting_id);
    if (meeting.recorder_user_id !== userId) throw itemNotFound();
    if (input.whoUserId !== undefined) await checkAttendee(ctx.trx, ctx.orgId, item.meeting_id, userId, input.whoUserId);
    const title = input.title ?? item.title;
    // Code looks at the title again on every edit.
    await ctx.trx
      .updateTable('crove_meetings.action_item')
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.who === undefined ? {} : { who_drafted: input.who }),
        ...(input.whoUserId === undefined ? {} : { who_parsed: input.whoUserId }),
        ...(input.when === undefined ? {} : { when_drafted: input.when }),
        ...(input.whenDate === undefined ? {} : { when_parsed: input.whenDate }),
        ...(input.transcriptSeconds === undefined ? {} : { transcript_seconds: input.transcriptSeconds }),
        flags: sql`${JSON.stringify(itemFlags(title))}::jsonb`,
        updated_at: sql<Date>`pg_catalog.now()`,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .execute();
    // Only a changed title is the recorder's own text; fixing a date or an attendee leaves the model's title tainted. The mark is cleared by the recorder's
    // review (a definer: the tenant context cannot change it), here for this one item.
    if (input.title !== undefined && input.title !== item.title) {
      await sql`SELECT crove_meetings.draft_review(${ctx.orgId}::uuid, ${item.meeting_id}::uuid, ${input.itemId}::uuid)`.execute(ctx.trx);
    }
    ctx.audit({ itemId: input.itemId, meetingId: item.meeting_id });
    return { itemId: input.itemId };
  },
});

export const actionItemDelete = defineCommand({
  name: 'meetings.action_item.delete',
  input: zActionItemRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const item = await ctx.trx.selectFrom('crove_meetings.action_item').select('meeting_id').where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).where('stage', '=', 'draft').executeTakeFirst();
    if (!item) throw itemNotFound();
    const meeting = await openMeeting(ctx.trx, ctx.orgId, item.meeting_id);
    if (meeting.recorder_user_id !== userId) throw itemNotFound();
    await ctx.trx.deleteFrom('crove_meetings.action_item').where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).execute();
    ctx.audit({ itemId: input.itemId, meetingId: item.meeting_id });
    return { itemId: input.itemId, deleted: true as const };
  },
});

export const resultPublish = defineCommand({
  name: 'meetings.result.publish',
  input: zResultPublish,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    await recorderMeeting(ctx, input.meetingId, 'share its summary');
    // Text the model wrote is shared only after the recorder has read it (meetings.draft.review) or rewritten it; the database refuses it too.
    const unread = await ctx.trx
      .selectFrom('crove_meetings.meeting_result')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'draft')
      .where('tainted', '=', true)
      .unionAll(ctx.trx.selectFrom('crove_meetings.action_item').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').where('status', '=', 'suggested').where('tainted', '=', true))
      .executeTakeFirst();
    if (unread) throw new DomainError('DRAFT_NOT_REVIEWED', 409, 'Read the draft Vy wrote before sharing it');
    const draft = await ctx.trx.selectFrom('crove_meetings.meeting_result').select('id').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'draft').executeTakeFirst();
    // The draft replaces the summary published before it (one published summary a meeting).
    let results = 0;
    if (draft) {
      await ctx.trx.deleteFrom('crove_meetings.meeting_result').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('stage', '=', 'published').execute();
      await ctx.trx.updateTable('crove_meetings.meeting_result').set({ stage: 'published', updated_at: sql<Date>`pg_catalog.now()` }).where('org_id', '=', ctx.orgId).where('id', '=', draft.id).execute();
      results = 1;
    }
    const items = await ctx.trx
      .updateTable('crove_meetings.action_item')
      .set({ stage: 'published', updated_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'draft')
      .where('status', '=', 'suggested')
      .returning('id')
      .execute();
    if (results === 0 && items.length === 0) throw new DomainError('NOTHING_TO_PUBLISH', 409, 'There is no draft to share');
    ctx.audit({ meetingId: input.meetingId, results, items: items.length });
    return { meetingId: input.meetingId, results, items: items.length };
  },
});

// Makes the task of one item, and marks the item (once). The caller has read the item under RLS; the database function checks again that they may accept it.
async function acceptItem(ctx: CommandContext, itemId: string, choice: { title: string; due: string | null; positionId: string }): Promise<string> {
  const item = await ctx.trx.selectFrom('crove_meetings.action_item').select(['id', 'meeting_id', 'title', 'status', 'tainted']).where('org_id', '=', ctx.orgId).where('id', '=', itemId).executeTakeFirst();
  if (!item) throw itemNotFound();
  await openMeeting(ctx.trx, ctx.orgId, item.meeting_id); // the text-retention gate, as for every other read and write of a meeting's text
  if (item.status !== 'suggested') throw new DomainError('ACTION_ITEM_ACCEPTED', 409, 'A task was already made from this action item');
  // `tainted` stays while the model's text is unedited: the item still holds it and the person kept the title.
  const created = await ctx.run<{ taskId: string }>('kernel.task.create_from_meeting', {
    itemId,
    title: choice.title,
    positionId: choice.positionId,
    due: choice.due === null ? null : vnDayStart(choice.due),
    tainted: item.tainted && choice.title === item.title,
  });
  try {
    await sql`SELECT crove_meetings.action_item_accept(${ctx.orgId}::uuid, ${itemId}::uuid, ${created.taskId}::uuid)`.execute(ctx.trx);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('MEETINGS_ITEM_ACCEPTED')) throw new DomainError('ACTION_ITEM_ACCEPTED', 409, 'A task was already made from this action item');
    if (message.includes('MEETINGS_ITEM_')) throw itemNotFound();
    throw error;
  }
  return created.taskId;
}

export const actionItemAccept = defineCommand({
  name: 'meetings.action_item.accept',
  input: zActionItemAccept,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const taskId = await acceptItem(ctx, input.itemId, { title: input.title, due: input.due, positionId: input.positionId });
    ctx.audit({ itemId: input.itemId, taskId });
    return { itemId: input.itemId, taskId };
  },
});

// The seats an attendee holds now: active positions whose holder they are.
async function seatsOf(trx: Trx, orgId: string, userIds: readonly string[]): Promise<Map<string, Array<{ id: string; title: string }>>> {
  const seats = new Map<string, Array<{ id: string; title: string }>>();
  if (userIds.length === 0) return seats;
  const rows = await trx.selectFrom('crove_kernel.position').select(['id', 'title', 'holder_user_id']).where('org_id', '=', orgId).where('status', '=', 'active').where('holder_user_id', 'in', [...userIds]).execute();
  for (const row of rows) if (row.holder_user_id) seats.set(row.holder_user_id, [...(seats.get(row.holder_user_id) ?? []), { id: row.id, title: row.title }]);
  return seats;
}

export const actionItemAcceptClean = defineCommand({
  name: 'meetings.action_item.accept_clean',
  input: zActionItemAcceptClean,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    // The items the caller reads and may still accept (RLS: the recorder reads drafts and published, a reader published only).
    const rows = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select(['id', 'title', 'flags', 'who_parsed', sql<string | null>`when_parsed::text`.as('when_parsed')])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('status', '=', 'suggested')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const seats = await seatsOf(ctx.trx, ctx.orgId, rows.flatMap((r) => (r.who_parsed ? [r.who_parsed] : [])));
    const taskIds: string[] = [];
    for (const row of rows) {
      const held = row.who_parsed ? (seats.get(row.who_parsed) ?? []) : [];
      const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
      if (!itemIsClean({ flags, whoUserId: row.who_parsed, whenDate: row.when_parsed }, held.length)) continue;
      // Each item is its own nested command run with a savepoint: an item another person accepted since the list was read is left to them (its task, if one
      // was begun, is undone with the savepoint), and any other refusal ends the click.
      const attempt = await ctx.tryRun<{ itemId: string; taskId: string }>(
        'meetings.action_item.accept',
        { itemId: row.id, confirmed: true, title: row.title, due: row.when_parsed, positionId: (held[0] as { id: string }).id },
        { recover: (refusal) => refusal.code === 'ACTION_ITEM_ACCEPTED' },
      );
      if (attempt.status === 'ok') taskIds.push(attempt.value.taskId);
    }
    if (taskIds.length === 0) throw new DomainError('NO_CLEAN_ITEMS', 409, 'There is no clean action item to accept');
    ctx.audit({ meetingId: input.meetingId, accepted: taskIds.length });
    return { meetingId: input.meetingId, accepted: taskIds.length, taskIds };
  },
});

// What the caller may read of a meeting's summary and items: the recorder a draft beside the published one, a reader the published one only. A sensitive read
// (each leaves an audit row naming the meeting).
export const meetingResultGet = defineQuery({
  name: 'meetings.result.get',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MeetingResults> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const results = await ctx.trx.selectFrom('crove_meetings.meeting_result').select(['id', 'feature', 'stage', 'summary', 'decisions', 'tainted']).where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).execute();
    const items = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select(['id', 'stage', 'status', 'title', 'who_drafted', 'who_parsed', 'when_drafted', sql<string | null>`when_parsed::text`.as('when_parsed'), 'transcript_seconds', 'flags', 'tainted', 'task_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('transcript_seconds')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const seats = await seatsOf(ctx.trx, ctx.orgId, items.flatMap((i) => (i.who_parsed ? [i.who_parsed] : [])));
    const view = (stage: 'draft' | 'published') => {
      const r = results.find((x) => x.stage === stage);
      return r ? { id: r.id, feature: r.feature as 'manual' | 'meetings.summary', stage, summary: r.summary, decisions: Array.isArray(r.decisions) ? (r.decisions as string[]) : [], tainted: r.tainted } : null;
    };
    return {
      meetingId: input.meetingId,
      isRecorder: meeting.recorder_user_id === userId,
      draft: view('draft'),
      published: view('published'),
      items: items.map((i): ActionItemView => {
        const held = i.who_parsed ? (seats.get(i.who_parsed) ?? []) : [];
        const flags = (Array.isArray(i.flags) ? i.flags : []) as ItemFlag[];
        return {
          id: i.id,
          stage: i.stage as 'draft' | 'published',
          status: i.status as 'suggested' | 'accepted',
          title: i.title,
          who: i.who_drafted,
          whoUserId: i.who_parsed,
          when: i.when_drafted,
          whenDate: i.when_parsed,
          transcriptSeconds: i.transcript_seconds,
          flags,
          tainted: i.tainted,
          taskId: i.task_id,
          positions: held,
          clean: i.status === 'suggested' && itemIsClean({ flags, whoUserId: i.who_parsed, whenDate: i.when_parsed }, held.length),
        };
      }),
    };
  },
});

// For the link on a task made from an item: the meeting when the caller may read it (the recorder for a draft, a reader for a published item); anyone else
// meets the same 404 as for an unknown item, which the task's screen words as "Bản ghi không mở được".
export const actionItemSource = defineQuery({
  name: 'meetings.action_item.source',
  input: zActionItemRef,
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input): Promise<{ meetingId: string }> => {
    const item = await ctx.trx.selectFrom('crove_meetings.action_item').select('meeting_id').where('org_id', '=', ctx.orgId).where('id', '=', input.itemId).executeTakeFirst();
    if (!item) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    await openMeeting(ctx.trx, ctx.orgId, item.meeting_id);
    return zActionItemSource.parse({ meetingId: item.meeting_id });
  },
});

export const resultCommands = [meetingSummarySave, actionItemCreate, actionItemEdit, actionItemDelete, resultPublish, actionItemAccept, actionItemAcceptClean];
export const resultQueries = [meetingResultGet, actionItemSource];
