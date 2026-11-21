// SPDX-License-Identifier: AGPL-3.0-only
// HTTP edge handlers for 1-step Evernote (.enex) and Todoist (.csv) imports (#3564, docs/plan/notes-v2.md V2-9, ADR-0037):
// bounded upload streaming, strict fail-closed XML/CSV parsing, magic-byte attachment classification, BlobStore writes with
// full rollback on DB error, human-only enforcement (extension tokens refused 403), and zero network egress.
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIME_ZONE,
  ENEX_MAX_FILE_BYTES,
  TODOIST_CSV_MAX_BYTES,
  deriveTodoistListNameFromFilename,
  parseEnexImport,
  zTimeZone,
  type EnexImportNoteInput,
  type EnexImportResult,
  type TodoistImportResult,
} from '@crove/kernel-contract';
import {
  DomainError,
  noteAttachmentKey,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import { throwImportFailure } from '@crove/mod-notes';
import { actorOf, type AuthUser } from './auth.ts';
import {
  classifyNoteAttachment,
  readBoundedStream,
  sanitizeNoteAttachmentFilename,
} from './note-attachments.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

interface ParsedMultipartUpload {
  text: string;
  rawName: string;
  fields: Record<string, string>;
}

async function readBoundedImportStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  try {
    return await readBoundedStream(body, maxBytes);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'TOO_LARGE') {
      throw new DomainError('TOO_LARGE', 413, tooLargeMessage);
    }
    throw error;
  }
}

async function readImportMultipart(
  req: Request,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<ParsedMultipartUpload> {
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null && req.headers.get('transfer-encoding') === null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
      throw new DomainError('TOO_LARGE', 413, tooLargeMessage);
    }
  }

  const contentType = req.headers.get('content-type') ?? '';
  let bytes: Uint8Array;
  let rawName = '';
  const fields: Record<string, string> = {};

  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const rawBody = await readBoundedImportStream(req.body, maxBytes + MULTIPART_OVERHEAD_BYTES, tooLargeMessage);
    const copy = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: new Uint8Array(rawBody),
    });
    const form = await copy.formData().catch(() => {
      throw new DomainError('INVALID', 400, 'Dữ liệu biểu mẫu tải lên không hợp lệ');
    });
    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp để nhập');
    if (files.length > 1) throw new DomainError('TOO_MANY_FILES', 413, 'Mỗi lượt chỉ nhập 1 tệp');
    const file = files[0] as File;
    if (file.size === 0) throw new DomainError('NO_FILE', 400, 'Tệp nhập đang rỗng');
    if (file.size > maxBytes) throw new DomainError('TOO_LARGE', 413, tooLargeMessage);
    bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp nhập đang rỗng');
    if (bytes.byteLength > maxBytes) throw new DomainError('TOO_LARGE', 413, tooLargeMessage);
    rawName = file.name;
    for (const [key, val] of form.entries()) {
      if (typeof val === 'string') fields[key] = val;
    }
  } else {
    bytes = await readBoundedImportStream(req.body, maxBytes, tooLargeMessage);
    if (bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp nhập đang rỗng');
    const url = new URL(req.url);
    rawName = url.searchParams.get('filename') ?? req.headers.get('x-file-name') ?? '';
    for (const [k, v] of url.searchParams.entries()) fields[k] = v;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('NOTE_IMPORT_INVALID', 400, 'Tệp nhập không đúng mã hóa UTF-8 hợp lệ');
  }
  return { text, rawName, fields };
}

function parseBooleanField(val: string | undefined): boolean {
  return val === 'true' || val === '1';
}

function parseOptionalUuidField(val: string | undefined, message: string): string | null {
  const trimmed = (val ?? '').trim();
  if (!trimmed) return null;
  if (!UUID_RE.test(trimmed)) throw new DomainError('INVALID', 400, message);
  return trimmed.toLowerCase();
}

export async function handleEnexImportUpload(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  req: Request;
}): Promise<EnexImportResult> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }

  const { text, fields } = await readImportMultipart(
    deps.req,
    ENEX_MAX_FILE_BYTES,
    'Tệp .enex vượt quá giới hạn 50 MB',
  );
  const targetNotebookId = parseOptionalUuidField(fields['targetNotebookId'], 'Sổ tay đích không hợp lệ');
  const ignoreFileNotebooks = parseBooleanField(fields['ignoreFileNotebooks']);
  const skipDuplicates = parseBooleanField(fields['skipDuplicates']);

  const parsed = parseEnexImport(text);
  if (!parsed.ok) {
    throwImportFailure(parsed);
  }

  interface StagedBlob {
    storageKey: string;
    bytes: Uint8Array;
    contentType: string;
  }
  const stagedBlobs: StagedBlob[] = [];
  const preparedNotes: EnexImportNoteInput[] = [];

  for (const note of parsed.notes) {
    const attachments: EnexImportNoteInput['attachments'] = [];
    for (const res of note.resources) {
      const { contentType, extractStatus } = classifyNoteAttachment(res.bytes, res.filename, res.declaredMime);
      const filename = sanitizeNoteAttachmentFilename(res.filename, contentType);
      const sha256 = sha256Hex(res.bytes);
      const attachmentId = randomUUID();
      const storageKey = noteAttachmentKey(deps.orgId, attachmentId);

      stagedBlobs.push({ storageKey, bytes: res.bytes, contentType });
      attachments.push({
        attachmentId,
        filename,
        contentType,
        sizeBytes: res.bytes.byteLength,
        sha256,
        storageKey,
        extractStatus,
      });
    }
    preparedNotes.push({
      title: note.title,
      body: note.body,
      tags: note.tags,
      notebookName: note.notebookName,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      attachments,
    });
  }

  const uploadedKeys: string[] = [];
  try {
    for (const blob of stagedBlobs) {
      await deps.store.put(blob.storageKey, blob.bytes, blob.contentType);
      uploadedKeys.push(blob.storageKey);
    }

    const result = await deps.runtime.execute<EnexImportResult>(
      'notes.note.import_enex',
      {
        targetNotebookId,
        ignoreFileNotebooks,
        skipDuplicates,
        notes: preparedNotes,
      },
      { actor: actorOf(deps.user), orgId: deps.orgId },
    );

    if (result.unusedStorageKeys.length > 0) {
      await Promise.allSettled(
        result.unusedStorageKeys.map((key) =>
          deps.store.delete(key).catch((err: unknown) => {
            console.error('[notes-import] failed to delete skipped-duplicate blob', err instanceof Error ? err.name : 'error');
          }),
        ),
      );
    }

    return {
      ...result,
      strippedRemoteImages: parsed.strippedRemoteImages,
      unusedStorageKeys: [],
    };
  } catch (error) {
    await Promise.allSettled(
      uploadedKeys.map((key) =>
        deps.store.delete(key).catch((cleanupErr: unknown) => {
          console.error('[notes-import] failed to roll back uploaded blob', cleanupErr instanceof Error ? cleanupErr.name : 'error');
        }),
      ),
    );
    throw error;
  }
}

export async function handleTodoistImportUpload(deps: {
  runtime: Runtime;
  user: AuthUser;
  orgId: string;
  req: Request;
}): Promise<TodoistImportResult> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }

  const { text, rawName, fields } = await readImportMultipart(
    deps.req,
    TODOIST_CSV_MAX_BYTES,
    'Tệp .csv vượt quá giới hạn 5 MB',
  );
  const rawListMode = (fields['targetListId'] ?? '').trim();
  const useInboxWhenNoList = rawListMode === 'inbox' || parseBooleanField(fields['useInboxWhenNoList']);
  const targetListId = useInboxWhenNoList ? null : parseOptionalUuidField(rawListMode, 'Danh sách đích không hợp lệ');
  const skipDuplicates = parseBooleanField(fields['skipDuplicates']);

  const rawTz = (fields['timeZone'] ?? '').trim();
  let timeZone = DEFAULT_TIME_ZONE;
  if (rawTz !== '') {
    const parsedTz = zTimeZone.safeParse(rawTz);
    if (!parsedTz.success) throw new DomainError('INVALID', 400, 'Múi giờ không hợp lệ');
    timeZone = parsedTz.data;
  }

  const defaultListName = deriveTodoistListNameFromFilename(rawName);

  return deps.runtime.execute<TodoistImportResult>(
    'notes.todo.import_todoist',
    {
      csv: text,
      defaultListName,
      targetListId,
      useInboxWhenNoList,
      timeZone,
      skipDuplicates,
    },
    { actor: actorOf(deps.user), orgId: deps.orgId },
  );
}
