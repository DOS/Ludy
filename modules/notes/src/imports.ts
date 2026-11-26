// SPDX-License-Identifier: AGPL-3.0-only
// 1-step Evernote (.enex) and Todoist (.csv) importers (#3564, docs/plan/notes-v2.md V2-9 / E5a, ADR-0037).
// All imported notes default to visibility: 'private' and tainted: true. Personal to-do lists, sections,
// checklist steps, tags, due dates, and inverted Todoist priorities (4->P1..1->P4) stay strictly owner-only.
// Audit rows record only ids and aggregate counts, never imported titles, bodies, tags, filenames, or names.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  NOTE_ATTACHMENTS_PER_NOTE_MAX,
  NOTEBOOKS_MAX,
  REBALANCE_AT,
  TODO_LISTS_MAX,
  TODO_LIST_SECTIONS_MAX,
  keyBetween,
  parseTodoistCsv,
  spreadKeys,
  zEnexImportCommand,
  zTodoistImportCommand,
  type EnexImportNoteInput,
  type EnexImportResult,
  type NoteImportFailure,
  type ParsedTodoistTask,
  type TodoListSection,
  type TodoistImportResult,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, type CommandContext } from '@ludy/kernel-runtime';
import { NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT } from './attachments.ts';
import { lockNotebookReorder, resolveNotebookForNote } from './notes.ts';
import { detailsOf, due, lockTodoListOrder, lockTodoSortOrder, lockTodosInOrder, ownKeys, parseSections, remindAt } from './todos.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const INSERT_BATCH_SIZE = 200;

function requireHumanUser(actor: CommandContext['actor']): string {
  if (actor.type !== 'user' || actor.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ phiên đăng nhập người dùng mới thực hiện được việc này');
  }
  return actor.userId;
}

export function throwImportFailure(failure: NoteImportFailure): never {
  switch (failure.code) {
    case 'NOTE_IMPORT_UNSAFE_XML':
      throw new DomainError('NOTE_IMPORT_UNSAFE_XML', failure.status, 'Tệp .enex chứa DOCTYPE/ENTITY hoặc cấu trúc XML không an toàn nên đã bị từ chối');
    case 'NOTE_IMPORT_EMPTY':
      throw new DomainError('NOTE_IMPORT_EMPTY', failure.status, 'Tệp nhập không có dữ liệu hợp lệ nào để thêm');
    case 'TOO_LARGE':
      throw new DomainError('TOO_LARGE', failure.status, 'Tệp hoặc nội dung nhập vượt quá giới hạn kích thước cho phép');
    case 'NOTE_TOO_LONG':
      throw new DomainError('NOTE_TOO_LONG', failure.status, 'Nội dung ghi chú sau khi chuyển đổi vượt quá giới hạn 100.000 ký tự');
    case 'NOTE_ATTACHMENT_LIMIT':
      throw new DomainError('NOTE_ATTACHMENT_LIMIT', failure.status, `Mỗi ghi chú đính kèm tối đa ${NOTE_ATTACHMENTS_PER_NOTE_MAX} tệp`);
    case 'NOTE_IMPORT_INVALID':
      throw new DomainError('NOTE_IMPORT_INVALID', failure.status, 'Định dạng tệp nhập không hợp lệ; hãy kiểm tra lại tệp .enex hoặc .csv');
  }
}

function parseSanitizedTimestamp(iso: string | null | undefined, fallback: Date, upperBound: Date): Date {
  if (!iso) return fallback;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return fallback;
  const minMs = Date.UTC(1970, 0, 1);
  const maxMs = upperBound.getTime() + 86_400_000;
  if (ms < minMs || ms > maxMs) return fallback;
  return new Date(ms);
}

export const noteImportEnex = defineCommand({
  name: 'notes.note.import_enex',
  input: zEnexImportCommand,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<EnexImportResult> => {
    const userId = requireHumanUser(ctx.actor);

    if (input.skipDuplicates) {
      // Serialize duplicate checks per user before acquiring any org-wide notebook lock.
      const enexLockKey = `notes.note.import_enex:${ctx.orgId.toLowerCase()}:${userId.toLowerCase()}`;
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${enexLockKey}, 0))`.execute(ctx.trx);
    }

    const targetNotebookId = input.targetNotebookId ? input.targetNotebookId.toLowerCase() : null;
    if (targetNotebookId !== null) {
      await resolveNotebookForNote(ctx, targetNotebookId, userId, 'private');
    }

    const neededFileNotebookNames = new Set<string>();
    if (targetNotebookId === null && !input.ignoreFileNotebooks) {
      for (const item of input.notes) {
        if (item.notebookName) neededFileNotebookNames.add(item.notebookName.trim().toLowerCase());
      }
    }

    const privateNotebookByName = new Map<string, string>();
    let totalOwnedNotebooks = 0;
    let lastNotebookSortKey: string | null = null;
    if (neededFileNotebookNames.size > 0) {
      const loadPrivateNotebooks = async () => {
        privateNotebookByName.clear();
        const existingNotebooks = await ctx.trx
          .selectFrom('ludy_notes.notebook')
          .select(['id', 'name', 'sort_key'])
          .where('org_id', '=', ctx.orgId)
          .where('author_user_id', '=', userId)
          .where('visibility', '=', 'private')
          .orderBy('sort_key')
          .orderBy('id')
          .execute();
        for (const nb of existingNotebooks) {
          const key = nb.name.trim().toLowerCase();
          if (!privateNotebookByName.has(key)) privateNotebookByName.set(key, nb.id);
        }
      };

      await loadPrivateNotebooks();
      const missingAnyFileNotebook = [...neededFileNotebookNames].some((key) => !privateNotebookByName.has(key));
      if (missingAnyFileNotebook) {
        // Only hold the org-wide notebook reorder lock when at least one file notebook is missing and must be created.
        await lockNotebookReorder(ctx);
        await loadPrivateNotebooks();

        const existingAllCountRow = await ctx.trx
          .selectFrom('ludy_notes.notebook')
          .select(({ fn }) => fn.countAll<string>().as('n'))
          .where('org_id', '=', ctx.orgId)
          .where('author_user_id', '=', userId)
          .executeTakeFirst();
        totalOwnedNotebooks = Number(existingAllCountRow?.n ?? 0);

        const { rows: lastNbRows } = await sql<{ last: string | null }>`
          SELECT pg_catalog.max(sort_key) AS last FROM ludy_notes.notebook WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
        lastNotebookSortKey = lastNbRows[0]?.last ?? null;
      }
    }

    const seenNoteKeys = new Set<string>();
    if (input.skipDuplicates) {
      const existingNotes = await ctx.trx
        .selectFrom('ludy_notes.note')
        .select(['notebook_id', 'title'])
        .where('org_id', '=', ctx.orgId)
        .where('author_user_id', '=', userId)
        .where('visibility', '=', 'private')
        .where('deleted_at', 'is', null)
        .execute();
      for (const n of existingNotes) {
        seenNoteKeys.add(`${n.notebook_id ?? 'unfiled'}:${n.title.trim().toLowerCase()}`);
      }
    }

    for (const item of input.notes) {
      for (const att of item.attachments) {
        if (att.storageKey !== `notes/${ctx.orgId}/${att.attachmentId}`) {
          throw new DomainError('INVALID', 400, 'Khóa lưu trữ tệp đính kèm không hợp lệ');
        }
      }
    }

    const createdNoteIds: string[] = [];
    const createdNotebookIds: string[] = [];
    const createdNotebookIdSet = new Set<string>();
    const reusedNotebookIds = new Set<string>();
    const unusedStorageKeys: string[] = [];
    const pendingNotes: Array<{
      item: EnexImportNoteInput;
      notebookId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }> = [];
    let skippedDuplicates = 0;

    for (const item of input.notes) {
      const titleKey = item.title.trim().toLowerCase();
      let noteNotebookId: string | null = targetNotebookId;
      if (noteNotebookId === null && !input.ignoreFileNotebooks && item.notebookName) {
        noteNotebookId = privateNotebookByName.get(item.notebookName.trim().toLowerCase()) ?? null;
      }

      if (noteNotebookId !== null || input.ignoreFileNotebooks || !item.notebookName) {
        const noteDupKey = `${noteNotebookId ?? 'unfiled'}:${titleKey}`;
        if (input.skipDuplicates && seenNoteKeys.has(noteDupKey)) {
          skippedDuplicates += 1;
          for (const att of item.attachments) {
            unusedStorageKeys.push(att.storageKey);
          }
          continue;
        }
        seenNoteKeys.add(noteDupKey);
        if (noteNotebookId !== null && !createdNotebookIdSet.has(noteNotebookId)) {
          reusedNotebookIds.add(noteNotebookId);
        }
      } else {
        const nbKey = item.notebookName.trim().toLowerCase();
        if (totalOwnedNotebooks >= NOTEBOOKS_MAX) {
          throw new DomainError('NOTEBOOK_LIMIT_REACHED', 422, `Đã đạt giới hạn ${NOTEBOOKS_MAX} sổ tay; hãy xóa bớt sổ tay không còn dùng`);
        }
        let nextSortKey = keyBetween(lastNotebookSortKey, null);
        if (nextSortKey.length > REBALANCE_AT) {
          const ownNbs = await ctx.trx
            .selectFrom('ludy_notes.notebook')
            .select(['id', 'sort_key'])
            .where('org_id', '=', ctx.orgId)
            .where('author_user_id', '=', userId)
            .orderBy('id')
            .forUpdate()
            .execute();
          ownNbs.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id.localeCompare(b.id)));
          const fresh = spreadKeys(ownNbs.length + 1);
          if (ownNbs.length > 0) {
            const ids = ownNbs.map((r) => r.id);
            const keys = fresh.slice(0, ids.length);
            await sql`UPDATE ludy_notes.notebook AS n SET sort_key = v.key
              FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
              WHERE n.org_id = ${ctx.orgId}::uuid AND n.id = v.id`.execute(ctx.trx);
          }
          nextSortKey = fresh[ownNbs.length] as string;
        }
        const nbRow = await ctx.trx
          .insertInto('ludy_notes.notebook')
          .values({
            org_id: ctx.orgId,
            author_user_id: userId,
            visibility: 'private',
            name: item.notebookName,
            stack_name: null,
            pinned: false,
            sort_key: nextSortKey,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        lastNotebookSortKey = nextSortKey;
        totalOwnedNotebooks += 1;
        privateNotebookByName.set(nbKey, nbRow.id);
        createdNotebookIdSet.add(nbRow.id);
        createdNotebookIds.push(nbRow.id);
        noteNotebookId = nbRow.id;
        seenNoteKeys.add(`${noteNotebookId}:${titleKey}`);
      }

      const createdAt = parseSanitizedTimestamp(item.createdAt, ctx.now, ctx.now);
      const rawUpdated = parseSanitizedTimestamp(item.updatedAt, createdAt, ctx.now);
      const updatedAt = rawUpdated.getTime() < createdAt.getTime() ? createdAt : rawUpdated;
      pendingNotes.push({
        item,
        notebookId: noteNotebookId,
        createdAt,
        updatedAt,
      });
    }

    const pendingAttachments: Array<{
      org_id: string;
      id: string;
      note_id: string;
      author_user_id: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      sha256: string;
      storage_key: string;
      extracted_text: null;
      extract_status: 'pending' | 'skipped';
      created_at: Date;
    }> = [];

    for (let offset = 0; offset < pendingNotes.length; offset += INSERT_BATCH_SIZE) {
      const chunk = pendingNotes.slice(offset, offset + INSERT_BATCH_SIZE);
      const insertedNotes = await ctx.trx
        .insertInto('ludy_notes.note')
        .values(
          chunk.map((entry) => ({
            org_id: ctx.orgId,
            author_user_id: userId,
            notebook_id: entry.notebookId,
            visibility: 'private' as const,
            title: entry.item.title,
            body: entry.item.body,
            tags: entry.item.tags,
            tainted: true,
            created_at: entry.createdAt,
            updated_at: entry.updatedAt,
          })),
        )
        .returning('id')
        .execute();
      if (insertedNotes.length !== chunk.length) {
        throw new Error('note batch insert count mismatch');
      }
      createdNoteIds.push(...insertedNotes.map((row) => row.id));
      insertedNotes.forEach((row, i) => {
        for (const att of chunk[i]!.item.attachments) {
          pendingAttachments.push({
            org_id: ctx.orgId,
            id: att.attachmentId,
            note_id: row.id,
            author_user_id: userId,
            filename: att.filename,
            content_type: att.contentType,
            size_bytes: att.sizeBytes,
            sha256: att.sha256,
            storage_key: att.storageKey,
            extracted_text: null,
            extract_status: att.extractStatus,
            created_at: ctx.now,
          });
        }
      });
    }

    for (let offset = 0; offset < pendingAttachments.length; offset += INSERT_BATCH_SIZE) {
      const chunk = pendingAttachments.slice(offset, offset + INSERT_BATCH_SIZE);
      await ctx.trx.insertInto('ludy_notes.attachment').values(chunk).execute();
    }
    for (const att of pendingAttachments) {
      if (att.extract_status === 'pending') {
        await ctx.emit(NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT, { attachmentId: att.id });
      }
    }
    const attachmentsCount = pendingAttachments.length;

    ctx.audit({
      importedNotes: createdNoteIds.length,
      createdNotebooks: createdNotebookIds.length,
      reusedNotebooks: reusedNotebookIds.size,
      attachmentsCount,
      skippedDuplicates,
      visibility: 'private',
      tainted: true,
      noteIds: createdNoteIds,
    });

    return {
      importedNotes: createdNoteIds.length,
      createdNotebooks: createdNotebookIds.length,
      reusedNotebooks: reusedNotebookIds.size,
      attachmentsCount,
      skippedDuplicates,
      noteIds: createdNoteIds,
      notebookIds: [...createdNotebookIds, ...reusedNotebookIds],
      unusedStorageKeys,
    };
  },
});

export const todoImportTodoist = defineCommand({
  name: 'notes.todo.import_todoist',
  input: zTodoistImportCommand,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<TodoistImportResult> => {
    const userId = requireHumanUser(ctx.actor);

    const parsed = parseTodoistCsv(input.csv, {
      defaultListName: input.defaultListName ?? null,
      fallbackTimeZone: input.timeZone,
      useInboxWhenNoList: input.useInboxWhenNoList,
      fallbackYear: ctx.now.getUTCFullYear(),
    });
    if (!parsed.ok) {
      throwImportFailure(parsed);
    }

    await lockTodoListOrder(ctx, userId);

    const existingLists = await ctx.trx
      .selectFrom('ludy_notes.todo_list')
      .select(['id', 'name', 'sections', 'sort_key', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    existingLists.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id.localeCompare(b.id)));

    const targetListId = input.targetListId ? input.targetListId.toLowerCase() : null;
    const targetListRow = targetListId !== null ? existingLists.find((l) => l.id === targetListId) : undefined;
    if (targetListId !== null && !targetListRow) {
      throw new DomainError('TODO_LIST_NOT_FOUND', 404, 'Không tìm thấy danh sách này');
    }

    const listByName = new Map<string, { id: string; name: string; sections: TodoListSection[]; revision: number }>();
    let totalActiveLists = existingLists.length;
    let lastListSortKey = existingLists.at(-1)?.sort_key ?? null;

    for (const l of existingLists) {
      const parsedSections = parseSections(l.sections);
      const entry = { id: l.id, name: l.name, sections: parsedSections, revision: l.revision };
      const key = l.name.trim().toLowerCase();
      if (!listByName.has(key)) listByName.set(key, entry);
    }

    const createdListIds: string[] = [];
    const updatedListIds = new Set<string>();
    const createdTodoIds: string[] = [];
    const pendingTodoCandidates: Array<{
      task: ParsedTodoistTask;
      listId: string | null;
      sectionId: string | null;
    }> = [];
    let createdSections = 0;
    let checklistSteps = 0;

    for (const parsedList of parsed.lists) {
      let resolvedListId: string | null = null;
      const sectionIdByName = new Map<string, string>();

      const useTarget = targetListRow !== undefined && !parsedList.fromExplicitList;
      if (useTarget && targetListRow) {
        resolvedListId = targetListRow.id;
        const currentSections = parseSections(targetListRow.sections);
        const nextSections = [...currentSections];
        let added = 0;
        for (const secName of parsedList.sections) {
          const existingSec = nextSections.find((s) => s.name.trim().toLowerCase() === secName.trim().toLowerCase());
          if (existingSec) {
            sectionIdByName.set(secName.trim().toLowerCase(), existingSec.id);
          } else {
            if (nextSections.length >= TODO_LIST_SECTIONS_MAX) {
              throw new DomainError('INVALID', 422, `Danh sách tối đa ${TODO_LIST_SECTIONS_MAX} mục con`);
            }
            const id = `sec_${randomUUID().slice(0, 8)}`;
            nextSections.push({ id, name: secName });
            sectionIdByName.set(secName.trim().toLowerCase(), id);
            added += 1;
          }
        }
        if (added > 0) {
          await ctx.trx
            .updateTable('ludy_notes.todo_list')
            .set({ sections: JSON.stringify(nextSections), revision: targetListRow.revision + 1, updated_at: ctx.now })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', targetListRow.id)
            .execute();
          targetListRow.sections = nextSections;
          targetListRow.revision += 1;
          createdSections += added;
          updatedListIds.add(targetListRow.id);
        } else {
          for (const sec of currentSections) sectionIdByName.set(sec.name.trim().toLowerCase(), sec.id);
        }
      } else if (parsedList.name !== null) {
        const key = parsedList.name.trim().toLowerCase();
        const existing = listByName.get(key);
        if (existing) {
          resolvedListId = existing.id;
          let added = 0;
          for (const secName of parsedList.sections) {
            const matchedSec = existing.sections.find((s) => s.name.trim().toLowerCase() === secName.trim().toLowerCase());
            if (matchedSec) {
              sectionIdByName.set(secName.trim().toLowerCase(), matchedSec.id);
            } else {
              if (existing.sections.length >= TODO_LIST_SECTIONS_MAX) {
                throw new DomainError('INVALID', 422, `Danh sách tối đa ${TODO_LIST_SECTIONS_MAX} mục con`);
              }
              const id = `sec_${randomUUID().slice(0, 8)}`;
              existing.sections.push({ id, name: secName });
              sectionIdByName.set(secName.trim().toLowerCase(), id);
              added += 1;
            }
          }
          if (added > 0) {
            await ctx.trx
              .updateTable('ludy_notes.todo_list')
              .set({ sections: JSON.stringify(existing.sections), revision: existing.revision + 1, updated_at: ctx.now })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', existing.id)
              .execute();
            existing.revision += 1;
            createdSections += added;
            updatedListIds.add(existing.id);
          } else {
            for (const sec of existing.sections) sectionIdByName.set(sec.name.trim().toLowerCase(), sec.id);
          }
        } else {
          if (totalActiveLists >= TODO_LISTS_MAX) {
            throw new DomainError('TODO_LIST_LIMIT_REACHED', 422, 'Bạn đã tạo tối đa số danh sách cá nhân');
          }
          let sortKey = keyBetween(lastListSortKey, null);
          if (sortKey.length > REBALANCE_AT) {
            const currentActive = await ctx.trx
              .selectFrom('ludy_notes.todo_list')
              .select(['id', 'sort_key'])
              .where('org_id', '=', ctx.orgId)
              .where('owner_user_id', '=', userId)
              .where('deleted_at', 'is', null)
              .orderBy('id')
              .forUpdate()
              .execute();
            currentActive.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id.localeCompare(b.id)));
            const fresh = spreadKeys(currentActive.length + 1);
            if (currentActive.length > 0) {
              const ids = currentActive.map((r) => r.id);
              const keys = fresh.slice(0, ids.length);
              await sql`UPDATE ludy_notes.todo_list AS l SET sort_key = v.key
                FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
                WHERE l.org_id = ${ctx.orgId}::uuid AND l.owner_user_id = ${userId}::uuid AND l.id = v.id`.execute(ctx.trx);
            }
            sortKey = fresh[currentActive.length] as string;
          }
          const newSections: TodoListSection[] = parsedList.sections.map((secName) => {
            const id = `sec_${randomUUID().slice(0, 8)}`;
            sectionIdByName.set(secName.trim().toLowerCase(), id);
            return { id, name: secName };
          });
          const inserted = await ctx.trx
            .insertInto('ludy_notes.todo_list')
            .values({
              org_id: ctx.orgId,
              owner_user_id: userId,
              name: parsedList.name,
              color: null,
              sections: JSON.stringify(newSections),
              sort_key: sortKey,
              created_at: ctx.now,
              updated_at: ctx.now,
            })
            .returning(['id', 'revision'])
            .executeTakeFirstOrThrow();
          lastListSortKey = sortKey;
          totalActiveLists += 1;
          createdSections += newSections.length;
          createdListIds.push(inserted.id);
          resolvedListId = inserted.id;
          listByName.set(key, { id: inserted.id, name: parsedList.name, sections: newSections, revision: inserted.revision });
        }
      }

      for (const task of parsedList.tasks) {
        const sectionId = task.sectionName ? (sectionIdByName.get(task.sectionName.trim().toLowerCase()) ?? null) : null;
        pendingTodoCandidates.push({ task, listId: resolvedListId, sectionId });
      }
    }

    const pendingTodos: Array<{
      task: ParsedTodoistTask;
      listId: string | null;
      sectionId: string | null;
    }> = [];
    let skippedDuplicates = 0;

    if (pendingTodoCandidates.length > 0) {
      // Lock per-(org, user) todo sort_key order strictly after todo_list updates finish so concurrent
      // todoCreate/todoComplete/todoQuickCapture/imports share the same lock DAG and never read stale keys.
      await lockTodoSortOrder(ctx, userId);

      const seenTodoKeys = new Set<string>();
      if (input.skipDuplicates) {
        const existingTodos = await ctx.trx
          .selectFrom('ludy_notes.todo')
          .select(['list_id', 'title'])
          .where('org_id', '=', ctx.orgId)
          .where('owner_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        for (const t of existingTodos) {
          seenTodoKeys.add(`${t.list_id ?? 'inbox'}:${t.title.trim().toLowerCase()}`);
        }
      }

      for (const candidate of pendingTodoCandidates) {
        const dupKey = `${candidate.listId ?? 'inbox'}:${candidate.task.title.trim().toLowerCase()}`;
        if (input.skipDuplicates && seenTodoKeys.has(dupKey)) {
          skippedDuplicates += 1;
          continue;
        }
        seenTodoKeys.add(dupKey);
        pendingTodos.push(candidate);
      }
    }

    if (pendingTodos.length > 0) {
      const ownSortRows = await ownKeys(ctx, null);
      let lastTodoSortKey = ownSortRows.at(-1)?.sort_key ?? null;
      const pendingSortKeys: string[] = [];
      for (let i = 0; i < pendingTodos.length; i += 1) {
        const nextKey = keyBetween(lastTodoSortKey, null);
        if (nextKey.length > REBALANCE_AT) {
          const fresh = spreadKeys(ownSortRows.length + pendingTodos.length);
          if (ownSortRows.length > 0) {
            const ids = ownSortRows.map((r) => r.id);
            const keys = fresh.slice(0, ownSortRows.length);
            await lockTodosInOrder(ctx, ids);
            await sql`UPDATE ludy_notes.todo AS t SET sort_key = v.key
              FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
              WHERE t.org_id = ${ctx.orgId}::uuid AND t.id = v.id`.execute(ctx.trx);
          }
          pendingSortKeys.length = 0;
          for (let j = 0; j < pendingTodos.length; j += 1) {
            pendingSortKeys.push(fresh[ownSortRows.length + j] as string);
          }
          break;
        }
        pendingSortKeys.push(nextKey);
        lastTodoSortKey = nextKey;
      }

      for (let offset = 0; offset < pendingTodos.length; offset += INSERT_BATCH_SIZE) {
        const chunk = pendingTodos.slice(offset, offset + INSERT_BATCH_SIZE);
        const insertedTodos = await ctx.trx
          .insertInto('ludy_notes.todo')
          .values(
            chunk.map((entry, idx) => {
              const when = due({ dueOn: entry.task.dueOn, dueTime: entry.task.dueTime, timeZone: entry.task.timeZone });
              const remind = remindAt('auto', when, ctx.now);
              return {
                org_id: ctx.orgId,
                owner_user_id: userId,
                title: entry.task.title,
                details: detailsOf(entry.task.details),
                checklist: JSON.stringify(entry.task.checklist),
                priority: entry.task.priority,
                tags: entry.task.tags,
                list_id: entry.listId,
                section_id: entry.sectionId,
                ...when,
                remind_at: remind.at,
                reminded_at: remind.passed ? ctx.now : null,
                sort_key: pendingSortKeys[offset + idx] as string,
                source_note_id: null,
                recurrence: null,
                tainted: true,
                created_at: ctx.now,
                updated_at: ctx.now,
              };
            }),
          )
          .returning('id')
          .execute();
        if (insertedTodos.length !== chunk.length) {
          throw new Error('todo batch insert count mismatch');
        }
        createdTodoIds.push(...insertedTodos.map((row) => row.id));
        for (const entry of chunk) {
          checklistSteps += entry.task.checklist.length;
        }
      }
    }

    ctx.audit({
      importedTodos: createdTodoIds.length,
      createdLists: createdListIds.length,
      updatedLists: updatedListIds.size,
      createdSections,
      checklistSteps,
      skippedDuplicates,
      skippedRows: parsed.skippedRows,
      tainted: true,
      todoIds: createdTodoIds,
      listIds: [...createdListIds, ...updatedListIds],
    });

    return {
      importedTodos: createdTodoIds.length,
      createdLists: createdListIds.length,
      updatedLists: updatedListIds.size,
      createdSections,
      checklistSteps,
      skippedDuplicates,
      skippedRows: parsed.skippedRows,
      todoIds: createdTodoIds,
      listIds: [...createdListIds, ...updatedListIds],
    };
  },
});

export const importCommands = [noteImportEnex, todoImportTodoist];
