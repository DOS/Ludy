// SPDX-License-Identifier: AGPL-3.0-only
// The six Meetings reads an MCP grant may run (#3731, #3804, #3837, #4016, #4030, owner decision 2026-11-18, ADR-0051): `ludy_meetings_list` (meetings.mcp.list), `ludy_meeting_minutes` (meetings.mcp.minutes), `ludy_meetings_open_actions` (meetings.mcp.open_actions), `ludy_meetings_series_open_items` (meetings.mcp.series_open_items), `ludy_meetings_decisions` (meetings.mcp.decisions) and `ludy_meetings_search` (meetings.mcp.search). All are R0 reads
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
import { MCP_ACTIONS_MAX, MCP_DECISIONS_MAX, MCP_LINE_MAX, MCP_SEARCH_FIELDS, MCP_SEARCH_MEETINGS_MAX, MCP_SUMMARY_LINES_MAX, plainLine, zMcpDecisionsInput, zMcpMeetingsInput, zMcpMinutesInput, zMcpOpenActionsInput, zMcpSearchInput, zMcpSeriesOpenItemsInput, zMeetingVisibleIdsInput } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { foldQuery, matchLine, snippetAround } from './mcp-search.ts';
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
export interface McpOpenAction {
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  status: 'open';
}
export interface McpOpenActions {
  items: McpOpenAction[];
  total: number;
  truncated: boolean;
}
export interface McpSeriesOpenItems extends McpOpenActions {
  series: boolean;
}
export interface McpDecision {
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  decision: string;
}
export interface McpDecisions {
  items: McpDecision[];
  truncated: boolean;
}
export interface McpSearchHit {
  meetingId: string;
  meetingTitle: string;
  meetingStartedAt: string;
  field: (typeof MCP_SEARCH_FIELDS)[number];
  snippet: string;
}
export interface McpSearch {
  items: McpSearchHit[];
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
    .selectFrom('ludy_meetings.meeting as m')
    .innerJoin('ludy_meetings.meeting_result as r', (join) => join.onRef('r.org_id', '=', 'm.org_id').onRef('r.meeting_id', '=', 'm.id').on('r.stage', '=', 'published'))
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

// The decisions of a published result as plain lines (shared by the minutes and the decisions read, #4016): only the text entries of the stored list, each one plain line cut at MCP_LINE_MAX, the ones
// that are empty once cleaned dropped. `cut` says that something was left out: a decision dropped for being empty once cleaned, or a line cut at the limit (the caller adds its own count limit).
function decisionLinesOf(stored: unknown): { lines: string[]; cut: boolean } {
  const raw = (Array.isArray(stored) ? (stored as unknown[]) : []).filter((d): d is string => typeof d === 'string');
  const lines = raw.map((d) => plainLine(d, MCP_LINE_MAX)).filter((d) => d !== '');
  return { lines, cut: lines.length < raw.length || raw.some((d) => [...plainLine(d, Number.MAX_SAFE_INTEGER)].length > MCP_LINE_MAX) };
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
      .selectFrom('ludy_meetings.action_item')
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
    const decisions = decisionLinesOf(row.decisions);
    return {
      ...rowOf(row as MeetingRowSql),
      summaryLines: summary.lines,
      summaryTruncated: summary.truncated,
      decisions: decisions.lines.slice(0, MCP_DECISIONS_MAX),
      decisionsTruncated: decisions.cut || decisions.lines.length > MCP_DECISIONS_MAX,
      actions: items.slice(0, MCP_ACTIONS_MAX).map((i) => {
        const who = plainLine(i.who_drafted, WHO_MAX);
        return { title: plainLine(i.title, TITLE_MAX), who: who === '' ? null : who, dueDate: i.when_parsed, status: i.task_id !== null ? ('task_made' as const) : ('open' as const) };
      }),
      actionsTruncated: items.length > MCP_ACTIONS_MAX,
    };
  },
});

// The open action items of the meetings `visibleMeetings` admits, optionally those of one series and those due before a day (#3804, #3837): the published, unflagged items nobody made a task of yet, the
// newest meeting first. An item is open while it is `suggested` and no task was made from it (the same reading as `open` in the minutes). Per item exactly: the meeting's id, title and start, the item's
// title, the owner AS SAID (the free `who` text, never the matched user id), the due date when one was matched, and the status. Never a user id, the transcript, a draft or a flagged item. Every text is
// one plain line.
async function openItems(ctx: Pick<QueryContext, 'trx' | 'orgId'>, opts: { dueBefore?: string; seriesId?: string; limit: number }): Promise<McpOpenActions> {
  const filtered = () => {
    let q = visibleMeetings(ctx)
      .innerJoin('ludy_meetings.action_item as a', (join) => join.onRef('a.org_id', '=', 'm.org_id').onRef('a.meeting_id', '=', 'm.id'))
      .where('a.org_id', '=', ctx.orgId)
      .where('a.stage', '=', 'published')
      // Open: not yet accepted and no task made from it (only `action_item_accept` sets either, together).
      .where('a.status', '=', 'suggested')
      .where('a.task_id', 'is', null)
      // An item code flagged (a contact detail in its title, ...) is not handed to an outside AI app: a person reviews it in the app.
      .where(sql<boolean>`a.flags = '[]'::jsonb`);
    // An item with no due date is not before any day, so it is left out when the filter is set.
    if (opts.dueBefore) q = q.where(sql<boolean>`a.when_parsed < ${opts.dueBefore}::date`);
    if (opts.seriesId) q = q.where('m.series_id', '=', opts.seriesId);
    return q;
  };
  const rows = await filtered()
    .select(['m.id as meeting_id', 'm.title as meeting_title', startOf.as('at'), 'a.title', 'a.who_drafted', sql<string | null>`a.when_parsed::text`.as('when_parsed')])
    .orderBy(startOf, 'desc')
    .orderBy('m.id', 'desc')
    .orderBy('a.transcript_seconds')
    .orderBy('a.created_at')
    .orderBy('a.id')
    .limit(opts.limit)
    .execute();
  const counted = await filtered()
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirst();
  const total = Number(counted?.n ?? 0);
  const items = rows.map((r): McpOpenAction => {
    const owner = plainLine(r.who_drafted, WHO_MAX);
    return {
      meetingId: r.meeting_id,
      meetingTitle: plainLine(r.meeting_title, TITLE_MAX),
      meetingStartedAt: (r.at as Date).toISOString(),
      title: plainLine(r.title, TITLE_MAX),
      owner: owner === '' ? null : owner,
      dueDate: r.when_parsed,
      status: 'open',
    };
  });
  return { items, total, truncated: total > items.length };
}

// `ludy_meetings_open_actions` (#3804): the open action items across every meeting a company grant may read.
export const mcpOpenActions = defineQuery({
  name: 'meetings.mcp.open_actions',
  input: zMcpOpenActionsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpOpenActions> => {
    requireCompanyGrant(ctx);
    return await openItems(ctx, { limit: input.limit, ...(input.dueBefore ? { dueBefore: input.dueBefore } : {}) });
  },
});

// `ludy_meetings_series_open_items` (#3837): the open action items of every meeting a company grant may read in the SAME SERIES as the given meeting (which must itself be readable: the same not found as
// the minutes otherwise). No series id leaves Ludy, in or out: the client names a meeting, and `series` only says whether that meeting has a series. Meetings of the series the grant may not read are left out
// and neither counted nor hinted at. A meeting with no series answers an empty list.
export const mcpSeriesOpenItems = defineQuery({
  name: 'meetings.mcp.series_open_items',
  input: zMcpSeriesOpenItemsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSeriesOpenItems> => {
    requireCompanyGrant(ctx);
    const meeting = await visibleMeetings(ctx).where('m.id', '=', input.meetingId).select(['m.series_id']).executeTakeFirst();
    if (!meeting) throw notFound();
    if (meeting.series_id === null) return { series: false, items: [], total: 0, truncated: false };
    return { series: true, ...(await openItems(ctx, { limit: input.limit, seriesId: meeting.series_id })) };
  },
});

// How many meetings `ludy_meetings_decisions` reads at most (one more is asked for, to know that there were more). A window of 30 days holds far fewer meetings with decisions in a small company; a larger one
// is told it was cut (`truncated`), never silently short.
const DECISIONS_MEETINGS_MAX = 100;

// `ludy_meetings_decisions` (#4016): the published decisions of the meetings `visibleMeetings` admits that started in the last 7, 14 or 30 days, the newest meeting first, each meeting's decisions in their stored
// order (at most MCP_DECISIONS_MAX of a meeting, as in the minutes), the first `limit` overall. Per decision exactly: the meeting's id, title and start, and the decision as one plain line. Never the minutes' other
// text, the actions, a user id, the transcript or a draft. `truncated` is true when anything was left out: over `limit`, over a meeting's MCP_DECISIONS_MAX, a line cut or dropped, or more meetings than were
// read. There is no total: an exact one would mean reading every meeting of the window.
export const mcpDecisions = defineQuery({
  name: 'meetings.mcp.decisions',
  input: zMcpDecisionsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpDecisions> => {
    requireCompanyGrant(ctx);
    const since = new Date(Date.now() - input.days * 86_400_000);
    const rows = await visibleMeetings(ctx)
      .where(sql<boolean>`coalesce(m.started_at, m.created_at) >= ${since}`)
      .where(sql<boolean>`(jsonb_typeof(r.decisions) = 'array' AND jsonb_array_length(r.decisions) > 0)`)
      .select(['m.id', 'm.title', startOf.as('at'), 'r.decisions'])
      .orderBy(startOf, 'desc')
      .orderBy('m.id', 'desc')
      .limit(DECISIONS_MEETINGS_MAX + 1)
      .execute();
    let truncated = rows.length > DECISIONS_MEETINGS_MAX;
    const items: McpDecision[] = [];
    for (const row of rows.slice(0, DECISIONS_MEETINGS_MAX)) {
      const { lines, cut } = decisionLinesOf(row.decisions);
      if (cut || lines.length > MCP_DECISIONS_MAX) truncated = true;
      for (const decision of lines.slice(0, MCP_DECISIONS_MAX)) {
        if (items.length >= input.limit) {
          truncated = true;
          break;
        }
        items.push({ meetingId: row.id, meetingTitle: plainLine(row.title, TITLE_MAX), meetingStartedAt: (row.at as Date).toISOString(), decision });
      }
    }
    return { items, truncated };
  },
});

// `ludy_meetings_search` (#4030): a search over the published minutes of the meetings `visibleMeetings` admits, and nothing else. It looks only at the views `ludy_meeting_minutes` can hand out: the title, the first
// MCP_SUMMARY_LINES_MAX summary lines (each cut at MCP_LINE_MAX), the first MCP_DECISIONS_MAX decisions and the titles of the first MCP_ACTIONS_MAX unflagged published action items, built with the same helpers.
// A word past those cuts cannot be confirmed by a search either, so a search is no yes-or-no oracle on text the minutes tool would not return. It does not touch the transcript, the notes, a draft, a translation,
// a reader or the in-app search (`meetings.search`, which reads transcript lines by the caller's reader rights and stays out of reach of a grant). The typed words are folded in code and never reach the database
// (see mcp-search.ts); a hit is ONE line holding every word as the start of one of its words. At most MCP_SEARCH_MEETINGS_MAX of the newest readable meetings are searched; `truncated` is true when older ones were
// not searched or more meetings matched than `limit`. One result per meeting, the first matching line (title, then decisions, then summary, then action items), newest meeting first. No total.
export const mcpSearch = defineQuery({
  name: 'meetings.mcp.search',
  input: zMcpSearchInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpSearch> => {
    requireCompanyGrant(ctx);
    const words = foldQuery(input.q);
    if (words === null) return { items: [], truncated: false };
    const meetings = await visibleMeetings(ctx)
      .select(['m.id', 'm.title', startOf.as('at'), 'r.summary', 'r.decisions'])
      .orderBy(startOf, 'desc')
      .orderBy('m.id', 'desc')
      .limit(MCP_SEARCH_MEETINGS_MAX + 1)
      .execute();
    let truncated = meetings.length > MCP_SEARCH_MEETINGS_MAX;
    const scanned = meetings.slice(0, MCP_SEARCH_MEETINGS_MAX);
    if (scanned.length === 0) return { items: [], truncated };
    // The unflagged published items of those meetings, the first MCP_ACTIONS_MAX of each in the minutes' order, in one query.
    const itemRows = await sql<{ meeting_id: string; title: string }>`
      SELECT x.meeting_id, x.title
        FROM (
          SELECT a.meeting_id, a.title, a.transcript_seconds, a.created_at, a.id,
                 row_number() OVER (PARTITION BY a.meeting_id ORDER BY a.transcript_seconds, a.created_at, a.id) AS n
            FROM ludy_meetings.action_item a
           WHERE a.org_id = ${ctx.orgId}
             AND a.stage = 'published'
             AND a.flags = '[]'::jsonb
             AND a.meeting_id = ANY(${scanned.map((m) => m.id)}::uuid[])
        ) x
       WHERE x.n <= ${MCP_ACTIONS_MAX}
       ORDER BY x.meeting_id, x.n`.execute(ctx.trx);
    const titlesOf = new Map<string, string[]>();
    for (const r of itemRows.rows) titlesOf.set(r.meeting_id, [...(titlesOf.get(r.meeting_id) ?? []), plainLine(r.title, TITLE_MAX)]);
    const items: McpSearchHit[] = [];
    for (const row of scanned) {
      const title = plainLine(row.title, TITLE_MAX);
      const lines: Array<[(typeof MCP_SEARCH_FIELDS)[number], string[]]> = [
        ['title', [title]],
        ['decision', decisionLinesOf(row.decisions).lines.slice(0, MCP_DECISIONS_MAX)],
        ['summary', linesOf(row.summary, MCP_SUMMARY_LINES_MAX).lines],
        ['action', titlesOf.get(row.id) ?? []],
      ];
      let found: { field: (typeof MCP_SEARCH_FIELDS)[number]; snippet: string } | null = null;
      for (const [field, texts] of lines) {
        for (const text of texts) {
          const hit = matchLine(text, words);
          if (hit) {
            found = { field, snippet: snippetAround(text, hit.start, hit.end) };
            break;
          }
        }
        if (found) break;
      }
      if (!found) continue;
      if (items.length >= input.limit) {
        truncated = true;
        break;
      }
      items.push({ meetingId: row.id, meetingTitle: title, meetingStartedAt: (row.at as Date).toISOString(), field: found.field, snippet: found.snippet });
    }
    return { items, truncated };
  },
});

/** Internal company-grant batch visibility check called by projects.mcp.triage_summary via ctx.query; never exposed as a public MCP tool (#4493). */
export const mcpMeetingVisibleIds = defineQuery({
  name: 'meetings.mcp.visible_ids',
  input: zMeetingVisibleIdsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<{ visibleIds: string[] }> => {
    requireCompanyGrant(ctx);
    if (input.meetingIds.length === 0) return { visibleIds: [] };
    const rows = await visibleMeetings(ctx)
      .select('m.id')
      .where('m.id', 'in', [...new Set(input.meetingIds)])
      .execute();
    return { visibleIds: rows.map((r) => r.id) };
  },
});

export const mcpMeetingsQueries = [mcpMeetings, mcpMinutes, mcpOpenActions, mcpSeriesOpenItems, mcpDecisions, mcpSearch, mcpMeetingVisibleIds];
