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
import { NOTE_SUMMARY_COLUMNS, noteSummaryRow } from './notes.ts';

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

async function hasWholeOrgScope(trx: QueryContext['trx']): Promise<boolean> {
  const { rows } = await sql<{ whole: boolean }>`SELECT ('*' = ANY ((ludy_kernel.ctx_le_scope())::text[])) AS whole`.execute(trx);
  return rows[0]?.whole === true;
}

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
      const fresh = spreadKeys(existing.length + 1);
      for (let i = 0; i < existing.length; i++) {
        await ctx.trx
          .updateTable('ludy_notes.notebook')
          .set({ sort_key: fresh[i] as string })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing[i]!.id)
          .execute();
      }
      sortKey = fresh[existing.length] as string;
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

async function computeReorderedSortKey(
  ctx: CommandContext,
  userId: string,
  wholeOrg: boolean,
  movingId: string,
  place: 'before' | 'after',
  anchorId: string,
): Promise<string> {
  const rows = await ctx.trx
    .selectFrom('ludy_notes.notebook')
    .select(['id', 'author_user_id', 'visibility', 'sort_key'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('sort_key')
    .orderBy('id')
    .execute();

  const others = rows.filter((r) => r.id !== movingId);
  const anchorIdx = others.findIndex((r) => r.id === anchorId);
  if (anchorIdx === -1) throw notebookNotFound();

  const leftIdx = place === 'before' ? anchorIdx - 1 : anchorIdx;
  const rightIdx = place === 'before' ? anchorIdx : anchorIdx + 1;
  const leftKey = leftIdx >= 0 ? (others[leftIdx]?.sort_key ?? null) : null;
  const rightKey = rightIdx < others.length ? (others[rightIdx]?.sort_key ?? null) : null;

  // Rewrites the keys of the notebooks the caller may manage, with the moving one at its place among them.
  const rebalance = async (): Promise<string> => {
    const editable = others.filter((r) => canManageNotebook(r, userId, ctx.role, wholeOrg));
    const editableAnchorIdx = editable.findIndex((r) => r.id === anchorId);
    const insertAt = editableAnchorIdx === -1 ? editable.length : place === 'before' ? editableAnchorIdx : editableAnchorIdx + 1;
    const fresh = spreadKeys(editable.length + 1);
    let cursor = 0;
    for (let i = 0; i < editable.length; i++) {
      if (cursor === insertAt) cursor++;
      await ctx.trx
        .updateTable('ludy_notes.notebook')
        .set({ sort_key: fresh[cursor] as string })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', editable[i]!.id)
        .execute();
      cursor++;
    }
    return fresh[insertAt] as string;
  };

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
    const nextToAnchor = keyBetween(lower, upper);
    return nextToAnchor.length <= REBALANCE_AT ? nextToAnchor : rebalance();
  }

  const candidate = keyBetween(leftKey, rightKey);
  if (candidate.length <= REBALANCE_AT) return candidate;
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
