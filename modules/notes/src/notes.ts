// Members' notes (issue #1671, plan docs/plan/notes.md §3.3 to §3.5, ADR-0037). A note is private to its author or
// shared with the org; the database's row policies decide who reads and changes it, so every query here reads only
// what the caller may, and a note another member cannot read answers NOTE_NOT_FOUND as if it did not exist. The
// commands add the rules a row policy cannot express: only the author edits the text, the visibility and the links;
// owners and admins may also pin, archive and delete a shared note (to take down something wrong).
//
// Audit rows are anchored in the WORM stream and outlive an erasure, so a command's audit facts carry ids, the
// visibility and changed field names, and a marker for the text (auditValue), never the title, body or tags. Command
// results carry ids and the revision only, since idempotency rows keep them.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  auditValue,
  formatClippedNoteBody,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  NOTE_VERSION_RETENTION,
  zId,
  zNoteClip,
  zNoteCreate,
  zNoteLinkAdd,
  zNoteLinkRemove,
  zNoteList,
  zNoteLinkTarget,
  zNoteRef,
  zNoteRestoreVersion,
  zNoteSearch,
  zNoteSetVisibility,
  zNoteTemplateCreate,
  zNoteTemplateRef,
  zNoteTemplateUpdate,
  zNoteUpdate,
  type MeetingDetail,
  type Note,
  type NoteLinkTarget,
  type NotePrivateCount,
  type NoteRecordPanel,
  type NoteSummary,
  type NoteTemplate,
  type NoteTemplateDeleted,
  type NoteTemplateWritten,
  type NoteVersion,
  type NoteVisibility,
  type NoteWritten,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { loadNoteAttachments } from './attachments.ts';
import { canOpen, insertRecordLink, loadEnrichedLinks, NOTE_TARGET_QUERIES } from './links.ts';
import { lockNote, lockNotebook } from './locks.ts';
import { notesManifest } from './manifest.ts';
import { TODO_SUMMARY_COLUMNS, loadSourceNotes, todoSummaryRow } from './todos.ts';

export { NOTE_TARGET_QUERIES };

// Viewers write no note (notes.md decision N-4). They run the reads, where the row policies show them none but their
// own: a member made a viewer still reads what they wrote (ADR-0037 §2).
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const NOTE = notesManifest.tables.ludy_notes.note;
const NOTE_TEMPLATE = notesManifest.tables.ludy_notes.note_template;

const SUMMARY = ['id', 'author_user_id', 'notebook_id', 'visibility', 'title', 'tags', 'pinned', 'tainted', 'revision', 'created_at', 'updated_at', 'archived_at', 'deleted_at'] as const;
export const NOTE_SUMMARY_COLUMNS = SUMMARY;

interface SummaryRow {
  id: string;
  author_user_id: string;
  notebook_id: string | null;
  visibility: NoteVisibility;
  title: string;
  tags: string[];
  pinned: boolean;
  tainted: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function summary(r: SummaryRow, userId: string): NoteSummary {
  return {
    id: r.id,
    authorUserId: r.author_user_id,
    mine: r.author_user_id === userId,
    notebookId: r.notebook_id,
    visibility: r.visibility,
    title: r.title,
    tags: r.tags,
    pinned: r.pinned,
    tainted: r.tainted,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    archivedAt: iso(r.archived_at),
    deletedAt: iso(r.deleted_at),
  };
}
export const noteSummaryRow = summary;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

export async function hasWholeOrgScope(trx: QueryContext['trx']): Promise<boolean> {
  const { rows } = await sql<{ whole: boolean }>`SELECT ('*' = ANY ((ludy_kernel.ctx_le_scope())::text[])) AS whole`.execute(trx);
  return rows[0]?.whole === true;
}

const notFound = () => new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');
const notebookNotFound = () => new DomainError('NOTEBOOK_NOT_FOUND', 404, 'Không tìm thấy sổ tay này');
const sharedNotePrivateNotebook = () =>
  new DomainError('NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', 422, 'Ghi chú dùng chung không thể đặt trong sổ tay riêng; hãy chọn sổ tay dùng chung hoặc bỏ chọn sổ tay');

function rethrowNotebookConstraintError(err: unknown): never {
  const pgErr = err as { code?: string; message?: string } | null;
  if (pgErr?.code === '23514' && pgErr.message?.includes('NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK')) {
    throw sharedNotePrivateNotebook();
  }
  if (pgErr?.code === '42501' && pgErr.message?.includes('NOTES_NOTEBOOK_NOT_ACCESSIBLE')) {
    throw notebookNotFound();
  }
  throw err;
}

// Checks notebook readability under caller SELECT RLS with uniform 404 for missing or unreadable notebooks
// so cross-member private notebook_id probing yields zero existence oracle, takes a shared per-notebook advisory
// lock (SELECT FOR SHARE in PostgreSQL would apply UPDATE RLS and hide shared notebooks from plain members),
// re-reads under the lock, and rejects shared notes in private notebooks.
export async function resolveNotebookForNote(
  ctx: CommandContext,
  notebookId: string,
  noteAuthorUserId: string,
  noteVisibility: NoteVisibility,
): Promise<{ id: string; visibility: NoteVisibility }> {
  const normNotebookId = notebookId.toLowerCase();
  const first = await ctx.trx
    .selectFrom('ludy_notes.notebook')
    .select(['id', 'author_user_id', 'visibility'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', normNotebookId)
    .executeTakeFirst();
  if (!first) throw notebookNotFound();
  await lockNotebook(ctx, normNotebookId, true);
  const nb = await ctx.trx
    .selectFrom('ludy_notes.notebook')
    .select(['id', 'author_user_id', 'visibility'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', normNotebookId)
    .executeTakeFirst();
  if (!nb) throw notebookNotFound();
  if (nb.visibility === 'private' && nb.author_user_id !== noteAuthorUserId) throw notebookNotFound();
  if (nb.visibility === 'private' && noteVisibility === 'org') throw sharedNotePrivateNotebook();
  return { id: nb.id, visibility: nb.visibility };
}

const notebookAuditFact = (noteVisibility: NoteVisibility, notebookId: string | null) =>
  notebookId === null ? { notebookId: null } : noteVisibility === 'org' ? { notebookId } : { notebook: 'private' as const };

// The note as the caller may read it (row policies), with its body, locked for a change when `lock` is set.
// Every `lock = true` caller (loadForChange, noteUpdate, noteSetVisibility) already performed a pre-lock read
// via `load(..., false)`, so no extra pre-lock SELECT is needed here.
async function load(ctx: Pick<QueryContext, 'trx' | 'orgId'>, noteId: string, lock: boolean): Promise<SummaryRow & { body: string }> {
  if (lock) await lockNote(ctx, noteId, false);
  let q = ctx.trx.selectFrom('ludy_notes.note').select([...SUMMARY, 'body']).where('org_id', '=', ctx.orgId).where('id', '=', noteId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

// The note for a change: checked against what the caller may read, then locked. FOR UPDATE also applies the update
// policy, which hides a shared note from a plain member, so the check comes first and names the refusal.
export async function loadForChange(ctx: CommandContext, noteId: string, check: (row: SummaryRow) => void): Promise<SummaryRow & { body: string }> {
  check(await load(ctx, noteId, false));
  return load(ctx, noteId, true);
}

export function assertAuthor(row: SummaryRow, userId: string): void {
  if (row.author_user_id !== userId) throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú mới làm được việc này');
}

// The author, or for a shared note an owner or admin of the org.
function assertMayManage(ctx: CommandContext, row: SummaryRow, userId: string): void {
  if (row.author_user_id === userId) return;
  if (row.visibility === 'org' && ctx.role !== null && MANAGERS.includes(ctx.role)) return;
  throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú, hoặc chủ sở hữu và quản trị viên với ghi chú dùng chung, mới làm được việc này');
}

export function assertNotInTrash(row: SummaryRow): void {
  if (row.deleted_at !== null) throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
}

async function addLink(ctx: CommandContext, row: Pick<SummaryRow, 'id' | 'visibility'>, userId: string, targetType: NoteLinkTarget, targetId: string): Promise<string> {
  const linkId = await insertRecordLink(ctx, { kind: 'note', id: row.id }, userId, targetType, targetId);
  // A shared note shows on the party's timeline with a fixed summary; a private one writes nothing there (notes.md §3.6).
  if (row.visibility === 'org' && targetType === 'kernel.party') await ctx.activity('kernel.party', targetId, 'notes.note_linked', 'Thêm ghi chú');
  return linkId;
}

const written = (row: Pick<SummaryRow, 'id' | 'revision'>): NoteWritten => ({ noteId: row.id, revision: row.revision });

// The record a link names, as the audit row keeps it: for a shared note, its type and id; for a private one, only that
// it is private. Audit rows are append-only, exported whole to the owner and kept after the member's notes are purged,
// so they may say which note was linked and when, never which record a private note is about (ADR-0037 §3).
const linkTargetFact = (visibility: NoteVisibility, targetType: string, targetId: string) =>
  visibility === 'org' ? { targetType, targetId } : { target: 'private' as const };

// A link added or removed changes the note as others see it; touching the note sends its stream hint (#69), so open
// apps read the note and the record's panel again.
async function touch(ctx: CommandContext, noteId: string): Promise<void> {
  await ctx.trx
    .updateTable('ludy_notes.note')
    .set({ updated_at: sql<Date>`GREATEST(updated_at, ${ctx.now})` })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', noteId)
    .execute();
}
const target = (input: { noteId: string }) => ({ type: 'notes.note', id: input.noteId });

// Saves the pre-edit state of a note into ludy_notes.note_version (#3562, Notes v2 E3). A database trigger on
// ludy_notes.note_version automatically prunes snapshots beyond the newest NOTE_VERSION_RETENTION (20) per note.
export async function recordNoteVersionSnapshot(
  ctx: CommandContext,
  before: {
    id: string;
    author_user_id: string;
    revision: number;
    title: string;
    body: string;
    tags: string[];
    tainted: boolean;
    updated_at: Date | string;
  },
): Promise<void> {
  await ctx.trx
    .insertInto('ludy_notes.note_version')
    .values({
      org_id: ctx.orgId,
      note_id: before.id,
      author_user_id: before.author_user_id,
      revision: before.revision,
      title: before.title,
      body: before.body,
      tags: before.tags,
      tainted: before.tainted,
      created_at: new Date(before.updated_at),
    })
    .onConflict((oc) => oc.columns(['org_id', 'note_id', 'revision']).doNothing())
    .execute();
}

export const noteCreate = defineCommand({
  name: 'notes.note.create',
  input: zNoteCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const notebookId = input.notebookId ?? null;
    if (notebookId !== null) {
      await resolveNotebookForNote(ctx, notebookId, userId, input.visibility);
    }
    const row = await ctx.trx
      .insertInto('ludy_notes.note')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        notebook_id: notebookId,
        visibility: input.visibility,
        title: input.title,
        body: input.body,
        tags: input.tags,
        tainted: input.tainted ?? false,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();
    const linkId = input.link ? await addLink(ctx, row, userId, input.link.targetType, input.link.targetId) : null;
    ctx.audit({
      noteId: row.id,
      visibility: row.visibility,
      title: auditValue(NOTE, 'title', input.title),
      tags: auditValue(NOTE, 'tags', input.tags.length > 0 ? input.tags : null),
      ...(notebookId !== null ? notebookAuditFact(row.visibility, notebookId) : {}),
      ...(input.tainted !== undefined ? { tainted: input.tainted } : {}),
      ...(input.link ? { linkId, ...linkTargetFact(row.visibility, input.link.targetType, input.link.targetId) } : {}),
    });
    return written(row);
  },
});

// Extension Quick Capture and 1-click Web Clipper (#3560, Notes v2 E4): writes one private, tainted note for the
// caller. Visibility is fixed to 'private' and tainted to true on the server regardless of input, so extension captures
// never expose clipped text to other members or to Vy before the author reviews or edits it.
export const noteClip = defineCommand({
  name: 'notes.note.clip',
  input: zNoteClip,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  extension: { scope: 'notes' },
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const body = formatClippedNoteBody(input.body, input.sourceUrl ?? null);
    const row = await ctx.trx
      .insertInto('ludy_notes.note')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        visibility: 'private',
        title: input.title,
        body,
        tags: input.tags,
        tainted: true,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      noteId: row.id,
      visibility: row.visibility,
      title: auditValue(NOTE, 'title', input.title),
      tags: auditValue(NOTE, 'tags', input.tags.length > 0 ? input.tags : null),
      tainted: true,
    });
    return written(row);
  },
});

// Audits an extension token exchange when the token carries the 'notes' scope without 'meetings' (#3560).
export const notesExtensionExchanged = defineCommand({
  name: 'notes.extension.exchanged',
  input: z.strictObject({ codeId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  extension: { scope: 'notes' },
  writes: [],
  handler: async (ctx, input): Promise<{ recorded: true }> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.extension) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ mã của tiện ích mới ghi nhận được lượt đổi mã');
    }
    ctx.audit({ codeId: input.codeId });
    return { recorded: true as const };
  },
});

export const noteUpdate = defineCommand({
  name: 'notes.note.update',
  input: zNoteUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const editsText = input.title !== undefined || input.body !== undefined || input.tags !== undefined;
    const peek = await load(ctx, input.noteId, false);
    if (editsText) assertAuthor(peek, userId);
    else assertMayManage(ctx, peek, userId);
    assertNotInTrash(peek);

    // Acquire shared notebook advisory lock before locking note FOR UPDATE (canonical notebook -> note lock order).
    const resolvedNotebook =
      input.notebookId !== undefined && input.notebookId !== null
        ? await resolveNotebookForNote(ctx, input.notebookId, peek.author_user_id, peek.visibility)
        : null;

    const before = await load(ctx, input.noteId, true);
    if (editsText) assertAuthor(before, userId);
    else assertMayManage(ctx, before, userId);
    assertNotInTrash(before);
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision: before.revision });
    }
    if (resolvedNotebook !== null && resolvedNotebook.visibility === 'private' && before.visibility === 'org') {
      throw sharedNotePrivateNotebook();
    }

    const nextTitle = input.title ?? before.title;
    const nextBody = input.body ?? before.body;
    const nextTags = input.tags ?? before.tags;
    const nextNotebookId = input.notebookId !== undefined ? input.notebookId : before.notebook_id;

    const contentEdited = before.title !== nextTitle || before.body !== nextBody;
    const tagsChanged = before.tags.join('\u0000') !== nextTags.join('\u0000');
    const clearTaint = before.tainted && contentEdited;
    const changed = [
      ...(before.title !== nextTitle ? ['title'] : []),
      ...(before.body !== nextBody ? ['body'] : []),
      ...(tagsChanged ? ['tags'] : []),
      ...(before.notebook_id !== nextNotebookId ? ['notebookId'] : []),
      ...(clearTaint ? ['tainted'] : []),
    ];
    if (contentEdited || tagsChanged) {
      await recordNoteVersionSnapshot(ctx, before);
    }
    let row: { id: string; revision: number };
    try {
      row = await ctx.trx
        .updateTable('ludy_notes.note')
        .set({
          ...(input.title !== undefined ? { title: nextTitle } : {}),
          ...(input.body !== undefined ? { body: nextBody } : {}),
          ...(input.tags !== undefined ? { tags: nextTags } : {}),
          ...(input.notebookId !== undefined ? { notebook_id: nextNotebookId } : {}),
          ...(clearTaint ? { tainted: false } : {}),
          revision: before.revision + 1,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.noteId)
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
    } catch (err) {
      rethrowNotebookConstraintError(err);
    }
    ctx.audit({
      noteId: row.id,
      revision: row.revision,
      changed,
      ...(before.notebook_id !== nextNotebookId ? notebookAuditFact(before.visibility, nextNotebookId) : {}),
    });
    return written(row);
  },
});

const zNoteFromMeetingSummaryCommand = z.strictObject({
  meetingId: zNoteRef.shape.noteId,
  title: z.string().trim().min(1).max(NOTE_TITLE_MAX),
  body: z.string().max(NOTE_BODY_MAX),
});

// Saves a meeting's summary as a shared org note linked to the meeting (#1679, step N10). Always starts tainted until
// the author edits its title or body. Sensitive summary text is read by the API handler via Runtime.query before calling
// this command, since Runtime.lookup refuses sensitive queries inside a command transaction.
export const noteFromMeetingSummary = defineCommand({
  name: 'notes.note.from_meeting_summary',
  input: zNoteFromMeetingSummaryCommand,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const meetingRes = await ctx.query<MeetingDetail>('meetings.meeting.get', { meetingId: input.meetingId });
    if (meetingRes.status === 'not_installed') {
      throw new DomainError('NOTES_MEETING_UNAVAILABLE', 400, 'Tính năng Biên bản cuộc họp đang tắt');
    }
    const title = input.title.trim().slice(0, NOTE_TITLE_MAX) || 'Tóm tắt cuộc họp';
    const body = input.body.slice(0, NOTE_BODY_MAX);
    const row = await ctx.trx
      .insertInto('ludy_notes.note')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        visibility: 'org',
        title,
        body,
        tags: [],
        tainted: true,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();
    const linkId = await addLink(ctx, row, userId, 'meetings.meeting', input.meetingId);
    ctx.audit({
      noteId: row.id,
      visibility: row.visibility,
      title: auditValue(NOTE, 'title', title),
      tainted: true,
      linkId,
      targetType: 'meetings.meeting',
      targetId: input.meetingId,
    });
    return written(row);
  },
});

export const noteSetVisibility = defineCommand({
  name: 'notes.note.set_visibility',
  input: zNoteSetVisibility,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const peek = await load(ctx, input.noteId, false);
    assertAuthor(peek, userId);
    if (peek.visibility === input.visibility) return written(peek);
    if (peek.notebook_id !== null) {
      if (input.visibility === 'org') {
        await resolveNotebookForNote(ctx, peek.notebook_id, peek.author_user_id, 'org');
      } else {
        // Turning a note private while inside a notebook triggers b_note_notebook_integrity FOR SHARE on that notebook;
        // acquire shared notes.erase + notebook lock first to keep canonical notebook -> note lock order.
        await lockNotebook(ctx, peek.notebook_id, true);
      }
    }
    const before = await load(ctx, input.noteId, true);
    assertAuthor(before, userId);
    if (before.visibility === input.visibility) return written(before);
    if (input.visibility === 'org' && before.notebook_id !== null && before.notebook_id !== peek.notebook_id) {
      // Do not acquire a new notebook lock while already holding note FOR UPDATE (canonical lock order is notebook -> note);
      // verify accessibility without locking and rely on b_note_notebook_integrity to enforce cross-visibility atomically.
      const movedNb = await ctx.trx
        .selectFrom('ludy_notes.notebook')
        .select(['id', 'author_user_id', 'visibility'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', before.notebook_id)
        .executeTakeFirst();
      if (!movedNb || (movedNb.visibility === 'private' && movedNb.author_user_id !== before.author_user_id)) {
        throw notebookNotFound();
      }
      if (movedNb.visibility === 'private') throw sharedNotePrivateNotebook();
    }
    let row: { id: string; revision: number };
    try {
      row = await ctx.trx
        .updateTable('ludy_notes.note')
        .set({ visibility: input.visibility, revision: before.revision + 1, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.noteId)
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
    } catch (err) {
      rethrowNotebookConstraintError(err);
    }
    ctx.audit({ noteId: row.id, visibility: input.visibility, previousVisibility: before.visibility });
    return written(row);
  },
});

// Pin, archive, delete and their reverses: the author, or an owner or admin for a shared note. They leave the text
// and the revision alone, so they never conflict with the author's edit in progress.
function stateCommand(name: string, change: (now: Date) => { pinned?: boolean; archived_at?: Date | null; deleted_at?: Date | null }, allowInTrash: boolean) {
  return defineCommand({
    name,
    input: zNoteRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<NoteWritten> => {
      const userId = userOf(ctx.actor);
      const before = await loadForChange(ctx, input.noteId, (row) => assertMayManage(ctx, row, userId));
      if (!allowInTrash) assertNotInTrash(before);
      const set = change(ctx.now);
      await ctx.trx.updateTable('ludy_notes.note').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.noteId).execute();
      ctx.audit({ noteId: input.noteId, visibility: before.visibility, authorUserId: before.author_user_id, changed: Object.keys(set) });
      return written(before);
    },
  });
}

export const notePin = stateCommand('notes.note.pin', () => ({ pinned: true }), false);
export const noteUnpin = stateCommand('notes.note.unpin', () => ({ pinned: false }), false);
export const noteArchive = stateCommand('notes.note.archive', (now) => ({ archived_at: now }), false);
// Back from the archive or the trash.
export const noteRestore = stateCommand('notes.note.restore', () => ({ archived_at: null, deleted_at: null }), true);
// To the trash, which the daily job empties after NOTE_TRASH_DAYS.
export const noteDelete = stateCommand('notes.note.delete', (now) => ({ deleted_at: now }), false);

export const linkAdd = defineCommand({
  name: 'notes.link.add',
  input: zNoteLinkAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<{ noteId: string; linkId: string }> => {
    const userId = userOf(ctx.actor);
    const note = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(note);
    const linkId = await addLink(ctx, note, userId, input.targetType, input.targetId);
    await touch(ctx, input.noteId);
    ctx.audit({ noteId: input.noteId, linkId, ...linkTargetFact(note.visibility, input.targetType, input.targetId) });
    return { noteId: input.noteId, linkId };
  },
});

export const linkRemove = defineCommand({
  name: 'notes.link.remove',
  input: zNoteLinkRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ noteId: string; linkId: string }> => {
    const userId = userOf(ctx.actor);
    const link = await ctx.trx
      .selectFrom('ludy_notes.link')
      .select(['note_id', 'target_type', 'target_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .executeTakeFirst();
    if (!link || link.note_id === null) throw new DomainError('NOTE_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    const note = await loadForChange(ctx, link.note_id, (row) => assertAuthor(row, userId));
    await ctx.trx.deleteFrom('ludy_notes.link').where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).execute();
    await touch(ctx, link.note_id);
    ctx.audit({ noteId: link.note_id, linkId: input.linkId, ...linkTargetFact(note.visibility, link.target_type, link.target_id) });
    return { noteId: link.note_id, linkId: input.linkId };
  },
});

export const noteList = defineQuery({
  name: 'notes.note.list',
  input: zNoteList,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    let q = ctx.trx.selectFrom('ludy_notes.note as n').select(SUMMARY.map((c) => `n.${c}` as const)).where('n.org_id', '=', ctx.orgId);
    if (input.view === 'trash') q = q.where('n.deleted_at', 'is not', null);
    else {
      q = q.where('n.deleted_at', 'is', null);
      if (input.view === 'archived') q = q.where('n.archived_at', 'is not', null);
      else q = q.where('n.archived_at', 'is', null);
      if (input.view === 'mine') q = q.where('n.author_user_id', '=', userId);
      if (input.view === 'shared') q = q.where('n.visibility', '=', 'org');
      if (input.view === 'pinned') q = q.where('n.pinned', '=', true);
    }
    if (input.notebookId === 'unfiled') q = q.where('n.notebook_id', 'is', null);
    else if (input.notebookId !== undefined) q = q.where('n.notebook_id', '=', input.notebookId);
    const stackName = input.stackName;
    if (stackName !== undefined) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('ludy_notes.notebook as b')
            .select('b.id')
            .whereRef('b.org_id', '=', 'n.org_id')
            .whereRef('b.id', '=', 'n.notebook_id')
            .where('b.stack_name', '=', stackName),
        ),
      );
    }
    if (input.tag !== undefined) q = q.where(sql<boolean>`${input.tag} = ANY (n.tags)`);
    const t = input.target;
    if (t) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('ludy_notes.link as l')
            .select('l.id')
            .whereRef('l.org_id', '=', 'n.org_id')
            .whereRef('l.note_id', '=', 'n.id')
            .where('l.target_type', '=', t.targetType)
            .where('l.target_id', '=', t.targetId),
        ),
      );
    }
    const rows = await q.orderBy('n.pinned', 'desc').orderBy('n.updated_at', 'desc').orderBy('n.id').limit(input.limit).execute();
    return rows.map((r) => summary(r, userId));
  },
});

export const noteGet = defineQuery({
  name: 'notes.note.get',
  input: zNoteRef,
  access: READERS,
  handler: async (ctx, input): Promise<Note> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select([...SUMMARY, 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const [shown, attachments] = await Promise.all([
      loadEnrichedLinks(ctx, { kind: 'note', id: input.noteId }),
      loadNoteAttachments(ctx, input.noteId),
    ]);
    return { ...summary(row, userId), body: row.body, links: shown, attachments };
  },
});

// Words typed without Vietnamese marks find them ("hoa don" finds "hóa đơn"), each as a prefix, in the title, tags and
// body of the notes the caller may read, outside the trash, or in the file name or extracted text of one of their
// attachments (#3561): the row policies decide, so another member's private note is never found, and the attachments'
// own policy keeps their words from any agent. The closest matches first, then the latest.
export const noteSearch = defineQuery({
  name: 'notes.note.search',
  input: zNoteSearch,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    const rows = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select(SUMMARY)
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where(
        sql<boolean>`(note.search @@ ludy_kernel.search_query(${input.q}) OR EXISTS (
          SELECT 1 FROM ludy_notes.attachment a
           WHERE a.org_id = note.org_id AND a.note_id = note.id AND a.search @@ ludy_kernel.search_query(${input.q})))`,
      )
      .orderBy(sql`pg_catalog.ts_rank(note.search, ludy_kernel.search_query(${input.q}))`, 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .limit(input.limit)
      .execute();
    return rows.map((r) => summary(r, userId));
  },
});

// The notes and private to-dos of one record (its panel): pinned notes first, then the latest PANEL_LATEST others,
// outside the archive and the trash, plus the viewer's own linked private to-dos.
const PANEL_PINNED = 20;
const PANEL_LATEST = 3;
const PANEL_TODOS = 20;
export const recordPanel = defineQuery({
  name: 'notes.record.panel',
  input: zNoteLinkTarget,
  access: READERS,
  handler: async (ctx, input): Promise<NoteRecordPanel> => {
    const userId = userOf(ctx.actor);
    if (
      input.targetType === 'kernel.task' ||
      (input.targetType === 'projects.project' && ctx.installed('projects'))
    ) {
      if (!(await canOpen(ctx, input.targetType, input.targetId))) {
        return { pinned: [], latest: [], todos: [] };
      }
    }
    const base = ctx.trx
      .selectFrom('ludy_notes.note as n')
      .innerJoin('ludy_notes.link as l', (j) => j.onRef('l.org_id', '=', 'n.org_id').onRef('l.note_id', '=', 'n.id'))
      .select(SUMMARY.map((c) => `n.${c}` as const))
      .where('n.org_id', '=', ctx.orgId)
      .where('l.target_type', '=', input.targetType)
      .where('l.target_id', '=', input.targetId)
      .where('n.archived_at', 'is', null)
      .where('n.deleted_at', 'is', null);
    const pinned = await base.where('n.pinned', '=', true).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_PINNED).execute();
    const latest = await base.where('n.pinned', '=', false).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_LATEST).execute();
    const todoRows = await ctx.trx
      .selectFrom('ludy_notes.todo as t')
      .innerJoin('ludy_notes.link as l', (j) => j.onRef('l.org_id', '=', 't.org_id').onRef('l.todo_id', '=', 't.id'))
      .select(TODO_SUMMARY_COLUMNS.map((c) => `t.${c}` as const))
      .where('t.org_id', '=', ctx.orgId)
      .where('l.target_type', '=', input.targetType)
      .where('l.target_id', '=', input.targetId)
      .where('t.deleted_at', 'is', null)
      .where('t.status', 'in', ['open', 'done'])
      .orderBy(sql`t.status = 'open'`, 'desc')
      .orderBy('t.sort_key')
      .orderBy('t.id')
      .limit(PANEL_TODOS)
      .execute();
    const sourceNotes = await loadSourceNotes(ctx, todoRows);
    const now = new Date();
    return {
      pinned: pinned.map((r) => summary(r, userId)),
      latest: latest.map((r) => summary(r, userId)),
      todos: todoRows.map((r) => todoSummaryRow(r, now, sourceNotes)),
    };
  },
});

// How many private notes each member has, for an owner or admin before removing one (ADR-0037 §4): a count from
// ludy_notes.private_counts(), which checks the caller's role itself, never the text.
export const privateCounts = defineQuery({
  name: 'notes.private_counts',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<NotePrivateCount[]> => {
    const { rows } = await sql<{ author_user_id: string; notes: string }>`SELECT author_user_id, notes FROM ludy_notes.private_counts()`.execute(ctx.trx);
    return rows.map((r) => ({ userId: r.author_user_id, notes: Number(r.notes) }));
  },
});

// ---------------------------------------------------------------------------
// Rolling 20-snapshot version history (#3562, Notes v2 E3)
// ---------------------------------------------------------------------------

export const noteVersions = defineQuery({
  name: 'notes.note.versions',
  input: zNoteRef,
  access: READERS,
  handler: async (ctx, input): Promise<NoteVersion[]> => {
    userOf(ctx.actor);
    const note = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!note) throw notFound();
    const rows = await ctx.trx
      .selectFrom('ludy_notes.note_version')
      .select(['id', 'note_id', 'author_user_id', 'revision', 'title', 'body', 'tags', 'tainted', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('note_id', '=', input.noteId)
      .orderBy('revision', 'desc')
      .orderBy('id', 'desc')
      .limit(NOTE_VERSION_RETENTION)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      authorUserId: r.author_user_id,
      revision: r.revision,
      title: r.title,
      body: r.body,
      tags: r.tags,
      tainted: r.tainted,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  },
});

export const noteRestoreVersion = defineCommand({
  name: 'notes.note.restore_version',
  input: zNoteRestoreVersion,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(before);
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi khôi phục', {
        revision: before.revision,
      });
    }
    const version = await ctx.trx
      .selectFrom('ludy_notes.note_version')
      .select(['id', 'revision', 'title', 'body', 'tags', 'tainted'])
      .where('org_id', '=', ctx.orgId)
      .where('note_id', '=', input.noteId)
      .where('id', '=', input.versionId)
      .executeTakeFirst();
    if (!version) {
      throw new DomainError('NOTE_VERSION_NOT_FOUND', 404, 'Không tìm thấy phiên bản ghi chú này');
    }
    const contentDiffers =
      before.title !== version.title ||
      before.body !== version.body ||
      before.tags.join('\u0000') !== version.tags.join('\u0000');
    if (contentDiffers) {
      await recordNoteVersionSnapshot(ctx, before);
    }
    // Never clear taint on restore: a tainted note stays tainted until a human edits its text, and restoring a tainted
    // snapshot re-marks the note tainted so Vy does not read unreviewed AI/clipped text as clean.
    const nextTainted = before.tainted || version.tainted;
    const changed = [
      ...(before.title !== version.title ? ['title'] : []),
      ...(before.body !== version.body ? ['body'] : []),
      ...(before.tags.join('\u0000') !== version.tags.join('\u0000') ? ['tags'] : []),
      ...(nextTainted !== before.tainted ? ['tainted'] : []),
    ];
    const row = await ctx.trx
      .updateTable('ludy_notes.note')
      .set({
        title: version.title,
        body: version.body,
        tags: version.tags,
        tainted: nextTainted,
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      noteId: row.id,
      revision: row.revision,
      restoredVersionId: version.id,
      restoredFromRevision: version.revision,
      changed,
      ...(nextTainted !== before.tainted ? { tainted: nextTainted } : {}),
    });
    return written(row);
  },
});

// ---------------------------------------------------------------------------
// Quick note templates (#3562, Notes v2 E3, ADR-0037)
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  author_user_id: string;
  visibility: NoteVisibility;
  name: string;
  title: string;
  body: string;
  tags: string[];
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const TEMPLATE_COLUMNS = ['id', 'author_user_id', 'visibility', 'name', 'title', 'body', 'tags', 'revision', 'created_at', 'updated_at'] as const;

const templateNotFound = () => new DomainError('NOTE_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu ghi chú này');

function templateView(r: TemplateRow, userId: string): NoteTemplate {
  return {
    id: r.id,
    authorUserId: r.author_user_id,
    mine: r.author_user_id === userId,
    visibility: r.visibility,
    name: r.name,
    title: r.title,
    body: r.body,
    tags: r.tags,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function loadTemplate(ctx: Pick<QueryContext, 'trx' | 'orgId'>, templateId: string, lock: boolean): Promise<TemplateRow> {
  let q = ctx.trx.selectFrom('ludy_notes.note_template').select(TEMPLATE_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', templateId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw templateNotFound();
  return row as TemplateRow;
}

async function loadTemplateForChange(ctx: CommandContext, templateId: string, check: (row: TemplateRow) => void): Promise<TemplateRow> {
  check(await loadTemplate(ctx, templateId, false));
  return loadTemplate(ctx, templateId, true);
}

function assertMayManageTemplate(ctx: CommandContext, row: TemplateRow, userId: string, wholeOrg: boolean): void {
  if (row.author_user_id === userId) return;
  if (row.visibility === 'org' && wholeOrg && ctx.role !== null && MANAGERS.includes(ctx.role)) return;
  throw new DomainError('NOTE_TEMPLATE_AUTHOR_ONLY', 403, 'Chỉ người tạo mẫu, hoặc chủ sở hữu và quản trị viên với mẫu dùng chung, mới sửa hoặc xóa được mẫu này');
}

const templateTarget = (input: { templateId: string }) => ({ type: 'notes.template', id: input.templateId });

export const noteTemplateList = defineQuery({
  name: 'notes.template.list',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<NoteTemplate[]> => {
    const userId = userOf(ctx.actor);
    const rows = await ctx.trx
      .selectFrom('ludy_notes.note_template')
      .select(TEMPLATE_COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .limit(200)
      .execute();
    return rows.map((r) => templateView(r as TemplateRow, userId));
  },
});

export const noteTemplateCreate = defineCommand({
  name: 'notes.template.create',
  input: zNoteTemplateCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NoteTemplateWritten> => {
    const userId = userOf(ctx.actor);
    if (input.visibility === 'org' && !(await hasWholeOrgScope(ctx.trx))) {
      throw new DomainError('FORBIDDEN', 403, 'Thành viên giới hạn theo pháp nhân không tạo được mẫu ghi chú dùng chung');
    }
    const row = await ctx.trx
      .insertInto('ludy_notes.note_template')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        visibility: input.visibility,
        name: input.name,
        title: input.title,
        body: input.body,
        tags: input.tags,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      templateId: row.id,
      visibility: row.visibility,
      name: auditValue(NOTE_TEMPLATE, 'name', input.name),
      title: auditValue(NOTE_TEMPLATE, 'title', input.title),
      tags: auditValue(NOTE_TEMPLATE, 'tags', input.tags.length > 0 ? input.tags : null),
    });
    return { templateId: row.id, revision: row.revision };
  },
});

export const noteTemplateUpdate = defineCommand({
  name: 'notes.template.update',
  input: zNoteTemplateUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: templateTarget,
  handler: async (ctx, input): Promise<NoteTemplateWritten> => {
    const userId = userOf(ctx.actor);
    const wholeOrg = await hasWholeOrgScope(ctx.trx);
    const before = await loadTemplateForChange(ctx, input.templateId, (row) => {
      assertMayManageTemplate(ctx, row, userId, wholeOrg);
      if (row.author_user_id !== userId && input.visibility !== 'org') {
        throw new DomainError('NOTE_TEMPLATE_AUTHOR_ONLY', 403, 'Chỉ người tạo mẫu mới chuyển được mẫu dùng chung về riêng tư');
      }
      if (input.visibility === 'org' && !wholeOrg) {
        throw new DomainError('FORBIDDEN', 403, 'Thành viên giới hạn theo pháp nhân không chia sẻ được mẫu ghi chú dùng chung');
      }
    });
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_TEMPLATE_REVISION_CONFLICT', 409, 'Mẫu ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', {
        revision: before.revision,
      });
    }
    const changed = [
      ...(before.name !== input.name ? ['name'] : []),
      ...(before.title !== input.title ? ['title'] : []),
      ...(before.body !== input.body ? ['body'] : []),
      ...(before.tags.join('\u0000') !== input.tags.join('\u0000') ? ['tags'] : []),
      ...(before.visibility !== input.visibility ? ['visibility'] : []),
    ];
    const row = await ctx.trx
      .updateTable('ludy_notes.note_template')
      .set({
        name: input.name,
        title: input.title,
        body: input.body,
        tags: input.tags,
        visibility: input.visibility,
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      templateId: row.id,
      revision: row.revision,
      visibility: input.visibility,
      ...(before.visibility !== input.visibility ? { previousVisibility: before.visibility } : {}),
      changed,
    });
    return { templateId: row.id, revision: row.revision };
  },
});

export const noteTemplateDelete = defineCommand({
  name: 'notes.template.delete',
  input: zNoteTemplateRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: templateTarget,
  handler: async (ctx, input): Promise<NoteTemplateDeleted> => {
    const userId = userOf(ctx.actor);
    const wholeOrg = await hasWholeOrgScope(ctx.trx);
    const before = await loadTemplateForChange(ctx, input.templateId, (row) => assertMayManageTemplate(ctx, row, userId, wholeOrg));
    await ctx.trx.deleteFrom('ludy_notes.note_template').where('org_id', '=', ctx.orgId).where('id', '=', input.templateId).execute();
    ctx.audit({ templateId: input.templateId, visibility: before.visibility, authorUserId: before.author_user_id });
    return { templateId: input.templateId };
  },
});

export const noteCommands = [
  noteCreate,
  noteClip,
  notesExtensionExchanged,
  noteFromMeetingSummary,
  noteUpdate,
  noteRestoreVersion,
  noteSetVisibility,
  notePin,
  noteUnpin,
  noteArchive,
  noteRestore,
  noteDelete,
  linkAdd,
  linkRemove,
  noteTemplateCreate,
  noteTemplateUpdate,
  noteTemplateDelete,
];
export const noteQueries = [noteList, noteGet, noteVersions, noteSearch, recordPanel, privateCounts, noteTemplateList];
