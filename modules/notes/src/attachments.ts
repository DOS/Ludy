// SPDX-License-Identifier: AGPL-3.0-only
// Isolated note attachments (#3561, docs/plan/notes-v2.md V2-5, owner decision A3, ADR-0037):
// <= 25 MiB files and clipboard screenshots attached directly to a note under ludy_notes.attachment
// and private BlobStore keys notes/<org_id>/<attachment_id>, never touching ludy_kernel.file.
import { sql } from 'kysely';
import {
  auditValue,
  NOTE_ATTACHMENTS_PER_NOTE_MAX,
  zNoteAttachmentCreate,
  zNoteAttachmentRef,
  zNoteRef,
  type NoteAttachment,
  type NoteAttachmentCreated,
  type NoteAttachmentDeleted,
  type NoteAttachmentExtractStatus,
  type NoteVisibility,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { notesManifest } from './manifest.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const ATTACHMENT = notesManifest.tables.ludy_notes.attachment;

export const NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT = 'notes.attachment.extract_queued';

interface AttachmentRow {
  id: string;
  note_id: string;
  author_user_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  extract_status: NoteAttachmentExtractStatus;
  created_at: Date | string;
}

export interface NoteAttachmentDownloadMeta {
  id: string;
  noteId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

const ATTACHMENT_COLUMNS = [
  'id',
  'note_id',
  'author_user_id',
  'filename',
  'content_type',
  'size_bytes',
  'sha256',
  'extract_status',
  'created_at',
] as const;

function requireHumanUser(actor: QueryContext['actor']): string {
  if (actor.type !== 'user' || actor.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ phiên đăng nhập người dùng mới thực hiện được việc này');
  }
  return actor.userId;
}

const noteNotFound = () => new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');
const attachmentNotFound = () => new DomainError('NOTE_ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy tệp đính kèm này');

function toNoteAttachment(row: AttachmentRow): NoteAttachment {
  return {
    id: row.id,
    noteId: row.note_id,
    authorUserId: row.author_user_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    extractStatus: row.extract_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function loadNoteAttachments(ctx: Pick<QueryContext, 'trx' | 'orgId'>, noteId: string): Promise<NoteAttachment[]> {
  const rows = await ctx.trx
    .selectFrom('ludy_notes.attachment')
    .select(ATTACHMENT_COLUMNS)
    .where('org_id', '=', ctx.orgId)
    .where('note_id', '=', noteId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toNoteAttachment);
}

async function loadParentNoteForWrite(
  ctx: CommandContext,
  noteId: string,
  check: (note: { id: string; author_user_id: string; visibility: NoteVisibility; deleted_at: Date | string | null }) => void,
) {
  const readable = await ctx.trx
    .selectFrom('ludy_notes.note')
    .select(['id', 'author_user_id', 'visibility', 'deleted_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', noteId)
    .executeTakeFirst();
  if (!readable) throw noteNotFound();
  check(readable);
  const locked = await ctx.trx
    .selectFrom('ludy_notes.note')
    .select(['id', 'author_user_id', 'visibility', 'deleted_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', noteId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw noteNotFound();
  check(locked);
  if (locked.deleted_at !== null) {
    throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
  }
  return locked;
}

export const noteAttachmentCreate = defineCommand({
  name: 'notes.attachment.create',
  input: zNoteAttachmentCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'notes.note', id: input.noteId }),
  handler: async (ctx, input): Promise<NoteAttachmentCreated> => {
    const userId = requireHumanUser(ctx.actor);
    const expectedKey = `notes/${ctx.orgId}/${input.attachmentId}`;
    if (input.storageKey !== expectedKey) {
      throw new DomainError('INVALID', 400, 'Khóa lưu trữ tệp đính kèm không hợp lệ');
    }
    const note = await loadParentNoteForWrite(ctx, input.noteId, (row) => {
      if (row.author_user_id !== userId) {
        throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú mới đính kèm được tệp');
      }
    });

    const existing = await ctx.trx
      .selectFrom('ludy_notes.attachment')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('note_id', '=', input.noteId)
      .executeTakeFirst();
    if (Number(existing?.n ?? 0) >= NOTE_ATTACHMENTS_PER_NOTE_MAX) {
      throw new DomainError('NOTE_ATTACHMENT_LIMIT', 422, `Mỗi ghi chú đính kèm tối đa ${NOTE_ATTACHMENTS_PER_NOTE_MAX} tệp`);
    }

    const row = await ctx.trx
      .insertInto('ludy_notes.attachment')
      .values({
        org_id: ctx.orgId,
        id: input.attachmentId,
        note_id: input.noteId,
        author_user_id: userId,
        filename: input.filename,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        sha256: input.sha256,
        storage_key: expectedKey,
        extracted_text: null,
        extract_status: input.extractStatus,
        created_at: ctx.now,
      })
      .returning(['id', 'note_id', 'extract_status', 'created_at'])
      .executeTakeFirstOrThrow();

    await ctx.trx
      .updateTable('ludy_notes.note')
      .set({ updated_at: sql<Date>`GREATEST(updated_at, ${ctx.now})` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .execute();

    if (row.extract_status === 'pending') {
      await ctx.emit(NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT, { attachmentId: row.id });
    }

    ctx.audit({
      noteId: input.noteId,
      attachmentId: row.id,
      visibility: note.visibility,
      filename: auditValue(ATTACHMENT, 'filename', input.filename),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      extractStatus: row.extract_status,
    });

    return {
      attachmentId: row.id,
      noteId: row.note_id,
      extractStatus: row.extract_status,
      createdAt: new Date(row.created_at).toISOString(),
    };
  },
});

export const noteAttachmentDelete = defineCommand({
  name: 'notes.attachment.delete',
  input: zNoteAttachmentRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'notes.attachment', id: input.attachmentId }),
  handler: async (ctx, input): Promise<NoteAttachmentDeleted> => {
    const userId = requireHumanUser(ctx.actor);
    const att = await ctx.trx
      .selectFrom('ludy_notes.attachment')
      .select(['id', 'note_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .executeTakeFirst();
    if (!att) throw attachmentNotFound();

    const note = await loadParentNoteForWrite(ctx, att.note_id, (row) => {
      if (row.author_user_id === userId) return;
      if (row.visibility === 'org' && ctx.role !== null && MANAGERS.includes(ctx.role)) return;
      throw new DomainError(
        'NOTE_AUTHOR_ONLY',
        403,
        'Chỉ người viết ghi chú, hoặc chủ sở hữu và quản trị viên với ghi chú dùng chung, mới xóa được tệp đính kèm',
      );
    });

    const deleted = await ctx.trx
      .deleteFrom('ludy_notes.attachment')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.attachmentId)
      .returning('id')
      .executeTakeFirst();
    if (!deleted) throw attachmentNotFound();

    await ctx.trx
      .updateTable('ludy_notes.note')
      .set({ updated_at: sql<Date>`GREATEST(updated_at, ${ctx.now})` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', att.note_id)
      .execute();

    ctx.audit({
      noteId: att.note_id,
      attachmentId: att.id,
      visibility: note.visibility,
    });

    return { noteId: att.note_id, attachmentId: att.id };
  },
});

export const noteAttachmentList = defineQuery({
  name: 'notes.attachment.list',
  input: zNoteRef,
  access: READERS,
  handler: async (ctx, input): Promise<NoteAttachment[]> => {
    requireHumanUser(ctx.actor);
    const note = await ctx.trx
      .selectFrom('ludy_notes.note')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!note) throw noteNotFound();
    return loadNoteAttachments(ctx, input.noteId);
  },
});

export const noteAttachmentDownloadMeta = defineQuery({
  name: 'notes.attachment.download_meta',
  input: zNoteAttachmentRef,
  access: READERS,
  handler: async (ctx, input): Promise<NoteAttachmentDownloadMeta> => {
    requireHumanUser(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_notes.attachment as a')
      .innerJoin('ludy_notes.note as n', (j) => j.onRef('n.org_id', '=', 'a.org_id').onRef('n.id', '=', 'a.note_id'))
      .select(['a.id', 'a.note_id', 'a.filename', 'a.content_type', 'a.size_bytes', 'a.sha256', 'a.storage_key'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.attachmentId)
      .where('n.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw attachmentNotFound();
    return {
      id: row.id,
      noteId: row.note_id,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      storageKey: row.storage_key,
    };
  },
});

export const attachmentCommands = [noteAttachmentCreate, noteAttachmentDelete];
export const attachmentQueries = [noteAttachmentList, noteAttachmentDownloadMeta];
