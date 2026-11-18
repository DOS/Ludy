// SPDX-License-Identifier: AGPL-3.0-only
// The two Meetings reads an MCP grant may run (#3731, owner decision 2026-11-18, ADR-0051): `ludy_meetings_list` (meetings.mcp.list) and `ludy_meeting_minutes` (meetings.mcp.minutes). Both are R0 reads
// for a COMPANY grant (an owner's or admin's); the scope is `ludy.read`. A member grant reads nothing of Meetings (the hold of 2026-11-13 on member-private tools stays): the tools are not listed for it,
// the queries refuse it, and the database gives its sealed context no row of the module.
//
// What a company grant reads is the PUBLISHED results of meetings whose visibility is 'org' (the recorder chose "cả công ty"), the same minutes every member already reads, and nothing else. The database
// holds that line first (the three read policies of meeting, meeting_result and action_item admit the sealed company context only for an org-visible meeting with a published result whose text period has
// not ended, for the whole-org scope, and for a published item that no flag marks; #3790); the queries below ask for the same again. Never returned: the transcript, the recorder's notes, drafts,
// translations, live lines, readers and attendees, consent records, the recording, the speaker names, the minutes template's name, the meeting's origin (how it was recorded), the recorder's id and any user id,
// the task made from an item, and every meeting of attendees only, even one the grant's own person recorded. Never reachable, as tables: the transcript, notes, drafts, translations, live lines, readers and
// the consent records have no branch. The database does admit whole rows of the meetings it may read, so the columns of a meeting row (the recorder's id, the consent columns, the retention dates) are
// reachable there, and only this projection leaves them out (its keys are pinned in meetings-mcp-projection.db.test.ts). Per meeting: id, title, start, length, language and the time its minutes were published. Per minutes: those and the minutes' text as plain lines (the template's
// headings are lines of it), the decisions as plain lines (at most MCP_DECISIONS_MAX), and the action items (at most MCP_ACTIONS_MAX: title, who as it was said, the due date when one was matched, and
// whether it was made a task; an item code flagged as holding a contact detail is left out). Every text is one plain line (see plainLine) and reaches the client as data, never as an instruction: minutes are what people and a model wrote.
//
// A meeting that is unknown, of another org, of attendees only, not published, or whose text period ended answers one and the same MEETING_NOT_FOUND, so a client learns nothing about meetings it may not read.
import { sql } from 'kysely';
import { MCP_ACTIONS_MAX, MCP_DECISIONS_MAX, MCP_LINE_MAX, MCP_SUMMARY_LINES_MAX, plainLine, zMcpMeetingsInput, zMcpMinutesInput } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { vnDay } from './retention.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
const TITLE_MAX = 300;
const WHO_MAX = 200;

export interface McpMeetingRow {
  id: string;
  title: string;
  startedAt: string;
  lengthSeconds: number | null;
  language: 'vi' | 'en';
  publishedAt: string;
}
export interface McpMeetings {
  meetings: McpMeetingRow[];
  total: number;
  truncated: boolean;
}
export interface McpMinutes extends McpMeetingRow {
  summaryLines: string[];
  summaryTruncated: boolean;
  decisions: string[];
  decisionsTruncated: boolean;
  actions: Array<{ title: string; who: string | null; dueDate: string | null; status: 'open' | 'task_made' }>;
  actionsTruncated: boolean;
}

function requireCompanyGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp || ctx.actor.mcp.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
}

const notFound = () => new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');

// The meetings a company grant may list: visibility 'org', a published result, and a text period that has not ended (a purge may not have run yet; the commands treat such a meeting as gone).
function visibleMeetings(ctx: Pick<QueryContext, 'trx' | 'orgId'>) {
  return ctx.trx
    .selectFrom('crove_meetings.meeting as m')
    .innerJoin('crove_meetings.meeting_result as r', (join) => join.onRef('r.org_id', '=', 'm.org_id').onRef('r.meeting_id', '=', 'm.id').on('r.stage', '=', 'published'))
    .where('m.org_id', '=', ctx.orgId)
    .where('m.visibility', '=', 'org')
    .where(sql<boolean>`(m.text_retention_date IS NULL OR m.text_retention_date > ${vnDay(new Date())}::date)`);
}

const startOf = sql<Date>`coalesce(m.started_at, m.created_at)`;

interface MeetingRowSql {
  id: string;
  title: string;
  at: Date;
  length_seconds: number | null;
  language: string;
  published_at: Date;
}
const rowOf = (r: MeetingRowSql): McpMeetingRow => ({
  id: r.id,
  title: plainLine(r.title, TITLE_MAX),
  startedAt: r.at.toISOString(),
  lengthSeconds: r.length_seconds,
  language: r.language === 'en' ? 'en' : 'vi',
  publishedAt: r.published_at.toISOString(),
});

// `ludy_meetings_list`: the org-visible meetings with published minutes, the latest first.
export const mcpMeetings = defineQuery({
  name: 'meetings.mcp.list',
  input: zMcpMeetingsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpMeetings> => {
    requireCompanyGrant(ctx);
    const filtered = () => {
      let q = visibleMeetings(ctx);
      if (input.from) q = q.where(sql<boolean>`coalesce(m.started_at, m.created_at) >= ${new Date(input.from)}`);
      if (input.to) q = q.where(sql<boolean>`coalesce(m.started_at, m.created_at) < ${new Date(input.to)}`);
      return q;
    };
    const rows = await filtered()
      .select(['m.id', 'm.title', startOf.as('at'), 'm.length_seconds', 'm.language', 'r.updated_at as published_at'])
      .orderBy(startOf, 'desc')
      .orderBy('m.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await filtered()
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    const total = Number(counted?.n ?? 0);
    const meetings = rows.map((r) => rowOf(r as MeetingRowSql));
    return { meetings, total, truncated: total > meetings.length };
  },
});

// A text as plain lines, each cut at MCP_LINE_MAX, the empty ones dropped; the flag says when a line was cut or more than `max` lines were left out.
function linesOf(text: string, max: number): { lines: string[]; truncated: boolean } {
  let cut = false;
  const all = text
    .split(/\r?\n/)
    .map((raw) => {
      const whole = plainLine(raw, Number.MAX_SAFE_INTEGER);
      const line = [...whole].slice(0, MCP_LINE_MAX).join('').trim();
      if ([...whole].length > [...line].length) cut = true;
      return line;
    })
    .filter((line) => line !== '');
  return { lines: all.slice(0, max), truncated: cut || all.length > max };
}

// `ludy_meeting_minutes`: the published minutes of one org-visible meeting.
export const mcpMinutes = defineQuery({
  name: 'meetings.mcp.minutes',
  input: zMcpMinutesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpMinutes> => {
    requireCompanyGrant(ctx);
    const row = await visibleMeetings(ctx)
      .where('m.id', '=', input.meetingId)
      .select(['m.id', 'm.title', startOf.as('at'), 'm.length_seconds', 'm.language', 'r.updated_at as published_at', 'r.summary', 'r.decisions'])
      .executeTakeFirst();
    if (!row) throw notFound();
    const items = await ctx.trx
      .selectFrom('crove_meetings.action_item')
      .select(['title', 'who_drafted', sql<string | null>`when_parsed::text`.as('when_parsed'), 'status', 'task_id'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('stage', '=', 'published')
      // An item code flagged (a contact detail in its title, ...) is not handed to an outside AI app: a person reviews it in the app.
      .where(sql<boolean>`flags = '[]'::jsonb`)
      .orderBy('transcript_seconds')
      .orderBy('created_at')
      .orderBy('id')
      .limit(MCP_ACTIONS_MAX + 1)
      .execute();
    const summary = linesOf(row.summary, MCP_SUMMARY_LINES_MAX);
    const rawDecisions = (Array.isArray(row.decisions) ? (row.decisions as unknown[]) : []).filter((d): d is string => typeof d === 'string');
    const decisionText = rawDecisions.map((d) => plainLine(d, MCP_LINE_MAX)).filter((d) => d !== '');
    // Something was left out when a decision was dropped (empty once cleaned), cut at the line limit, or beyond the count.
    const decisionsCut = decisionText.length < rawDecisions.length || rawDecisions.some((d) => [...plainLine(d, Number.MAX_SAFE_INTEGER)].length > MCP_LINE_MAX);
    return {
      ...rowOf(row as MeetingRowSql),
      summaryLines: summary.lines,
      summaryTruncated: summary.truncated,
      decisions: decisionText.slice(0, MCP_DECISIONS_MAX),
      decisionsTruncated: decisionsCut || decisionText.length > MCP_DECISIONS_MAX,
      actions: items.slice(0, MCP_ACTIONS_MAX).map((i) => {
        const who = plainLine(i.who_drafted, WHO_MAX);
        return { title: plainLine(i.title, TITLE_MAX), who: who === '' ? null : who, dueDate: i.when_parsed, status: i.task_id !== null ? ('task_made' as const) : ('open' as const) };
      }),
      actionsTruncated: items.length > MCP_ACTIONS_MAX,
    };
  },
});

export const mcpMeetingsQueries = [mcpMeetings, mcpMinutes];
