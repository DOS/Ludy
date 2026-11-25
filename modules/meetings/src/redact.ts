// SPDX-License-Identifier: AGPL-3.0-only
// Code-assisted draft redaction (#4001, ADR-0047): deterministic detection across all draft publish surfaces;
// typed non-value marks; no undo store; recorder-only; drops private Vy results and draft translations and blanks the live preview so redacted text cannot return.
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
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { flagsAfterEdit } from './results.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];
export type DropDraftTranslationsFn = (trx: CommandContext['trx'], orgId: string, meetingId: string, memberUserId: string) => Promise<number>;

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
      EXISTS (SELECT 1 FROM ludy_meetings.transcript_segment s WHERE s.org_id = ${orgId}::uuid AND s.meeting_id = ${meetingId}::uuid AND s.stage = 'published')
      OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_result r WHERE r.org_id = ${orgId}::uuid AND r.meeting_id = ${meetingId}::uuid AND r.stage = 'published')
      OR EXISTS (SELECT 1 FROM ludy_meetings.action_item i WHERE i.org_id = ${orgId}::uuid AND i.meeting_id = ${meetingId}::uuid AND i.stage = 'published')
      OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_chapter c WHERE c.org_id = ${orgId}::uuid AND c.meeting_id = ${meetingId}::uuid AND c.stage = 'published')
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
          SELECT id, stage FROM ludy_meetings.transcript_segment
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(segIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    resIds.length > 0
      ? sql<{ id: string; stage: string }>`
          SELECT id, stage FROM ludy_meetings.meeting_result
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(resIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    itemIds.length > 0
      ? sql<{ id: string; stage: string; status: string }>`
          SELECT id, stage, status FROM ludy_meetings.action_item
          WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(itemIds)}::uuid[])`.execute(trx)
      : Promise.resolve({ rows: [] }),
    chapIds.length > 0
      ? sql<{ id: string; stage: string }>`
          SELECT id, stage FROM ludy_meetings.meeting_chapter
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
    FROM ludy_meetings.transcript_segment
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
    FROM ludy_meetings.meeting_result
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
    FROM ludy_meetings.action_item
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
    FROM ludy_meetings.meeting_chapter
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND id = ANY(${sql.val(ids)}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

const staleError = () => new DomainError('REDACTION_STALE', 409, 'This draft changed since you reviewed it; reload and review again');
const publishedError = () => new DomainError('REDACTION_PUBLISHED_IMMUTABLE', 409, 'Published meeting text cannot be redacted');
const mismatchError = () => new DomainError('REDACTION_SPAN_MISMATCH', 422, 'Selected item no longer matches detected personal data');
// The marks are longer than most of what they replace (#4540): a field close to its cap can grow past it. The command refuses it, whole (nothing is written), instead of cutting the end of the user's text.
const tooLongError = () => new DomainError('REDACTION_TOO_LONG', 422, 'The text would be longer than this field allows once the marks are in; shorten the text first');

interface FieldRedactionTask {
  key: string;
  text: string;
  maxLen: number;
  selections: ReadonlyArray<RedactionSelection>;
}

async function redactFieldsBatch(trx: Trx, tasks: ReadonlyArray<FieldRedactionTask>): Promise<Map<string, string>> {
  if (tasks.length === 0) return new Map();
  const payload = tasks.map((task, idx) => ({
    idx,
    text: task.text,
    max_len: task.maxLen,
    starts: task.selections.map((s) => s.startPos),
    kinds: task.selections.map((s) => s.kind),
    marks: task.selections.map((s) => REDACTION_MARK_BY_KIND[s.kind]),
  }));
  const { rows } = await sql<{ idx: number; has_mismatch: boolean; redacted: string | null; too_long: boolean }>`
    WITH req AS (
      SELECT
        r.idx,
        r.text,
        r.max_len,
        (SELECT pg_catalog.array_agg(e.val::integer ORDER BY e.ord)
         FROM pg_catalog.jsonb_array_elements_text(r.starts) WITH ORDINALITY AS e(val, ord)) AS starts,
        (SELECT pg_catalog.array_agg(e.val ORDER BY e.ord)
         FROM pg_catalog.jsonb_array_elements_text(r.kinds) WITH ORDINALITY AS e(val, ord)) AS kinds,
        (SELECT pg_catalog.array_agg(e.val ORDER BY e.ord)
         FROM pg_catalog.jsonb_array_elements_text(r.marks) WITH ORDINALITY AS e(val, ord)) AS marks
      FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS r(
        idx integer,
        text text,
        max_len integer,
        starts jsonb,
        kinds jsonb,
        marks jsonb
      )
    ),
    detected AS MATERIALIZED (
      SELECT req.idx, d.start_pos, d.kind
      FROM req
      CROSS JOIN LATERAL ludy_kernel.text_detect(req.text) AS d
    ),
    checked AS (
      SELECT
        req.idx,
        req.text,
        req.max_len,
        req.starts,
        req.kinds,
        req.marks,
        EXISTS (
          SELECT 1
          FROM ROWS FROM (pg_catalog.unnest(req.starts), pg_catalog.unnest(req.kinds)) AS sel(start_pos, kind)
          WHERE NOT EXISTS (
            SELECT 1
            FROM detected d
            WHERE d.idx = req.idx AND d.start_pos = sel.start_pos AND d.kind = sel.kind
          )
        ) AS has_mismatch
      FROM req
    ),
    done AS (
      SELECT
        idx,
        has_mismatch,
        max_len,
        CASE
          WHEN has_mismatch THEN NULL::text
          ELSE ludy_kernel.text_redact_spans(text, starts, kinds, marks)
        END AS redacted
      FROM checked
    )
    SELECT
      idx,
      has_mismatch,
      redacted,
      COALESCE(pg_catalog.length(redacted) > max_len, false) AS too_long
    FROM done
    ORDER BY idx`.execute(trx);

  if (rows.length !== tasks.length) throw mismatchError();
  const redactedByKey = new Map<string, string>();
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const row = rows[i]!;
    const redacted = row.redacted;
    if (row.idx !== i) throw mismatchError();
    // A selection the server does not detect any more is a mismatch whatever the length; only a matching one that would not fit is "too long".
    if (!row.has_mismatch && row.too_long) throw tooLongError();
    if (row.has_mismatch || redacted === null || redacted === undefined || redacted === task.text || redacted.length === 0) {
      throw mismatchError();
    }
    redactedByKey.set(task.key, redacted);
  }
  return redactedByKey;
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
        FROM ludy_meetings.meeting m
        CROSS JOIN LATERAL ludy_kernel.text_detect(m.title) d
        WHERE ${titleEditable}::boolean AND m.org_id = ${ctx.orgId}::uuid AND m.id = ${input.meetingId}::uuid

        UNION ALL

        SELECT
          1, s.start_seconds::double precision, s.created_at, s.id, 0,
          'transcript_segment.text', s.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          s.start_seconds::double precision
        FROM ludy_meetings.transcript_segment s
        CROSS JOIN LATERAL ludy_kernel.text_detect(s.text) d
        WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${input.meetingId}::uuid AND s.stage = 'draft'

        UNION ALL

        SELECT
          2, s.start_seconds::double precision, s.created_at, s.id, 0,
          'transcript_segment.speaker_label', s.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          s.start_seconds::double precision
        FROM ludy_meetings.transcript_segment s
        CROSS JOIN LATERAL ludy_kernel.text_detect(s.speaker_label) d
        WHERE s.org_id = ${ctx.orgId}::uuid AND s.meeting_id = ${input.meetingId}::uuid AND s.stage = 'draft'

        UNION ALL

        SELECT
          3, 0::double precision, r.created_at, r.id, 0,
          'meeting_result.summary', r.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          NULL::double precision
        FROM ludy_meetings.meeting_result r
        CROSS JOIN LATERAL ludy_kernel.text_detect(r.summary) d
        WHERE r.org_id = ${ctx.orgId}::uuid AND r.meeting_id = ${input.meetingId}::uuid AND r.stage = 'draft'

        UNION ALL

        SELECT
          4, (dec.ord - 1)::double precision, r.created_at, r.id, (dec.ord - 1)::integer,
          'meeting_result.decision', r.id, (dec.ord - 1)::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          NULL::double precision
        FROM ludy_meetings.meeting_result r
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(r.decisions) WITH ORDINALITY AS dec(v, ord)
        CROSS JOIN LATERAL ludy_kernel.text_detect(dec.v #>> '{}') d
        WHERE r.org_id = ${ctx.orgId}::uuid AND r.meeting_id = ${input.meetingId}::uuid AND r.stage = 'draft'
          AND pg_catalog.jsonb_typeof(dec.v) = 'string'

        UNION ALL

        SELECT
          5, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.title', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM ludy_meetings.action_item i
        CROSS JOIN LATERAL ludy_kernel.text_detect(i.title) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          6, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.who_drafted', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM ludy_meetings.action_item i
        CROSS JOIN LATERAL ludy_kernel.text_detect(i.who_drafted) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          7, COALESCE(i.transcript_seconds, 2147483647)::double precision, i.created_at, i.id, 0,
          'action_item.when_drafted', i.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          i.transcript_seconds::double precision
        FROM ludy_meetings.action_item i
        CROSS JOIN LATERAL ludy_kernel.text_detect(i.when_drafted) d
        WHERE i.org_id = ${ctx.orgId}::uuid AND i.meeting_id = ${input.meetingId}::uuid AND i.stage = 'draft' AND i.status = 'suggested'

        UNION ALL

        SELECT
          8, c.position::double precision, c.created_at, c.id, 0,
          'meeting_chapter.title', c.id, NULL::integer,
          d.kind, d.start_pos, d.end_pos, d.match_text,
          pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          c.start_seconds::double precision
        FROM ludy_meetings.meeting_chapter c
        CROSS JOIN LATERAL ludy_kernel.text_detect(c.title) d
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

// Builds the redaction commands, taking the delete-only draft-translation helper from translate.ts so this file stays isolated from that table.
// Blanks the text of the meeting's live preview lines: each line that holds text is deleted and written again with the same seq, start, end, run and creation time and no text (a silent piece), in the
// caller's transaction, so the taint's source, the 30-day expiry clock and the "already copied" check by run all stay as they were. Returns how many lines held text. Only the recorder reaches it
// (redaction is recorder-only, and the table's row security lets only the recorder read, write and delete a line).
async function clearLiveLines(trx: Trx, orgId: string, meetingId: string): Promise<number> {
  const { rows } = await sql<{ seq: number; start_seconds: number; end_seconds: number; source_run_id: string | null; created_at: Date }>`
    SELECT seq, start_seconds, end_seconds, source_run_id, created_at FROM ludy_meetings.live_line
    WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND text <> ''
    ORDER BY seq`.execute(trx);
  if (rows.length === 0) return 0;
  await sql`DELETE FROM ludy_meetings.live_line WHERE org_id = ${orgId}::uuid AND meeting_id = ${meetingId}::uuid AND text <> ''`.execute(trx);
  await sql`
    INSERT INTO ludy_meetings.live_line (org_id, meeting_id, seq, start_seconds, end_seconds, text, source_run_id, created_at)
    SELECT ${orgId}::uuid, ${meetingId}::uuid, u.seq, u.start_seconds, u.end_seconds, '', u.source_run_id, u.created_at
    FROM ROWS FROM (
      pg_catalog.unnest(${sql.val(rows.map((r) => r.seq))}::int[]),
      pg_catalog.unnest(${sql.val(rows.map((r) => r.start_seconds))}::int[]),
      pg_catalog.unnest(${sql.val(rows.map((r) => r.end_seconds))}::int[]),
      pg_catalog.unnest(${sql.val(rows.map((r) => r.source_run_id))}::uuid[]),
      pg_catalog.unnest(${sql.val(rows.map((r) => new Date(r.created_at).toISOString()))}::timestamptz[])
    ) AS u(seq, start_seconds, end_seconds, source_run_id, created_at)`.execute(trx);
  return rows.length;
}

export function createRedactCommands(dropDraftTranslations: DropDraftTranslationsFn) {
  const transcriptRedact = defineCommand({
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
      FROM ludy_meetings.meeting
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

    // Collect every target field and re-detect + compute redacted values in one batched SQL query before mutating any row.
    const fieldTasks: FieldRedactionTask[] = [];
    const titleSelections = input.items.filter((i) => i.surface === 'meeting.title');
    if (titleSelections.length > 0) {
      fieldTasks.push({
        key: 'meeting.title',
        text: lockedMeeting.title,
        maxLen: MAX_LENGTH_BY_SURFACE['meeting.title'],
        selections: titleSelections,
      });
    }

    const segmentGroups = groupBy(
      input.items.filter((i) => i.surface === 'transcript_segment.text' || i.surface === 'transcript_segment.speaker_label'),
      (i) => i.targetId,
    );
    for (const [segId, list] of segmentGroups) {
      const row = segMap.get(segId) as LockedSegment;
      const textSel = list.filter((i) => i.surface === 'transcript_segment.text');
      const speakerSel = list.filter((i) => i.surface === 'transcript_segment.speaker_label');
      if (textSel.length > 0) {
        fieldTasks.push({
          key: `seg.text:${segId}`,
          text: row.text,
          maxLen: MAX_LENGTH_BY_SURFACE['transcript_segment.text'],
          selections: textSel,
        });
      }
      if (speakerSel.length > 0) {
        fieldTasks.push({
          key: `seg.speaker:${segId}`,
          text: row.speaker_label,
          maxLen: MAX_LENGTH_BY_SURFACE['transcript_segment.speaker_label'],
          selections: speakerSel,
        });
      }
    }

    const resultGroups = groupBy(
      input.items.filter((i) => i.surface === 'meeting_result.summary' || i.surface === 'meeting_result.decision'),
      (i) => i.targetId,
    );
    for (const [resId, list] of resultGroups) {
      const row = resMap.get(resId) as LockedResult;
      const sumSel = list.filter((i) => i.surface === 'meeting_result.summary');
      if (sumSel.length > 0) {
        fieldTasks.push({
          key: `res.summary:${resId}`,
          text: row.summary,
          maxLen: MAX_LENGTH_BY_SURFACE['meeting_result.summary'],
          selections: sumSel,
        });
      }
      const decisions = decisionStrings(row.decisions) ?? [];
      for (const [idxKey, decSel] of groupBy(
        list.filter((i) => i.surface === 'meeting_result.decision'),
        (i) => String(i.decisionIndex),
      )) {
        const idx = Number(idxKey);
        fieldTasks.push({
          key: `res.decision:${resId}:${idx}`,
          text: decisions[idx] as string,
          maxLen: MAX_LENGTH_BY_SURFACE['meeting_result.decision'],
          selections: decSel,
        });
      }
    }

    const actionGroups = groupBy(
      input.items.filter((i) => i.surface === 'action_item.title' || i.surface === 'action_item.who_drafted' || i.surface === 'action_item.when_drafted'),
      (i) => i.targetId,
    );
    for (const [itemId, list] of actionGroups) {
      const row = itemMap.get(itemId) as LockedActionItem;
      const titleSel = list.filter((i) => i.surface === 'action_item.title');
      const whoSel = list.filter((i) => i.surface === 'action_item.who_drafted');
      const whenSel = list.filter((i) => i.surface === 'action_item.when_drafted');
      if (titleSel.length > 0) {
        fieldTasks.push({
          key: `item.title:${itemId}`,
          text: row.title,
          maxLen: MAX_LENGTH_BY_SURFACE['action_item.title'],
          selections: titleSel,
        });
      }
      if (whoSel.length > 0) {
        fieldTasks.push({
          key: `item.who:${itemId}`,
          text: row.who_drafted,
          maxLen: MAX_LENGTH_BY_SURFACE['action_item.who_drafted'],
          selections: whoSel,
        });
      }
      if (whenSel.length > 0) {
        fieldTasks.push({
          key: `item.when:${itemId}`,
          text: row.when_drafted,
          maxLen: MAX_LENGTH_BY_SURFACE['action_item.when_drafted'],
          selections: whenSel,
        });
      }
    }

    const chapterGroups = groupBy(
      input.items.filter((i) => i.surface === 'meeting_chapter.title'),
      (i) => i.targetId,
    );
    for (const [chapId, list] of chapterGroups) {
      const row = chapMap.get(chapId) as LockedChapter;
      fieldTasks.push({
        key: `chap.title:${chapId}`,
        text: row.title,
        maxLen: MAX_LENGTH_BY_SURFACE['meeting_chapter.title'],
        selections: list,
      });
    }

    const redactedByKey = await redactFieldsBatch(ctx.trx, fieldTasks);

    const nextMeetingTitle = titleSelections.length > 0 ? redactedByKey.get('meeting.title')! : null;

    const segmentUpdates = new Map<string, { text: string; speakerLabel: string }>();
    for (const [segId] of segmentGroups) {
      const row = segMap.get(segId) as LockedSegment;
      segmentUpdates.set(segId, {
        text: redactedByKey.get(`seg.text:${segId}`) ?? row.text,
        speakerLabel: redactedByKey.get(`seg.speaker:${segId}`) ?? row.speaker_label,
      });
    }

    const resultUpdates = new Map<string, { summary: string; decisions: string[] }>();
    for (const [resId, list] of resultGroups) {
      const row = resMap.get(resId) as LockedResult;
      const nextDecisions = decisionStrings(row.decisions) ?? [];
      for (const [idxKey] of groupBy(
        list.filter((i) => i.surface === 'meeting_result.decision'),
        (i) => String(i.decisionIndex),
      )) {
        const idx = Number(idxKey);
        nextDecisions[idx] = redactedByKey.get(`res.decision:${resId}:${idx}`)!;
      }
      resultUpdates.set(resId, {
        summary: redactedByKey.get(`res.summary:${resId}`) ?? row.summary,
        decisions: nextDecisions,
      });
    }

    const actionUpdates = new Map<string, { title: string; whoDrafted: string; whenDrafted: string; flags: ItemFlag[] }>();
    for (const [itemId] of actionGroups) {
      const row = itemMap.get(itemId) as LockedActionItem;
      const redactedTitle = redactedByKey.get(`item.title:${itemId}`);
      const nextTitle = redactedTitle ?? row.title;
      const existingFlags = Array.isArray(row.flags) ? (row.flags as ItemFlag[]) : [];
      actionUpdates.set(itemId, {
        title: nextTitle,
        whoDrafted: redactedByKey.get(`item.who:${itemId}`) ?? row.who_drafted,
        whenDrafted: redactedByKey.get(`item.when:${itemId}`) ?? row.when_drafted,
        flags: redactedTitle !== undefined ? flagsAfterEdit(existingFlags, nextTitle) : existingFlags,
      });
    }

    const chapterUpdates = new Map<string, string>();
    for (const [chapId] of chapterGroups) {
      chapterUpdates.set(chapId, redactedByKey.get(`chap.title:${chapId}`)!);
    }

    // D5: Drop the recorder's own draft translations before row updates (so count includes draft summary translations
    // that triggers would otherwise clear) and drop private Vy results + cancel running runs via the kernel command.
    const droppedTranslations = await dropDraftTranslations(ctx.trx, ctx.orgId, input.meetingId, userId);

    const droppedVy = await ctx.run<{ cancelled: number; removed: number }>('kernel.member_vy.subject_results.drop', {
      subjectType: 'meeting',
      subjectId: input.meetingId,
    });

    // The recorder's live transcript preview (live_line, #4557) is not a surface they review or select from, so no candidate is listed for it, yet it is the model's transcription of the same audio and it
    // feeds the next live notes run: a number redacted from the draft would come back through it. A redaction therefore clears the text of the preview whole, as it drops the private Vy results. A line
    // is not deleted but blanked (deleted and written again as a silent piece, '' at the same seq): the preview's progress is the highest seq it holds, so the next window must still start after it
    // and not read the audio again. A silent piece is never shown and never read as text. The meeting row is held (above); a tick that copies a window of new audio at the same moment adds text of its own,
    // which is new audio and not redacted text coming back.
    const clearedLiveLines = await clearLiveLines(ctx.trx, ctx.orgId, input.meetingId);

    if (nextMeetingTitle !== null) {
      await ctx.trx
        .updateTable('ludy_meetings.meeting')
        .set({ title: nextMeetingTitle, updated_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.meetingId)
        .execute();
    }
    if (segmentUpdates.size > 0) {
      const ids = [...segmentUpdates.keys()];
      const texts = ids.map((id) => segmentUpdates.get(id)!.text);
      const speakers = ids.map((id) => segmentUpdates.get(id)!.speakerLabel);
      await sql`
        UPDATE ludy_meetings.transcript_segment AS s
        SET text = u.text,
            speaker_label = u.speaker_label,
            updated_at = pg_catalog.now()
        FROM ROWS FROM (
          pg_catalog.unnest(${sql.val(ids)}::uuid[]),
          pg_catalog.unnest(${sql.val(texts)}::text[]),
          pg_catalog.unnest(${sql.val(speakers)}::text[])
        ) AS u(id, text, speaker_label)
        WHERE s.org_id = ${ctx.orgId}::uuid
          AND s.meeting_id = ${input.meetingId}::uuid
          AND s.id = u.id`.execute(ctx.trx);
    }
    if (resultUpdates.size > 0) {
      const ids = [...resultUpdates.keys()];
      const summaries = ids.map((id) => resultUpdates.get(id)!.summary);
      const decisionsJson = ids.map((id) => JSON.stringify(resultUpdates.get(id)!.decisions));
      await sql`
        UPDATE ludy_meetings.meeting_result AS r
        SET summary = u.summary,
            decisions = u.decisions::jsonb,
            updated_at = pg_catalog.now()
        FROM ROWS FROM (
          pg_catalog.unnest(${sql.val(ids)}::uuid[]),
          pg_catalog.unnest(${sql.val(summaries)}::text[]),
          pg_catalog.unnest(${sql.val(decisionsJson)}::text[])
        ) AS u(id, summary, decisions)
        WHERE r.org_id = ${ctx.orgId}::uuid
          AND r.meeting_id = ${input.meetingId}::uuid
          AND r.id = u.id`.execute(ctx.trx);
    }
    if (actionUpdates.size > 0) {
      const ids = [...actionUpdates.keys()];
      const titles = ids.map((id) => actionUpdates.get(id)!.title);
      const whoList = ids.map((id) => actionUpdates.get(id)!.whoDrafted);
      const whenList = ids.map((id) => actionUpdates.get(id)!.whenDrafted);
      const flagsJson = ids.map((id) => JSON.stringify(actionUpdates.get(id)!.flags));
      await sql`
        UPDATE ludy_meetings.action_item AS i
        SET title = u.title,
            who_drafted = u.who_drafted,
            when_drafted = u.when_drafted,
            flags = u.flags::jsonb,
            updated_at = pg_catalog.now()
        FROM ROWS FROM (
          pg_catalog.unnest(${sql.val(ids)}::uuid[]),
          pg_catalog.unnest(${sql.val(titles)}::text[]),
          pg_catalog.unnest(${sql.val(whoList)}::text[]),
          pg_catalog.unnest(${sql.val(whenList)}::text[]),
          pg_catalog.unnest(${sql.val(flagsJson)}::text[])
        ) AS u(id, title, who_drafted, when_drafted, flags)
        WHERE i.org_id = ${ctx.orgId}::uuid
          AND i.meeting_id = ${input.meetingId}::uuid
          AND i.id = u.id`.execute(ctx.trx);
    }
    if (chapterUpdates.size > 0) {
      const ids = [...chapterUpdates.keys()];
      const titles = ids.map((id) => chapterUpdates.get(id)!);
      await sql`
        UPDATE ludy_meetings.meeting_chapter AS c
        SET title = u.title,
            updated_at = pg_catalog.now()
        FROM ROWS FROM (
          pg_catalog.unnest(${sql.val(ids)}::uuid[]),
          pg_catalog.unnest(${sql.val(titles)}::text[])
        ) AS u(id, title)
        WHERE c.org_id = ${ctx.orgId}::uuid
          AND c.meeting_id = ${input.meetingId}::uuid
          AND c.id = u.id`.execute(ctx.trx);
    }

    let emailCount = 0;
    let phoneCount = 0;
    let nationalIdCount = 0;
    let taxCodeCount = 0;
    let bankAccountCount = 0;
    for (const item of input.items) {
      if (item.kind === 'email') emailCount += 1;
      else if (item.kind === 'phone') phoneCount += 1;
      else if (item.kind === 'national_id') nationalIdCount += 1;
      else if (item.kind === 'tax_code') taxCodeCount += 1;
      else bankAccountCount += 1;
    }
    const redactedCount = input.items.length;
    const targetIds = [...new Set(input.items.map((i) => i.targetId))].sort();

    // Audit records target IDs and counts only; never raw text or hidden values.
    ctx.audit({
      meetingId: input.meetingId,
      targetIds,
      redactedCount,
      emailCount,
      phoneCount,
      nationalIdCount,
      taxCodeCount,
      bankAccountCount,
      droppedVyResults: droppedVy.removed,
      cancelledVyRuns: droppedVy.cancelled,
      droppedTranslations,
      clearedLiveLines,
    });

    const countsByKind: RedactionCountsByKind = {
      email: emailCount,
      phone: phoneCount,
      national_id: nationalIdCount,
      tax_code: taxCodeCount,
      bank_account: bankAccountCount,
    };

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

  return [transcriptRedact];
}

export const redactQueries = [transcriptRedactCandidates];
