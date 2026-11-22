// SPDX-License-Identifier: AGPL-3.0-only
// Code-assisted draft redaction (#4001, ADR-0047): deterministic detection across all draft publish surfaces;
// typed non-value marks; no undo store; recorder-only; drops private Vy results and draft translations so redacted text cannot return.
import { sql } from 'kysely';
import {
  REDACTION_CANDIDATES_MAX,
  REDACTION_MARK_BY_KIND,
  type ItemFlag,
  type RedactionCandidate,
  type RedactionCountsByKind,
  type RedactionKind,
  type RedactionSelection,
  type RedactionSurface,
  type TranscriptRedactCandidates,
  type TranscriptRedacted,
  zMeetingRef,
  zTranscriptRedact,
  zTranscriptRedactCandidates,
  zTranscriptRedacted,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { itemFlags } from './results.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

const MAX_LENGTH_BY_SURFACE: Readonly<Record<RedactionSurface, number>> = {
  'transcript_segment.text': 4000,
  'transcript_segment.speaker_label': 80,
  'meeting_result.summary': 8000,
  'meeting_result.decision': 500,
  'action_item.title': 300,
  'action_item.who_drafted': 200,
  'action_item.when_drafted': 200,
  'meeting_chapter.title': 80,
  'meeting.title': 200,
};

interface LockedSegment {
  id: string;
  stage: string;
  text: string;
  speaker_label: string;
  version: string;
}

interface LockedResult {
  id: string;
  stage: string;
  summary: string;
  decisions: unknown;
  version: string;
}

interface LockedActionItem {
  id: string;
  stage: string;
  status: string;
  title: string;
  who_drafted: string;
  when_drafted: string;
  flags: unknown;
  version: string;
}

interface LockedChapter {
  id: string;
  stage: string;
  title: string;
  version: string;
}

async function meetingHasPublished(trx: Trx, orgId: string, meetingId: string): Promise<boolean> {
  const { rows } = await sql<{ published: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM crove_meetings.transcript_segment s WHERE s.org_id = ${orgId}::uuid AND s.meeting_id = ${meetingId}::uuid AND s.stage = 'published')
      OR EXISTS (SELECT 1 FROM crove_meetings.meeting_result r WHERE r.org_id = ${orgId}::uuid AND r.meeting_id = ${meetingId}::uuid AND r.stage = 'published')
      OR EXISTS (SELECT 1 FROM crove_meetings.action_item i WHERE i.org_id = ${orgId}::uuid AND i.meeting_id = ${meetingId}::uuid AND i.stage = 'published')
      OR EXISTS (SELECT 1 FROM crove_meetings.meeting_chapter c WHERE c.org_id = ${orgId}::uuid AND c.meeting_id = ${meetingId}::uuid AND c.stage = 'published')
    ) AS published`.execute(trx);
  return rows[0]?.published ?? false;
}

async function findExistingStages(
  trx: Trx,
  orgId: string,
  meetingId: string,
  segIds: readonly string[],
  resIds: readonly string[],
  itemIds: readonly string[],
  chapIds: readonly string[],
): Promise<{
  segStage: Map<string, string>;
  resStage: Map<string, string>;
  itemState: Map<string, { stage: string; status: string }>;
  chapStage: Map<string, string>;
}> {
  // Plain SELECT uses SELECT RLS (recorder sees published and accepted rows too, unlike FOR NO KEY UPDATE which applies UPDATE RLS).
  const [segs, res, items, chaps] = await Promise.all([
    segIds.length > 0
      ? sql<{ id: string; stage: string }>`
          SELECT id, stage FROM crove_meetings.transcript_segment
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(segIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    resIds.length > 0
      ? sql<{ id: string; stage: string }>`
          SELECT id, stage FROM crove_meetings.meeting_result
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(resIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    itemIds.length > 0
      ? sql<{ id: string; stage: string; status: string }>`
          SELECT id, stage, status FROM crove_meetings.action_item
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(itemIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    chapIds.length > 0
      ? sql<{ id: string; stage: string }>`
          SELECT id, stage FROM crove_meetings.meeting_chapter
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(chapIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    segStage: new Map(segs.rows.map((r) => [r.id, r.stage])),
    resStage: new Map(res.rows.map((r) => [r.id, r.stage])),
    itemState: new Map(items.rows.map((r) => [r.id, { stage: r.stage, status: r.status }])),
    chapStage: new Map(chaps.rows.map((r) => [r.id, r.stage])),
  };
}

async function lockSegments(trx: Trx, orgId: string, meetingId: string, ids: readonly string[]): Promise<Map<string, LockedSegment>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<LockedSegment>`
    SELECT id, stage, text, speaker_label,
           pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
    FROM crove_meetings.transcript_segment
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(ids)}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

async function lockResults(trx: Trx, orgId: string, meetingId: string, ids: readonly string[]): Promise<Map<string, LockedResult>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<LockedResult>`
    SELECT id, stage, summary, decisions,
           pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
    FROM crove_meetings.meeting_result
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(ids)}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

async function lockActionItems(trx: Trx, orgId: string, meetingId: string, ids: readonly string[]): Promise<Map<string, LockedActionItem>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<LockedActionItem>`
    SELECT id, stage, status, title, who_drafted, when_drafted, flags,
           pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
    FROM crove_meetings.action_item
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(ids)}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

async function lockChapters(trx: Trx, orgId: string, meetingId: string, ids: readonly string[]): Promise<Map<string, LockedChapter>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<LockedChapter>`
    SELECT id, stage, title,
           pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
    FROM crove_meetings.meeting_chapter
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(ids)}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

const staleError = () => new DomainError('REDACTION_STALE', 409, 'This draft changed since you reviewed it; reload and review again');
const publishedError = () => new DomainError('REDACTION_PUBLISHED_IMMUTABLE', 409, 'Published meeting text cannot be redacted');
const mismatchError = () => new DomainError('REDACTION_SPAN_MISMATCH', 422, 'Selected item no longer matches detected personal data');

async function redactField(trx: Trx, text: string, selections: ReadonlyArray<RedactionSelection>, maxLen: number): Promise<string> {
  const { rows: detected } = await sql<{ kind: string; start_pos: number }>`
    SELECT kind, start_pos FROM crove_kernel.text_detect(${text}::text) ORDER BY start_pos`.execute(trx);
  const byStart = new Map(detected.map((d) => [d.start_pos, d.kind]));
  for (const sel of selections) {
    if (byStart.get(sel.startPos) !== sel.kind) throw mismatchError();
  }
  const starts = selections.map((s) => s.startPos);
  const kinds = selections.map((s) => s.kind);
  const marks = selections.map((s) => REDACTION_MARK_BY_KIND[s.kind]);
  const { rows: outRows } = await sql<{ redacted: string | null }>`
    SELECT pg_catalog.left(
      crove_kernel.text_redact_spans(
        ${text}::text,
        ${sql.val(starts)}::integer[],
        ${sql.val(kinds)}::text[],
        ${sql.val(marks)}::text[]
      ),
      ${maxLen}::integer
    ) AS redacted`.execute(trx);
  const redacted = outRows[0]?.redacted;
  if (redacted === null || redacted === undefined || redacted === text || redacted.length === 0) {
    throw mismatchError();
  }
  return redacted;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function decisionStrings(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((d): d is string => typeof d === 'string')) return null;
  return [...raw];
}

// Scans all draft publish surfaces of one meeting for structured personal values using deterministic SQL detection.
export const transcriptRedactCandidates = defineQuery({
  name: 'meetings.transcript.redact_candidates',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TranscriptRedactCandidates> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can review redaction candidates');
    }
    const titleEditable = !(await meetingHasPublished(ctx.trx, ctx.orgId, input.meetingId));
    const { rows } = await sql<{
      surface: RedactionSurface;
      target_id: string;
      decision_index: number | null;
      kind: RedactionKind;
      start_pos: number;
      end_pos: number;
      match_text: string;
      version: string;
      start_seconds: number | null;
    }>`
      WITH raw_hits AS (
        SELECT
          0 AS surface_order,
          0::double precision AS order_num,
          m.created_at AS order_at,
          m.id AS order_id,
          0 AS sub_order,
          'meeting.title'::text AS surface,
          m.id AS target_id,
          NULL::integer AS decision_index,
          d.kind,
          d.start_pos,
          d.end_pos,
          d.match_text,
          pg_catalog.to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version,
          NULL::double precision AS start_seconds
        FROM crove_meetings.meeting m
        CROSS JOIN LATERAL crove_kernel.text_detect(m.title) d
        WHERE ${titleEditable}::boolean AND m.org_id = ${ctx.orgId}::uuid AND m.id = ${input.meetingId}::uuid

        UNION ALL

        SELECT
          1, s.start_seconds::double precision, s.created_at, s.id, 0,
          'transcript_segment.text', s.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          s.start_seconds::double precision
        FROM crove_meetings.transcript_segment s
        CROSS JOIN LATERAL crove_kernel.text_detect(s.text) d
        WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${input.meetingId}::uuid AND s.stage = 'draft'

        UNION ALL

        SELECT
          2, s.start_seconds::double precision, s.created_at, s.id, 0,
          'transcript_segment.speaker_label', s.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          s.start_seconds::double precision
        FROM crove_meetings.transcript_segment s
        CROSS JOIN LATERAL crove_kernel.text_detect(s.speaker_label) d
        WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${input.meetingId}::uuid AND s.stage = 'draft'

        UNION ALL

        SELECT
          3, 0::double precision, r.created_at, r.id, 0,
          'meeting_result.summary', r.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          NULL::double precision
        FROM crove_meetings.meeting_result r
        CROSS JOIN LATERAL crove_kernel.text_detect(r.summary) d
        WHERE r.org_id = ${ctx.orgId}::uuid AND r.meeting_id = ${input.meetingId}::uuid AND r.stage = 'draft'

        UNION ALL

        SELECT
          4, (dec.ord - 1)::double precision, r.created_at, r.id, (dec.ord - 1)::integer,
          'meeting_result.decision', r.id, (dec.ord - 1)::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          NULL::double precision
        FROM crove_meetings.meeting_result r
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(r.decisions) WITH ORDINALITY AS dec(v, ord)
        CROSS JOIN LATERAL crove_kernel.text_detect(dec.v #>> '{}') d
        WHERE r.org_id = ${ctx.orgId}::uuid AND r.meeting_id = ${input.meetingId}::uuid AND r.stage = 'draft'
          AND pg_catalog.jsonb_typeof(dec.v) = 'string'

        UNION ALL

        SELECT
          5, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.title', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM crove_meetings.action_item i
        CROSS JOIN LATERAL crove_kernel.text_detect(i.title) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          6, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.who_drafted', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM crove_meetings.action_item i
        CROSS JOIN LATERAL crove_kernel.text_detect(i.who_drafted) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          7, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.when_drafted', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM crove_meetings.action_item i
        CROSS JOIN LATERAL crove_kernel.text_detect(i.when_drafted) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          8, c.position::double precision, c.created_at, c.id, 0,
          'meeting_chapter.title', c.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          c.start_seconds::double precision
        FROM crove_meetings.meeting_chapter c
        CROSS JOIN LATERAL crove_kernel.text_detect(c.title) d
        WHERE c.org_id = ${ctx.orgId}::uuid AND c.meeting_id = ${input.meetingId}::uuid AND c.stage = 'draft'
      )
      SELECT surface, target_id, decision_index, kind, start_pos, end_pos, match_text, version, start_seconds
      FROM raw_hits
      ORDER BY surface_order, order_num, order_at, order_id, sub_order, start_pos
      LIMIT ${REDACTION_CANDIDATES_MAX + 1}`.execute(ctx.trx);

    const truncated = rows.length > REDACTION_CANDIDATES_MAX;
    const candidates: RedactionCandidate[] = rows.slice(0, REDACTION_CANDIDATES_MAX).map((r) => ({
      surface: r.surface,
      targetId: r.target_id,
      decisionIndex: r.decision_index,
      kind: r.kind,
      startPos: r.start_pos,
      endPos: r.end_pos,
      matchText: r.match_text,
      mark: REDACTION_MARK_BY_KIND[r.kind],
      version: r.version,
      startSeconds: r.start_seconds,
    }));
    return zTranscriptRedactCandidates.parse({ meetingId: input.meetingId, titleEditable, candidates, truncated });
  },
});

// Applies recorder-confirmed redactions atomically on draft surfaces only, drops private Vy results and draft translations, and audits counts only.
export const transcriptRedact = defineCommand({
  name: 'meetings.transcript.redact',
  input: zTranscriptRedact,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<TranscriptRedacted> => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can redact draft meeting text');
    }

    const seenKeys = new Set<string>();
    for (const item of input.items) {
      const key = `${item.surface}:${item.targetId}:${item.decisionIndex ?? ''}:${item.startPos}`;
      if (seenKeys.has(key)) throw new DomainError('REDACTION_DUPLICATE_SELECTION', 422, 'Duplicate redaction selection');
      seenKeys.add(key);
    }

    // Lock meeting first, then child draft rows in personal_erase's order (meeting -> segments -> results -> action items -> chapters).
    const { rows: lockedMeetings } = await sql<{ id: string; title: string; version: string }>`
      SELECT id, title, pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
      FROM crove_meetings.meeting
      WHERE org_id = ${ctx.orgId}::uuid AND id = ${input.meetingId}::uuid
      FOR NO KEY UPDATE`.execute(ctx.trx);
    const lockedMeeting = lockedMeetings[0];
    if (!lockedMeeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');

    const idsFor = (surfaces: readonly RedactionSurface[]) =>
      [...new Set(input.items.filter((i) => surfaces.includes(i.surface)).map((i) => i.targetId))].sort();

    const segIds = idsFor(['transcript_segment.text', 'transcript_segment.speaker_label']);
    const resIds = idsFor(['meeting_result.summary', 'meeting_result.decision']);
    const itemIds = idsFor(['action_item.title', 'action_item.who_drafted', 'action_item.when_drafted']);
    const chapIds = idsFor(['meeting_chapter.title']);

    const { segStage, resStage, itemState, chapStage } = await findExistingStages(ctx.trx, ctx.orgId, input.meetingId, segIds, resIds, itemIds, chapIds);
    const hasPublished = await meetingHasPublished(ctx.trx, ctx.orgId, input.meetingId);

    for (const item of input.items) {
      if (item.surface === 'meeting.title') {
        if (item.targetId !== input.meetingId) throw staleError();
        if (hasPublished) throw publishedError();
      } else if (item.surface === 'transcript_segment.text' || item.surface === 'transcript_segment.speaker_label') {
        const st = segStage.get(item.targetId);
        if (st && st !== 'draft') throw publishedError();
      } else if (item.surface === 'meeting_result.summary' || item.surface === 'meeting_result.decision') {
        const st = resStage.get(item.targetId);
        if (st && st !== 'draft') throw publishedError();
      } else if (item.surface === 'action_item.title' || item.surface === 'action_item.who_drafted' || item.surface === 'action_item.when_drafted') {
        const st = itemState.get(item.targetId);
        if (st && (st.stage !== 'draft' || st.status !== 'suggested')) throw publishedError();
      } else {
        const st = chapStage.get(item.targetId);
        if (st && st !== 'draft') throw publishedError();
      }
    }

    const segMap = await lockSegments(ctx.trx, ctx.orgId, input.meetingId, segIds);
    const resMap = await lockResults(ctx.trx, ctx.orgId, input.meetingId, resIds);
    const itemMap = await lockActionItems(ctx.trx, ctx.orgId, input.meetingId, itemIds);
    const chapMap = await lockChapters(ctx.trx, ctx.orgId, input.meetingId, chapIds);

    for (const item of input.items) {
      if (item.surface === 'meeting.title') {
        if (item.targetId !== input.meetingId) throw staleError();
        if (hasPublished) throw publishedError();
        if (lockedMeeting.version !== item.version) throw staleError();
      } else if (item.surface === 'transcript_segment.text' || item.surface === 'transcript_segment.speaker_label') {
        const row = segMap.get(item.targetId);
        if (!row) throw staleError();
        if (row.stage !== 'draft') throw publishedError();
        if (row.version !== item.version) throw staleError();
      } else if (item.surface === 'meeting_result.summary' || item.surface === 'meeting_result.decision') {
        const row = resMap.get(item.targetId);
        if (!row) throw staleError();
        if (row.stage !== 'draft') throw publishedError();
        if (row.version !== item.version) throw staleError();
        if (item.surface === 'meeting_result.decision') {
          const decisions = decisionStrings(row.decisions);
          if (!decisions || item.decisionIndex === null || item.decisionIndex < 0 || item.decisionIndex >= decisions.length) {
            throw staleError();
          }
        }
      } else if (item.surface === 'action_item.title' || item.surface === 'action_item.who_drafted' || item.surface === 'action_item.when_drafted') {
        const row = itemMap.get(item.targetId);
        if (!row) throw staleError();
        if (row.stage !== 'draft' || row.status !== 'suggested') throw publishedError();
        if (row.version !== item.version) throw staleError();
      } else {
        const row = chapMap.get(item.targetId);
        if (!row) throw staleError();
        if (row.stage !== 'draft') throw publishedError();
        if (row.version !== item.version) throw staleError();
      }
    }

    // Re-detect and prepare every redacted value atomically before mutating any row or dropping derived state.
    let nextMeetingTitle: string | null = null;
    const titleSelections = input.items.filter((i) => i.surface === 'meeting.title');
    if (titleSelections.length > 0) {
      nextMeetingTitle = await redactField(ctx.trx, lockedMeeting.title, titleSelections, MAX_LENGTH_BY_SURFACE['meeting.title']);
    }

    const segmentUpdates = new Map<string, { text: string; speakerLabel: string }>();
    for (const [segId, list] of groupBy(
      input.items.filter((i) => i.surface === 'transcript_segment.text' || i.surface === 'transcript_segment.speaker_label'),
      (i) => i.targetId,
    )) {
      const row = segMap.get(segId) as LockedSegment;
      const textSel = list.filter((i) => i.surface === 'transcript_segment.text');
      const speakerSel = list.filter((i) => i.surface === 'transcript_segment.speaker_label');
      segmentUpdates.set(segId, {
        text: textSel.length > 0 ? await redactField(ctx.trx, row.text, textSel, MAX_LENGTH_BY_SURFACE['transcript_segment.text']) : row.text,
        speakerLabel:
          speakerSel.length > 0 ? await redactField(ctx.trx, row.speaker_label, speakerSel, MAX_LENGTH_BY_SURFACE['transcript_segment.speaker_label']) : row.speaker_label,
      });
    }

    const resultUpdates = new Map<string, { summary: string; decisions: string[] }>();
    for (const [resId, list] of groupBy(
      input.items.filter((i) => i.surface === 'meeting_result.summary' || i.surface === 'meeting_result.decision'),
      (i) => i.targetId,
    )) {
      const row = resMap.get(resId) as LockedResult;
      const sumSel = list.filter((i) => i.surface === 'meeting_result.summary');
      const nextSummary = sumSel.length > 0 ? await redactField(ctx.trx, row.summary, sumSel, MAX_LENGTH_BY_SURFACE['meeting_result.summary']) : row.summary;
      const nextDecisions = decisionStrings(row.decisions) ?? [];
      for (const [idxKey, decSel] of groupBy(
        list.filter((i) => i.surface === 'meeting_result.decision'),
        (i) => String(i.decisionIndex),
      )) {
        const idx = Number(idxKey);
        nextDecisions[idx] = await redactField(ctx.trx, nextDecisions[idx] as string, decSel, MAX_LENGTH_BY_SURFACE['meeting_result.decision']);
      }
      resultUpdates.set(resId, { summary: nextSummary, decisions: nextDecisions });
    }

    const actionUpdates = new Map<string, { title: string; whoDrafted: string; whenDrafted: string; flags: ItemFlag[] }>();
    for (const [itemId, list] of groupBy(
      input.items.filter((i) => i.surface === 'action_item.title' || i.surface === 'action_item.who_drafted' || i.surface === 'action_item.when_drafted'),
      (i) => i.targetId,
    )) {
      const row = itemMap.get(itemId) as LockedActionItem;
      const titleSel = list.filter((i) => i.surface === 'action_item.title');
      const whoSel = list.filter((i) => i.surface === 'action_item.who_drafted');
      const whenSel = list.filter((i) => i.surface === 'action_item.when_drafted');
      const nextTitle = titleSel.length > 0 ? await redactField(ctx.trx, row.title, titleSel, MAX_LENGTH_BY_SURFACE['action_item.title']) : row.title;
      const existingFlags = Array.isArray(row.flags) ? (row.flags as ItemFlag[]) : [];
      actionUpdates.set(itemId, {
        title: nextTitle,
        whoDrafted: whoSel.length > 0 ? await redactField(ctx.trx, row.who_drafted, whoSel, MAX_LENGTH_BY_SURFACE['action_item.who_drafted']) : row.who_drafted,
        whenDrafted: whenSel.length > 0 ? await redactField(ctx.trx, row.when_drafted, whenSel, MAX_LENGTH_BY_SURFACE['action_item.when_drafted']) : row.when_drafted,
        flags: titleSel.length > 0 ? itemFlags(nextTitle) : existingFlags,
      });
    }

    const chapterUpdates = new Map<string, string>();
    for (const [chapId, list] of groupBy(
      input.items.filter((i) => i.surface === 'meeting_chapter.title'),
      (i) => i.targetId,
    )) {
      const row = chapMap.get(chapId) as LockedChapter;
      chapterUpdates.set(chapId, await redactField(ctx.trx, row.title, list, MAX_LENGTH_BY_SURFACE['meeting_chapter.title']));
    }

    // D5: Drop the recorder's own draft translations before row updates (so count includes draft summary translations
    // that triggers would otherwise clear) and drop private Vy results + cancel running runs via the kernel command.
    const delTrans = await ctx.trx
      .deleteFrom('crove_meetings.translation')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where('member_user_id', '=', userId)
      .where('source_stage', '=', 'draft')
      .executeTakeFirst();
    const droppedTranslations = Number(delTrans.numDeletedRows ?? 0);

    const droppedVy = await ctx.run<{ cancelled: number; removed: number }>('kernel.member_vy.subject_results.drop', {
      subjectType: 'meeting',
      subjectId: input.meetingId,
    });

    if (nextMeetingTitle !== null) {
      await ctx.trx
        .updateTable('crove_meetings.meeting')
        .set({ title: nextMeetingTitle, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.meetingId)
        .execute();
    }
    for (const [segId, u] of segmentUpdates) {
      await ctx.trx
        .updateTable('crove_meetings.transcript_segment')
        .set({ text: u.text, speaker_label: u.speakerLabel, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', segId)
        .execute();
    }
    for (const [resId, u] of resultUpdates) {
      await ctx.trx
        .updateTable('crove_meetings.meeting_result')
        .set({ summary: u.summary, decisions: sql`${JSON.stringify(u.decisions)}::jsonb`, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', resId)
        .execute();
    }
    for (const [itemId, u] of actionUpdates) {
      await ctx.trx
        .updateTable('crove_meetings.action_item')
        .set({
          title: u.title,
          who_drafted: u.whoDrafted,
          when_drafted: u.whenDrafted,
          flags: sql`${JSON.stringify(u.flags)}::jsonb`,
          updated_at: sql<Date>`pg_catalog.now()`,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', itemId)
        .execute();
    }
    for (const [chapId, title] of chapterUpdates) {
      await ctx.trx
        .updateTable('crove_meetings.meeting_chapter')
        .set({ title, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', chapId)
        .execute();
    }

    const countsByKind: RedactionCountsByKind = {
      email: 0,
      phone: 0,
      national_id: 0,
      tax_code: 0,
      bank_account: 0,
    };
    for (const item of input.items) countsByKind[item.kind] += 1;
    const redactedCount = input.items.length;
    const targetIds = [...new Set(input.items.map((i) => i.targetId))].sort();

    // Audit records target IDs and counts only; never raw text or hidden values.
    ctx.audit({
      meetingId: input.meetingId,
      targetIds,
      redactedCount,
      countsByKind,
      droppedVyResults: droppedVy.removed,
      cancelledVyRuns: droppedVy.cancelled,
      droppedTranslations,
    });

    return zTranscriptRedacted.parse({
      meetingId: input.meetingId,
      redactedCount,
      countsByKind,
      droppedVyResults: droppedVy.removed,
      cancelledVyRuns: droppedVy.cancelled,
      droppedTranslations,
    });
  },
});

export const redactCommands = [transcriptRedact];
export const redactQueries = [transcriptRedactCandidates];
