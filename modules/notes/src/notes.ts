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
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  zNoteCreate,
  zNoteLinkAdd,
  zNoteLinkRemove,
  zNoteList,
  zNoteLinkTarget,
  zNoteRef,
  zNoteSearch,
  zNoteSetVisibility,
  zNoteUpdate,
  type MeetingDetail,
  type Note,
  type NoteLinkTarget,
  type NotePrivateCount,
  type NoteRecordPanel,
  type NoteSummary,
  type NoteVisibility,
  type NoteWritten,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { insertRecordLink, loadEnrichedLinks, NOTE_TARGET_QUERIES } from './links.ts';
import { notesManifest } from './manifest.ts';
import { TODO_SUMMARY_COLUMNS, loadSourceNotes, todoSummaryRow } from './todos.ts';

export { NOTE_TARGET_QUERIES };

// Viewers write no note (notes.md decision N-4). They run the reads, where the row policies show them none but their
// own: a member made a viewer still reads what they wrote (ADR-0037 §2).
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const NOTE = notesManifest.tables.crove_notes.note;

const SUMMARY = ['id', 'author_user_id', 'visibility', 'title', 'tags', 'pinned', 'tainted', 'revision', 'created_at', 'updated_at', 'archived_at', 'deleted_at'] as const;

interface SummaryRow {
  id: string;
  author_user_id: string;
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

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const notFound = () => new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');

// The note as the caller may read it (row policies), with its body, locked for a change when `lock` is set.
async function load(ctx: Pick<QueryContext, 'trx' | 'orgId'>, noteId: string, lock: boolean): Promise<SummaryRow & { body: string }> {
  let q = ctx.trx.selectFrom('crove_notes.note').select([...SUMMARY, 'body']).where('org_id', '=', ctx.orgId).where('id', '=', noteId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

// The note for a change: checked against what the caller may read, then locked. FOR UPDATE also applies the update
// policy, which hides a shared note from a plain member, so the check comes first and names the refusal.
async function loadForChange(ctx: CommandContext, noteId: string, check: (row: SummaryRow) => void): Promise<SummaryRow & { body: string }> {
  check(await load(ctx, noteId, false));
  return load(ctx, noteId, true);
}

function assertAuthor(row: SummaryRow, userId: string): void {
  if (row.author_user_id !== userId) throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú mới làm được việc này');
}

// The author, or for a shared note an owner or admin of the org.
function assertMayManage(ctx: CommandContext, row: SummaryRow, userId: string): void {
  if (row.author_user_id === userId) return;
  if (row.visibility === 'org' && ctx.role !== null && MANAGERS.includes(ctx.role)) return;
  throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú, hoặc chủ sở hữu và quản trị viên với ghi chú dùng chung, mới làm được việc này');
}

function assertNotInTrash(row: SummaryRow): void {
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
  await ctx.trx.updateTable('crove_notes.note').set({ updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', noteId).execute();
}
const target = (input: { noteId: string }) => ({ type: 'notes.note', id: input.noteId });

export const noteCreate = defineCommand({
  name: 'notes.note.create',
  input: zNoteCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .insertInto('crove_notes.note')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
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
      ...(input.tainted !== undefined ? { tainted: input.tainted } : {}),
      ...(input.link ? { linkId, ...linkTargetFact(row.visibility, input.link.targetType, input.link.targetId) } : {}),
    });
    return written(row);
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
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(before);
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision: before.revision });
    }
    const contentEdited = before.title !== input.title || before.body !== input.body;
    const clearTaint = before.tainted && contentEdited;
    const changed = [
      ...(before.title !== input.title ? ['title'] : []),
      ...(before.body !== input.body ? ['body'] : []),
      ...(before.tags.join('\u0000') !== input.tags.join('\u0000') ? ['tags'] : []),
      ...(clearTaint ? ['tainted'] : []),
    ];
    const row = await ctx.trx
      .updateTable('crove_notes.note')
      .set({
        title: input.title,
        body: input.body,
        tags: input.tags,
        ...(clearTaint ? { tainted: false } : {}),
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({ noteId: row.id, revision: row.revision, changed });
    return written(row);
  },
});

const zNoteFromMeetingSummaryCommand = z.strictObject({
  meetingId: zNoteUpdate.shape.noteId,
  title: zNoteUpdate.shape.title,
  body: zNoteUpdate.shape.body,
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
      .insertInto('crove_notes.note')
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
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    if (before.visibility === input.visibility) return written(before);
    const row = await ctx.trx
      .updateTable('crove_notes.note')
      .set({ visibility: input.visibility, revision: before.revision + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
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
      await ctx.trx.updateTable('crove_notes.note').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.noteId).execute();
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
      .selectFrom('crove_notes.link')
      .select(['note_id', 'target_type', 'target_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .executeTakeFirst();
    if (!link || link.note_id === null) throw new DomainError('NOTE_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    const note = await loadForChange(ctx, link.note_id, (row) => assertAuthor(row, userId));
    await ctx.trx.deleteFrom('crove_notes.link').where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).execute();
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
    let q = ctx.trx.selectFrom('crove_notes.note as n').select(SUMMARY.map((c) => `n.${c}` as const)).where('n.org_id', '=', ctx.orgId);
    if (input.view === 'trash') q = q.where('n.deleted_at', 'is not', null);
    else {
      q = q.where('n.deleted_at', 'is', null);
      if (input.view === 'archived') q = q.where('n.archived_at', 'is not', null);
      else q = q.where('n.archived_at', 'is', null);
      if (input.view === 'mine') q = q.where('n.author_user_id', '=', userId);
      if (input.view === 'shared') q = q.where('n.visibility', '=', 'org');
      if (input.view === 'pinned') q = q.where('n.pinned', '=', true);
    }
    if (input.tag !== undefined) q = q.where(sql<boolean>`${input.tag} = ANY (n.tags)`);
    const t = input.target;
    if (t) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('crove_notes.link as l')
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
      .selectFrom('crove_notes.note')
      .select([...SUMMARY, 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const shown = await loadEnrichedLinks(ctx, { kind: 'note', id: input.noteId });
    return { ...summary(row, userId), body: row.body, links: shown };
  },
});

// Words typed without Vietnamese marks find them ("hoa don" finds "hóa đơn"), each as a prefix, in the title, tags and
// body of the notes the caller may read, outside the trash: the row policies decide, so another member's private note
// is never found. The closest matches first, then the latest.
export const noteSearch = defineQuery({
  name: 'notes.note.search',
  input: zNoteSearch,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    const rows = await ctx.trx
      .selectFrom('crove_notes.note')
      .select(SUMMARY)
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`search @@ crove_kernel.search_query(${input.q})`)
      .orderBy(sql`pg_catalog.ts_rank(search, crove_kernel.search_query(${input.q}))`, 'desc')
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
    const base = ctx.trx
      .selectFrom('crove_notes.note as n')
      .innerJoin('crove_notes.link as l', (j) => j.onRef('l.org_id', '=', 'n.org_id').onRef('l.note_id', '=', 'n.id'))
      .select(SUMMARY.map((c) => `n.${c}` as const))
      .where('n.org_id', '=', ctx.orgId)
      .where('l.target_type', '=', input.targetType)
      .where('l.target_id', '=', input.targetId)
      .where('n.archived_at', 'is', null)
      .where('n.deleted_at', 'is', null);
    const pinned = await base.where('n.pinned', '=', true).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_PINNED).execute();
    const latest = await base.where('n.pinned', '=', false).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_LATEST).execute();
    const todoRows = await ctx.trx
      .selectFrom('crove_notes.todo as t')
      .innerJoin('crove_notes.link as l', (j) => j.onRef('l.org_id', '=', 't.org_id').onRef('l.todo_id', '=', 't.id'))
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
// crove_notes.private_counts(), which checks the caller's role itself, never the text.
export const privateCounts = defineQuery({
  name: 'notes.private_counts',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<NotePrivateCount[]> => {
    const { rows } = await sql<{ author_user_id: string; notes: string }>`SELECT author_user_id, notes FROM crove_notes.private_counts()`.execute(ctx.trx);
    return rows.map((r) => ({ userId: r.author_user_id, notes: Number(r.notes) }));
  },
});

export const noteCommands = [noteCreate, noteFromMeetingSummary, noteUpdate, noteSetVisibility, notePin, noteUnpin, noteArchive, noteRestore, noteDelete, linkAdd, linkRemove];
export const noteQueries = [noteList, noteGet, noteSearch, recordPanel, privateCounts];
