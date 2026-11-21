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
  type EnexImportResult,
  type NoteImportFailure,
  type TodoListSection,
  type TodoistImportResult,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT } from './attachments.ts';
import { resolveNotebookForNote } from './notes.ts';
import { detailsOf, due, ownKeys, parseSections, remindAt } from './todos.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

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

    const targetNotebookId = input.targetNotebookId ? input.targetNotebookId.toLowerCase() : null;
    if (targetNotebookId !== null) {
      await resolveNotebookForNote(ctx, targetNotebookId, userId, 'private');
    }

    const existingNotebooks = await ctx.trx
      .selectFrom('crove_notes.notebook')
      .select(['id', 'name', 'sort_key'])
      .where('org_id', '=', ctx.orgId)
      .where('author_user_id', '=', userId)
      .where('visibility', '=', 'private')
      .orderBy('sort_key')
      .orderBy('id')
      .execute();

    const privateNotebookByName = new Map<string, string>();
    for (const nb of existingNotebooks) {
      const key = nb.name.trim().toLowerCase();
      if (!privateNotebookByName.has(key)) privateNotebookByName.set(key, nb.id);
    }

    const existingAllCountRow = await ctx.trx
      .selectFrom('crove_notes.notebook')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('author_user_id', '=', userId)
      .executeTakeFirst();
    let totalOwnedNotebooks = Number(existingAllCountRow?.n ?? 0);

    const { rows: lastNbRows } = await sql<{ last: string | null }>`
      SELECT pg_catalog.max(sort_key) AS last FROM crove_notes.notebook WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
    let lastNotebookSortKey = lastNbRows[0]?.last ?? null;

    const seenNoteKeys = new Set<string>();
    if (input.skipDuplicates) {
      const existingNotes = await ctx.trx
        .selectFrom('crove_notes.note')
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

    const createdNoteIds: string[] = [];
    const createdNotebookIds: string[] = [];
    const reusedNotebookIds = new Set<string>();
    const unusedStorageKeys: string[] = [];
    let attachmentsCount = 0;
    let skippedDuplicates = 0;

    for (const item of input.notes) {
      const titleKey = item.title.trim().toLowerCase();
      const previewNbKey =
        targetNotebookId !== null
          ? targetNotebookId
          : !input.ignoreFileNotebooks && item.notebookName
            ? (privateNotebookByName.get(item.notebookName.trim().toLowerCase()) ?? `new:${item.notebookName.trim().toLowerCase()}`)
            : 'unfiled';
      const noteDupKey = `${previewNbKey}:${titleKey}`;
      if (input.skipDuplicates && seenNoteKeys.has(noteDupKey)) {
        skippedDuplicates += 1;
        for (const att of item.attachments) unusedStorageKeys.push(att.storageKey);
        continue;
      }
      seenNoteKeys.add(noteDupKey);

      let noteNotebookId: string | null = targetNotebookId;
      if (noteNotebookId === null && !input.ignoreFileNotebooks && item.notebookName) {
        const nbKey = item.notebookName.trim().toLowerCase();
        const matched = privateNotebookByName.get(nbKey);
        if (matched) {
          noteNotebookId = matched;
          reusedNotebookIds.add(matched);
        } else {
          if (totalOwnedNotebooks >= NOTEBOOKS_MAX) {
            throw new DomainError('NOTEBOOK_LIMIT_REACHED', 422, `Đã đạt giới hạn ${NOTEBOOKS_MAX} sổ tay; hãy xóa bớt sổ tay không còn dùng`);
          }
          let nextSortKey = keyBetween(lastNotebookSortKey, null);
          if (nextSortKey.length > REBALANCE_AT) {
            const ownNbs = await ctx.trx
              .selectFrom('crove_notes.notebook')
              .select('id')
              .where('org_id', '=', ctx.orgId)
              .where('author_user_id', '=', userId)
              .orderBy('sort_key')
              .orderBy('id')
              .execute();
            const fresh = spreadKeys(ownNbs.length + 1);
            for (let i = 0; i < ownNbs.length; i += 1) {
              await ctx.trx
                .updateTable('crove_notes.notebook')
                .set({ sort_key: fresh[i] as string })
                .where('org_id', '=', ctx.orgId)
                .where('id', '=', ownNbs[i]!.id)
                .execute();
            }
            nextSortKey = fresh[ownNbs.length] as string;
          }
          const nbRow = await ctx.trx
            .insertInto('crove_notes.notebook')
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
          createdNotebookIds.push(nbRow.id);
          noteNotebookId = nbRow.id;
        }
      }

      const createdAt = parseSanitizedTimestamp(item.createdAt, ctx.now, ctx.now);
      const rawUpdated = parseSanitizedTimestamp(item.updatedAt, createdAt, ctx.now);
      const updatedAt = rawUpdated.getTime() < createdAt.getTime() ? createdAt : rawUpdated;

      const noteRow = await ctx.trx
        .insertInto('crove_notes.note')
        .values({
          org_id: ctx.orgId,
          author_user_id: userId,
          notebook_id: noteNotebookId,
          visibility: 'private',
          title: item.title,
          body: item.body,
          tags: item.tags,
          tainted: true,
          created_at: createdAt,
          updated_at: updatedAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      createdNoteIds.push(noteRow.id);

      for (const att of item.attachments) {
        const expectedKey = `notes/${ctx.orgId}/${att.attachmentId}`;
        if (att.storageKey !== expectedKey) {
          throw new DomainError('INVALID', 400, 'Khóa lưu trữ tệp đính kèm không hợp lệ');
        }
        await ctx.trx
          .insertInto('crove_notes.attachment')
          .values({
            org_id: ctx.orgId,
            id: att.attachmentId,
            note_id: noteRow.id,
            author_user_id: userId,
            filename: att.filename,
            content_type: att.contentType,
            size_bytes: att.sizeBytes,
            sha256: att.sha256,
            storage_key: expectedKey,
            extracted_text: null,
            extract_status: att.extractStatus,
            created_at: ctx.now,
          })
          .execute();
        if (att.extractStatus === 'pending') {
          await ctx.emit(NOTE_ATTACHMENT_EXTRACT_QUEUED_EVENT, { attachmentId: att.attachmentId });
        }
        attachmentsCount += 1;
      }
    }

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

    const existingLists = await ctx.trx
      .selectFrom('crove_notes.todo_list')
      .select(['id', 'name', 'sections', 'sort_key', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('sort_key')
      .orderBy('id')
      .forUpdate()
      .execute();

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

    const seenTodoKeys = new Set<string>();
    if (input.skipDuplicates) {
      const existingTodos = await ctx.trx
        .selectFrom('crove_notes.todo')
        .select(['list_id', 'title'])
        .where('org_id', '=', ctx.orgId)
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .execute();
      for (const t of existingTodos) {
        seenTodoKeys.add(`${t.list_id ?? 'inbox'}:${t.title.trim().toLowerCase()}`);
      }
    }

    let ownSortRows = await ownKeys(ctx, null);
    let lastTodoSortKey = ownSortRows.at(-1)?.sort_key ?? null;

    const createdListIds: string[] = [];
    const updatedListIds = new Set<string>();
    const createdTodoIds: string[] = [];
    let createdSections = 0;
    let checklistSteps = 0;
    let skippedDuplicates = 0;

    for (const parsedList of parsed.lists) {
      let resolvedListId: string | null = null;
      const sectionIdByName = new Map<string, string>();

      const useTarget = targetListRow !== undefined && !parsedList.fromExplicitList;
      if (useTarget && targetListRow) {
        resolvedListId = targetListRow.id;
        const currentSections = parseSections(targetListRow.sections);
        let nextSections = [...currentSections];
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
            .updateTable('crove_notes.todo_list')
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
              .updateTable('crove_notes.todo_list')
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
              .selectFrom('crove_notes.todo_list')
              .select('id')
              .where('org_id', '=', ctx.orgId)
              .where('owner_user_id', '=', userId)
              .where('deleted_at', 'is', null)
              .orderBy('sort_key')
              .orderBy('id')
              .execute();
            const fresh = spreadKeys(currentActive.length + 1);
            for (let i = 0; i < currentActive.length; i += 1) {
              await ctx.trx
                .updateTable('crove_notes.todo_list')
                .set({ sort_key: fresh[i] as string })
                .where('org_id', '=', ctx.orgId)
                .where('owner_user_id', '=', userId)
                .where('id', '=', currentActive[i]!.id)
                .execute();
            }
            sortKey = fresh[currentActive.length] as string;
          }
          const newSections: TodoListSection[] = parsedList.sections.map((secName) => {
            const id = `sec_${randomUUID().slice(0, 8)}`;
            sectionIdByName.set(secName.trim().toLowerCase(), id);
            return { id, name: secName };
          });
          const inserted = await ctx.trx
            .insertInto('crove_notes.todo_list')
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
        const dupKey = `${resolvedListId ?? 'inbox'}:${task.title.trim().toLowerCase()}`;
        if (input.skipDuplicates && seenTodoKeys.has(dupKey)) {
          skippedDuplicates += 1;
          continue;
        }
        seenTodoKeys.add(dupKey);

        let sortKey = keyBetween(lastTodoSortKey, null);
        if (sortKey.length > REBALANCE_AT) {
          const fresh = spreadKeys(ownSortRows.length + 1);
          if (ownSortRows.length > 0) {
            const ids = ownSortRows.map((r) => r.id);
            const keys = fresh.slice(0, ownSortRows.length);
            await sql`UPDATE crove_notes.todo AS t SET sort_key = v.key
              FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
              WHERE t.org_id = ${ctx.orgId}::uuid AND t.id = v.id`.execute(ctx.trx);
            for (let i = 0; i < ownSortRows.length; i += 1) {
              ownSortRows[i]!.sort_key = keys[i] as string;
            }
          }
          sortKey = fresh[ownSortRows.length] as string;
        }

        const sectionId = task.sectionName ? (sectionIdByName.get(task.sectionName.trim().toLowerCase()) ?? null) : null;
        const when = due({ dueOn: task.dueOn, dueTime: task.dueTime, timeZone: task.timeZone });
        const remind = remindAt('auto', when, ctx.now);
        const insertedTodo = await ctx.trx
          .insertInto('crove_notes.todo')
          .values({
            org_id: ctx.orgId,
            owner_user_id: userId,
            title: task.title,
            details: detailsOf(task.details),
            checklist: JSON.stringify(task.checklist),
            priority: task.priority,
            tags: task.tags,
            list_id: resolvedListId,
            section_id: sectionId,
            ...when,
            remind_at: remind.at,
            reminded_at: remind.passed ? ctx.now : null,
            sort_key: sortKey,
            source_note_id: null,
            recurrence: null,
            tainted: true,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        lastTodoSortKey = sortKey;
        ownSortRows.push({ id: insertedTodo.id, sort_key: sortKey });
        createdTodoIds.push(insertedTodo.id);
        checklistSteps += task.checklist.length;
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
