// SPDX-License-Identifier: AGPL-3.0-only
// Notebooks, 2-level stacks, and [[Note]] backlinks (#3559, plan docs/plan/notes-v2.md V2-4 / E1, ADR-0037).
// A notebook is private to its author or shared with whole-org writers; row-level security decides what each caller
// reads and modifies, and unreadable private notebooks answer NOTEBOOK_NOT_FOUND with zero existence oracle.
// Audit rows carry ids, visibility and changed field names plus auditValue markers, never raw notebook or stack names.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  auditValue,
  keyBetween,
  NOTE_TITLE_MAX,
  NOTEBOOKS_MAX,
  spreadKeys,
  zNoteBacklinksInput,
  zNotebookCreate,
  zNotebookRef,
  zNotebookUpdate,
  type NoteSummary,
  type NoteVisibility,
  type NotebookDeleted,
  type NotebookSummary,
  type NotebookWritten,
  type NotebooksResponse,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { notesManifest } from './manifest.ts';
import { NOTE_SUMMARY_COLUMNS, hasWholeOrgScope, noteSummaryRow } from './notes.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const NOTEBOOK = notesManifest.tables.ludy_notes.notebook;
const REBALANCE_AT = 80;
const BACKLINK_SCAN_LIMIT = 500;
const WIKI_TOKEN_MAX = 260;

export interface ParsedWikiLink {
  noteId?: string;
  title: string;
}

function isHexChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

// Fixed-width 36-char UUID check in O(1) without regex backtracking.
export function isUuidString(value: string): boolean {
  if (value.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = value.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 45) return false;
    } else if (!isHexChar(c)) {
      return false;
    }
  }
  return true;
}

// Collapses whitespace runs in O(n) and folds case for deterministic title matching.
export function normalizeWikiTitle(value: string): string {
  let out = '';
  let inSpace = false;
  const trimmed = value.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (!inSpace) {
        out += ' ';
        inSpace = true;
      }
    } else {
      out += ch;
      inSpace = false;
    }
  }
  return out.toLowerCase();
}

function fenceMarkerOf(line: string): { char: '`' | '~'; len: number } | null {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len++;
  if (len < 3) return null;
  if (ch === '`') {
    for (let k = i + len; k < line.length; k++) {
      if (line[k] === '`') return null;
    }
  }
  return { char: ch, len };
}

function isClosingFence(line: string, fence: { char: '`' | '~'; len: number }): boolean {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  let len = 0;
  while (i + len < line.length && line[i + len] === fence.char) len++;
  if (len < fence.len) return false;
  for (let k = i + len; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

// Extracts [[Note Title]] and [[noteId|Title]] links in deterministic O(n) linear time,
// skipping fenced code blocks and inline backtick code spans.
export function extractWikiLinks(body: string): ParsedWikiLink[] {
  if (!body.includes('[[')) return [];
  const out: ParsedWikiLink[] = [];
  const lines = body.split('\n');
  let activeFence: { char: '`' | '~'; len: number } | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx]!;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (activeFence !== null) {
      if (isClosingFence(line, activeFence)) activeFence = null;
      continue;
    }
    const opened = fenceMarkerOf(line);
    if (opened !== null) {
      activeFence = opened;
      continue;
    }
    if (!line.includes('[[')) continue;

    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '`') {
        let ticks = 1;
        while (i + ticks < line.length && line[i + ticks] === '`') ticks++;
        const delimiter = '`'.repeat(ticks);
        const closeIdx = line.indexOf(delimiter, i + ticks);
        if (closeIdx !== -1) {
          i = closeIdx + ticks;
          continue;
        }
        i += ticks;
        continue;
      }
      if (ch === '[' && line[i + 1] === '[') {
        const closeIdx = line.indexOf(']]', i + 2);
        if (closeIdx === -1) break;
        if (closeIdx - (i + 2) <= WIKI_TOKEN_MAX) {
          const inner = line.slice(i + 2, closeIdx);
          if (inner.length > 0 && !inner.includes('[')) {
            const pipeIdx = inner.indexOf('|');
            if (pipeIdx !== -1) {
              const left = inner.slice(0, pipeIdx).trim();
              const right = inner.slice(pipeIdx + 1).trim();
              if (isUuidString(left)) {
                out.push({ noteId: left.toLowerCase(), title: right.slice(0, NOTE_TITLE_MAX) });
              } else if (left.length > 0 && left.length <= NOTE_TITLE_MAX) {
                out.push({ title: left });
              }
            } else {
              const trimmed = inner.trim();
              if (isUuidString(trimmed)) {
                out.push({ noteId: trimmed.toLowerCase(), title: '' });
              } else if (trimmed.length > 0 && trimmed.length <= NOTE_TITLE_MAX) {
                out.push({ title: trimmed });
              }
            }
          }
        }
        i = closeIdx + 2;
        continue;
      }
      i++;
    }
  }
  return out;
}

export function noteMatchesBacklink(body: string, target: { id: string; title: string }): boolean {
  const targetId = target.id.toLowerCase();
  const targetTitle = normalizeWikiTitle(target.title);
  const links = extractWikiLinks(body);
  for (const link of links) {
    if (link.noteId !== undefined) {
      if (link.noteId === targetId) return true;
    } else if (targetTitle.length > 0 && normalizeWikiTitle(link.title) === targetTitle) {
      return true;
    }
  }
  return false;
}

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const notebookNotFound = () => new DomainError('NOTEBOOK_NOT_FOUND', 404, 'Không tìm thấy sổ tay này');
const notebookAuthorOnly = () =>
  new DomainError('NOTEBOOK_AUTHOR_ONLY', 403, 'Chỉ người tạo sổ tay, hoặc chủ sở hữu và quản trị viên với sổ tay dùng chung, mới làm được việc này');
const notebookRevisionConflict = (revision: number) =>
  new DomainError('NOTEBOOK_REVISION_CONFLICT', 409, 'Sổ tay vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision });
const notebookLimitReached = () =>
  new DomainError('NOTEBOOK_LIMIT_REACHED', 422, `Đã đạt giới hạn ${NOTEBOOKS_MAX} sổ tay; hãy xóa bớt sổ tay không còn dùng`);
const notebookHasSharedNotes = () =>
  new DomainError('NOTES_NOTEBOOK_HAS_SHARED_NOTES', 409, 'Sổ tay đang chứa ghi chú dùng chung nên không thể chuyển thành riêng tư; hãy chuyển các ghi chú đó trước');

interface NotebookRow {
  id: string;
  author_user_id: string;
  visibility: NoteVisibility;
  name: string;
  stack_name: string | null;
  pinned: boolean;
  sort_key: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const NOTEBOOK_COLUMNS = [
  'id',
  'author_user_id',
  'visibility',
  'name',
  'stack_name',
  'pinned',
  'sort_key',
  'revision',
  'created_at',
  'updated_at',
] as const;

function canManageNotebook(row: Pick<NotebookRow, 'author_user_id' | 'visibility'>, userId: string, role: MemberRole | null, wholeOrg: boolean): boolean {
  if (!role || !WRITERS.includes(role)) return false;
  if (row.author_user_id === userId) return true;
  return row.visibility === 'org' && wholeOrg && MANAGERS.includes(role);
}

const notebookTarget = (input: { notebookId: string }) => ({ type: 'notes.notebook', id: input.notebookId });

export const notebookList = defineQuery({
  name: 'notes.notebook.list',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<NotebooksResponse> => {
    const userId = userOf(ctx.actor);
    const [wholeOrg, notebookRows, countRows] = await Promise.all([
      hasWholeOrgScope(ctx.trx),
      ctx.trx
        .selectFrom('ludy_notes.notebook')
        .select(NOTEBOOK_COLUMNS)
        .where('org_id', '=', ctx.orgId)
        .orderBy('pinned', 'desc')
        .orderBy('sort_key')
        .orderBy('id')
        .execute(),
      ctx.trx
        .selectFrom('ludy_notes.note')
        .select((eb) => ['notebook_id', eb.fn.countAll<string>().as('n')])
        .where('org_id', '=', ctx.orgId)
        .where('deleted_at', 'is', null)
        .where('archived_at', 'is', null)
        .groupBy('notebook_id')
        .execute(),
    ]);

    let allCount = 0;
    let unfiledCount = 0;
    const byNotebook = new Map<string, number>();
    for (const c of countRows) {
      const n = Number(c.n);
      allCount += n;
      if (c.notebook_id === null) unfiledCount = n;
      else byNotebook.set(c.notebook_id, n);
    }

    const notebooks: NotebookSummary[] = notebookRows.map((r) => ({
      id: r.id,
      authorUserId: r.author_user_id,
      mine: r.author_user_id === userId,
      editable: canManageNotebook(r, userId, ctx.role, wholeOrg),
      visibility: r.visibility,
      name: r.name,
      stackName: r.stack_name,
      pinned: r.pinned,
      sortKey: r.sort_key,
      noteCount: byNotebook.get(r.id) ?? 0,
      revision: r.revision,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));

    return { notebooks, allCount, unfiledCount };
  },
});

export const notebookCreate = defineCommand({
  name: 'notes.notebook.create',
  input: zNotebookCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NotebookWritten> => {
    const userId = userOf(ctx.actor);
    const wholeOrg = await hasWholeOrgScope(ctx.trx);
    if (input.visibility === 'org' && !wholeOrg) {
      throw new DomainError('FORBIDDEN', 403, 'Thành viên giới hạn theo pháp nhân không tạo được sổ tay dùng chung');
    }

    const existing = await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(['id', 'author_user_id', 'sort_key'])
      .where('org_id', '=', ctx.orgId)
      .where('author_user_id', '=', userId)
      .orderBy('sort_key')
      .orderBy('id')
      .execute();

    if (existing.length >= NOTEBOOKS_MAX) throw notebookLimitReached();

    // After every notebook the caller reads (its own included), so members' first notebooks do not all share one key.
    const { rows: lastRows } = await sql<{ last: string | null }>`
      SELECT pg_catalog.max(sort_key) AS last FROM ludy_notes.notebook WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
    let sortKey = keyBetween(lastRows[0]?.last ?? null, null);
    if (sortKey.length > REBALANCE_AT) {
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`notes.notebook.reorder:${ctx.orgId}`}, 0))`.execute(ctx.trx);
      sortKey = await rebalanceEditableNotebooks(ctx, userId, wholeOrg, null, 'after', null);
    }

    const row = await ctx.trx
      .insertInto('ludy_notes.notebook')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        visibility: input.visibility,
        name: input.name,
        stack_name: input.stackName,
        pinned: input.pinned,
        sort_key: sortKey,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      notebookId: row.id,
      visibility: row.visibility,
      pinned: input.pinned,
      name: auditValue(NOTEBOOK, 'name', input.name),
      stackName: auditValue(NOTEBOOK, 'stack_name', input.stackName),
    });

    return { notebookId: row.id, revision: row.revision };
  },
});

export interface RebalanceRow {
  id: string;
  editable: boolean;
  sortKey: string;
}

function hasGapBetween(lo: string | null, hi: string | null): boolean {
  if (lo === null) return hi === null || !/^0+$/.test(hi);
  if (hi === null) return true;
  if (!(lo < hi)) return false;
  return !(hi.startsWith(lo) && /^0+$/.test(hi.slice(lo.length)));
}

function fillBalancedKeys(lo: string | null, hi: string | null, out: string[], start: number, end: number): void {
  if (start >= end) return;
  const mid = (start + end) >>> 1;
  const key = keyBetween(lo, hi);
  out[mid] = key;
  fillBalancedKeys(lo, key, out, start, mid);
  fillBalancedKeys(key, hi, out, mid + 1, end);
}

export function spreadKeysBetween(lo: string | null, hi: string | null, count: number): string[] {
  if (count <= 0) return [];
  if (!hasGapBetween(lo, hi)) throw new Error('spreadKeysBetween: no key gap between bounds');
  if (lo === null && hi === null) return spreadKeys(count);
  const upper = hi === null ? null : hi.replace(/0+$/, '');
  const out = Array.from({ length: count }, () => '');
  fillBalancedKeys(lo, upper, out, 0, count);
  return out;
}

// Rewrites editable sibling sort keys inside their non-editable shared-notebook intervals so fixed neighbors
// keep their exact sort keys and relative positions, placing `movingId` at `place` relative to `anchorId`.
export function planNotebookRebalance(
  others: readonly RebalanceRow[],
  movingId: string,
  place: 'before' | 'after',
  anchorId: string,
): { movingKey: string; updates: Array<{ id: string; sortKey: string }> } {
  const anchorIdx = others.findIndex((r) => r.id === anchorId);
  if (anchorIdx === -1) throw notebookNotFound();

  const anchorKey = others[anchorIdx]!.sortKey;
  let insertAt = place === 'before' ? anchorIdx : anchorIdx + 1;

  type SeqEntry = { id: string; editable: boolean; sortKey: string; moving: boolean };
  const buildSequence = (at: number): SeqEntry[] => {
    const seq: SeqEntry[] = others.map((r) => ({ ...r, moving: false }));
    seq.splice(at, 0, { id: movingId, editable: true, sortKey: '', moving: true });
    return seq;
  };

  let sequence = buildSequence(insertAt);
  const runBoundsOf = (seq: readonly SeqEntry[], pos: number) => {
    let start = pos;
    while (start > 0 && seq[start - 1]!.editable) start--;
    let end = pos;
    while (end + 1 < seq.length && seq[end + 1]!.editable) end++;
    return {
      start,
      end,
      lo: start > 0 ? seq[start - 1]!.sortKey : null,
      hi: end + 1 < seq.length ? seq[end + 1]!.sortKey : null,
    };
  };

  const initialRun = runBoundsOf(sequence, insertAt);
  if (!hasGapBetween(initialRun.lo, initialRun.hi)) {
    // Adjacent fixed shared notebooks share zero gap (even across interleaved editable siblings);
    // step outside the entire tied/zero-gap fixed block so movingId lands in a valid gap.
    const stepAfterZeroGap = (fromPos: number, boundKey: string): number => {
      let gapFixedIdx = fromPos;
      while (
        gapFixedIdx < others.length &&
        (others[gapFixedIdx]!.editable || !hasGapBetween(boundKey, others[gapFixedIdx]!.sortKey))
      ) {
        gapFixedIdx++;
      }
      let lastZeroGapFixed = gapFixedIdx - 1;
      while (lastZeroGapFixed >= fromPos && others[lastZeroGapFixed]!.editable) {
        lastZeroGapFixed--;
      }
      return lastZeroGapFixed + 1;
    };

    if (place === 'before') {
      let gapFixedIdx = initialRun.start - 1;
      while (
        gapFixedIdx >= 0 &&
        (others[gapFixedIdx]!.editable || !hasGapBetween(others[gapFixedIdx]!.sortKey, anchorKey))
      ) {
        gapFixedIdx--;
      }
      let firstZeroGapFixed = gapFixedIdx + 1;
      while (firstZeroGapFixed < initialRun.start && others[firstZeroGapFixed]!.editable) {
        firstZeroGapFixed++;
      }
      insertAt = firstZeroGapFixed;
      sequence = buildSequence(insertAt);
      const afterBeforeSlide = runBoundsOf(sequence, insertAt);
      if (!hasGapBetween(afterBeforeSlide.lo, afterBeforeSlide.hi)) {
        // Only possible when non-editable notebooks occupy the '0'+ floor (no key < '0' exists).
        insertAt = stepAfterZeroGap(afterBeforeSlide.end, anchorKey);
        sequence = buildSequence(insertAt);
      }
    } else {
      insertAt = stepAfterZeroGap(initialRun.end, anchorKey);
      sequence = buildSequence(insertAt);
    }
  }

  let movingKey = '';
  const updates: Array<{ id: string; sortKey: string }> = [];

  let i = 0;
  while (i < sequence.length) {
    if (!sequence[i]!.editable) {
      i++;
      continue;
    }
    const start = i;
    while (i < sequence.length && sequence[i]!.editable) i++;
    const end = i;

    const loKey = start > 0 ? sequence[start - 1]!.sortKey : null;
    const hiKey = end < sequence.length ? sequence[end]!.sortKey : null;
    const run = sequence.slice(start, end);
    const hasMoving = run.some((item) => item.moving);

    if (!hasGapBetween(loKey, hiKey)) continue;

    const alreadyClean =
      !hasMoving &&
      run.every(
        (item, idx) =>
          item.sortKey.length <= REBALANCE_AT &&
          (loKey === null || loKey < item.sortKey) &&
          (hiKey === null || item.sortKey < hiKey) &&
          (idx === 0 || run[idx - 1]!.sortKey < item.sortKey),
      );
    if (alreadyClean) continue;

    const fresh = spreadKeysBetween(loKey, hiKey, run.length);
    for (let k = 0; k < run.length; k++) {
      const entry = run[k]!;
      const nextKey = fresh[k] as string;
      if (entry.moving) {
        movingKey = nextKey;
      } else if (entry.sortKey !== nextKey) {
        updates.push({ id: entry.id, sortKey: nextKey });
      }
    }
  }

  if (movingKey === '') {
    throw new Error('planNotebookRebalance: failed to assign a non-empty sort key');
  }
  return { movingKey, updates };
}

async function loadOrderedNotebooks(ctx: CommandContext) {
  return ctx.trx
    .selectFrom('ludy_notes.notebook')
    .select(['id', 'author_user_id', 'visibility', 'sort_key'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('sort_key')
    .orderBy('id')
    .execute();
}

// Locks editable sibling rows in deterministic id order and spaces keys around non-editable shared notebooks.
async function rebalanceEditableNotebooks(
  ctx: CommandContext,
  userId: string,
  wholeOrg: boolean,
  movingId: string | null,
  place: 'before' | 'after',
  anchorId: string | null,
  initialRows?: Awaited<ReturnType<typeof loadOrderedNotebooks>>,
): Promise<string> {
  const lockedIds = new Set<string>();
  let lockedRows = initialRows ?? (await loadOrderedNotebooks(ctx));
  while (true) {
    const toLock = lockedRows
      .filter((r) => (movingId === null || r.id !== movingId) && !lockedIds.has(r.id) && canManageNotebook(r, userId, ctx.role, wholeOrg))
      .map((r) => r.id)
      .sort();
    if (toLock.length === 0) break;
    await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', toLock)
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const id of toLock) lockedIds.add(id);
    lockedRows = await loadOrderedNotebooks(ctx);
  }

  const lockedOthers = lockedRows
    .filter((r) => movingId === null || r.id !== movingId)
    .map((r) => ({
      id: r.id,
      editable: canManageNotebook(r, userId, ctx.role, wholeOrg),
      sortKey: r.sort_key,
    }));
  if (anchorId === null && lockedOthers.length === 0) {
    return keyBetween(null, null);
  }
  const targetAnchorId = anchorId ?? lockedOthers[lockedOthers.length - 1]!.id;
  const plan = planNotebookRebalance(lockedOthers, movingId ?? '__new__', place, targetAnchorId);
  if (plan.updates.length > 0) {
    const ids = plan.updates.map((u) => u.id);
    const keys = plan.updates.map((u) => u.sortKey);
    await sql`UPDATE ludy_notes.notebook AS n SET sort_key = v.key
      FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
      WHERE n.org_id = ${ctx.orgId}::uuid AND n.id = v.id`.execute(ctx.trx);
  }
  return plan.movingKey;
}

async function computeReorderedSortKey(
  ctx: CommandContext,
  userId: string,
  wholeOrg: boolean,
  movingId: string,
  place: 'before' | 'after',
  anchorId: string,
): Promise<string> {
  const rows = await loadOrderedNotebooks(ctx);
  const others = rows.filter((r) => r.id !== movingId);
  const anchorIdx = others.findIndex((r) => r.id === anchorId);
  if (anchorIdx === -1) throw notebookNotFound();

  const leftIdx = place === 'before' ? anchorIdx - 1 : anchorIdx;
  const rightIdx = place === 'before' ? anchorIdx : anchorIdx + 1;
  const leftKey = leftIdx >= 0 ? (others[leftIdx]?.sort_key ?? null) : null;
  const rightKey = rightIdx < others.length ? (others[rightIdx]?.sort_key ?? null) : null;

  const rebalance = () => rebalanceEditableNotebooks(ctx, userId, wholeOrg, movingId, place, anchorId, rows);

  // Keys repeat across authors (each author's first notebook gets the same key), and the caller may not rewrite the
  // keys of notebooks it cannot manage. Then the notebook goes strictly next to its anchor: just below the anchor's
  // key for 'before', just above it for 'after', so the anchor relation holds whoever owns the neighbours.
  if (leftKey !== null && rightKey !== null && leftKey >= rightKey) {
    const anchorKey = others[anchorIdx]!.sort_key;
    let lower: string | null = anchorKey;
    let upper: string | null = anchorKey;
    if (place === 'before') {
      lower = null;
      for (const r of others) if (r.sort_key < anchorKey) lower = r.sort_key;
    } else {
      upper = others.find((r) => r.sort_key > anchorKey)?.sort_key ?? null;
    }
    if (hasGapBetween(lower, upper)) {
      const nextToAnchor = keyBetween(lower, upper);
      if (nextToAnchor.length <= REBALANCE_AT) return nextToAnchor;
    }
    return rebalance();
  }

  if (hasGapBetween(leftKey, rightKey)) {
    const candidate = keyBetween(leftKey, rightKey);
    if (candidate.length <= REBALANCE_AT) return candidate;
  }
  return rebalance();
}

export const notebookUpdate = defineCommand({
  name: 'notes.notebook.update',
  input: zNotebookUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: notebookTarget,
  handler: async (ctx, input): Promise<NotebookWritten> => {
    const userId = userOf(ctx.actor);
    const wholeOrg = await hasWholeOrgScope(ctx.trx);

    const peek = await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(NOTEBOOK_COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notebookId)
      .executeTakeFirst();
    if (!peek) throw notebookNotFound();

    if (input.visibility !== undefined && input.visibility !== peek.visibility && peek.author_user_id !== userId) {
      throw notebookAuthorOnly();
    }
    if (!canManageNotebook(peek, userId, ctx.role, wholeOrg)) {
      throw notebookAuthorOnly();
    }
    if (input.visibility === 'org' && !wholeOrg) {
      throw new DomainError('FORBIDDEN', 403, 'Thành viên giới hạn theo pháp nhân không chia sẻ được sổ tay dùng chung');
    }

    if (input.reorder) {
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`notes.notebook.reorder:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    }
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`notes.notebook:${ctx.orgId}:${input.notebookId}`}, 0))`.execute(ctx.trx);

    const before = await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(NOTEBOOK_COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notebookId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw notebookNotFound();
    if (before.revision !== input.revision) throw notebookRevisionConflict(before.revision);

    const nextVisibility = input.visibility ?? before.visibility;
    if (before.visibility === 'org' && nextVisibility === 'private') {
      const sharedNote = await ctx.trx
        .selectFrom('ludy_notes.note')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('notebook_id', '=', before.id)
        .where('visibility', '=', 'org')
        .limit(1)
        .executeTakeFirst();
      if (sharedNote) throw notebookHasSharedNotes();
    }

    const nextName = input.name ?? before.name;
    const nextStack = input.stackName !== undefined ? input.stackName : before.stack_name;
    const nextPinned = input.pinned ?? before.pinned;
    const nextSortKey = input.reorder
      ? await computeReorderedSortKey(ctx, userId, wholeOrg, before.id, input.reorder.place, input.reorder.anchorId)
      : before.sort_key;

    const changed = [
      ...(before.name !== nextName ? ['name'] : []),
      ...(before.stack_name !== nextStack ? ['stackName'] : []),
      ...(before.visibility !== nextVisibility ? ['visibility'] : []),
      ...(before.pinned !== nextPinned ? ['pinned'] : []),
      ...(before.sort_key !== nextSortKey ? ['sortKey'] : []),
    ];

    let row: { id: string; revision: number };
    try {
      row = await ctx.trx
        .updateTable('ludy_notes.notebook')
        .set({
          name: nextName,
          stack_name: nextStack,
          visibility: nextVisibility,
          pinned: nextPinned,
          sort_key: nextSortKey,
          revision: before.revision + 1,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', before.id)
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
    } catch (err) {
      const pgErr = err as { code?: string; message?: string } | null;
      if (pgErr?.code === '23514' && pgErr.message?.includes('NOTES_NOTEBOOK_HAS_SHARED_NOTES')) {
        throw notebookHasSharedNotes();
      }
      throw err;
    }

    ctx.audit({
      notebookId: row.id,
      visibility: nextVisibility,
      revision: row.revision,
      changed,
      ...(before.name !== nextName ? { name: auditValue(NOTEBOOK, 'name', nextName) } : {}),
      ...(before.stack_name !== nextStack ? { stackName: auditValue(NOTEBOOK, 'stack_name', nextStack) } : {}),
    });

    return { notebookId: row.id, revision: row.revision };
  },
});

export const notebookDelete = defineCommand({
  name: 'notes.notebook.delete',
  input: zNotebookRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: notebookTarget,
  handler: async (ctx, input): Promise<NotebookDeleted> => {
    const userId = userOf(ctx.actor);
    const wholeOrg = await hasWholeOrgScope(ctx.trx);

    const peek = await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(['id', 'author_user_id', 'visibility'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notebookId)
      .executeTakeFirst();
    if (!peek) throw notebookNotFound();
    if (!canManageNotebook(peek, userId, ctx.role, wholeOrg)) throw notebookAuthorOnly();

    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`notes.notebook:${ctx.orgId}:${input.notebookId}`}, 0))`.execute(ctx.trx);

    const locked = await ctx.trx
      .selectFrom('ludy_notes.notebook')
      .select(['id', 'author_user_id', 'visibility'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notebookId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw notebookNotFound();

    await ctx.trx
      .deleteFrom('ludy_notes.notebook')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notebookId)
      .execute();

    ctx.audit({
      notebookId: input.notebookId,
      visibility: locked.visibility,
      authorUserId: locked.author_user_id,
    });

    return { notebookId: input.notebookId };
  },
});

// RLS-safe backlinks (#3559): reads ONLY non-trashed notes the caller is permitted to read under ludy_notes.note RLS.
// Another member's private note is never read, matched, or counted.
export const noteBacklinks = defineQuery({
  name: 'notes.note.backlinks',
  input: zNoteBacklinksInput,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    const target = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select(['id', 'title'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!target) throw new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');

    const candidates = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select([...NOTE_SUMMARY_COLUMNS, 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where('id', '<>', target.id)
      .where(sql<boolean>`pg_catalog.strpos(body, '[[') > 0`)
      .orderBy('pinned', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .limit(BACKLINK_SCAN_LIMIT)
      .execute();

    const matched: NoteSummary[] = [];
    for (const row of candidates) {
      if (noteMatchesBacklink(row.body, target)) {
        matched.push(noteSummaryRow(row, userId));
        if (matched.length >= input.limit) break;
      }
    }
    return matched;
  },
});

export const notebookCommands = [notebookCreate, notebookUpdate, notebookDelete];
export const notebookQueries = [notebookList, noteBacklinks];
