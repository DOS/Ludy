// SPDX-License-Identifier: AGPL-3.0-only
// HTTP edge helpers for isolated note attachments (#3561, docs/plan/notes-v2.md V2-5, owner decision A3, ADR-0037):
// streaming <= 25 MiB byte cap, magic-byte MIME classification, active-content disposition gating, strict sandbox CSP,
// and BlobStore put/rollback without ever touching crove_kernel.file.
import { randomUUID } from 'node:crypto';
import {
  NOTE_ATTACHMENT_FILENAME_MAX,
  NOTE_ATTACHMENT_INLINE_TYPES,
  NOTE_ATTACHMENT_MAX_BYTES,
  type NoteAttachment,
  type NoteAttachmentCreated,
} from '@crove/kernel-contract';
import type { NoteAttachmentDownloadMeta } from '@crove/mod-notes';
import {
  BlobNotFoundError,
  DomainError,
  noteAttachmentKey,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import { actorOf, type AuthUser } from './auth.ts';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_NOTE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const NOTE_ATTACHMENT_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'none'; script-src 'none'";

const INLINE_SAFE_SET: ReadonlySet<string> = new Set<string>(NOTE_ATTACHMENT_INLINE_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInlineSafeNoteAttachmentType(contentType: string): boolean {
  return INLINE_SAFE_SET.has(contentType.trim().toLowerCase());
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function containsAscii(bytes: Uint8Array, needle: string, maxScan = bytes.byteLength): boolean {
  const end = Math.min(bytes.byteLength, maxScan) - needle.length;
  if (end < 0) return false;
  const first = needle.charCodeAt(0);
  for (let i = 0; i <= end; i++) {
    if (bytes[i] !== first) continue;
    let match = true;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function looksLikeMp3(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return true;
  if (bytes.byteLength < 4) return false;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleIdx = (b2 >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrateIdx !== 0 && bitrateIdx !== 0x0f && sampleIdx !== 3;
}

function looksLikeMp4Audio(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return false;
  if (bytes.byteLength < 12) return false;
  const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  return brand === 'M4A ' || brand === 'M4B ' || brand === 'mp42' || brand === 'isom' || brand === 'iso2' || brand === 'dash';
}

function looksLikePlainUtf8(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024));
  if (sample.includes(0)) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return null;
  }
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
    if (c === 0x7f) return null;
  }
  return decoded;
}

function lowerExtension(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return '';
  const ext = trimmed.slice(dot + 1).toLowerCase();
  return ext.length <= 10 ? ext : '';
}

export interface ClassifiedNoteAttachment {
  contentType: string;
  extractStatus: 'pending' | 'skipped';
}

export function classifyNoteAttachment(
  bytes: Uint8Array,
  filename: string,
  declaredType: string | null | undefined,
): ClassifiedNoteAttachment {
  const ext = lowerExtension(filename);
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { contentType: 'application/pdf', extractStatus: 'pending' };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { contentType: 'image/gif', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
    return { contentType: 'audio/wav', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { contentType: 'audio/ogg', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { contentType: 'audio/webm', extractStatus: 'skipped' };
  }
  if (looksLikeMp4Audio(bytes) && (ext === 'm4a' || ext === 'mp4' || declared.startsWith('audio/'))) {
    return { contentType: 'audio/mp4', extractStatus: 'skipped' };
  }
  if (looksLikeMp3(bytes)) {
    return { contentType: 'audio/mpeg', extractStatus: 'skipped' };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (containsAscii(bytes, 'word/document.xml')) {
      return { contentType: DOCX_CONTENT_TYPE, extractStatus: 'pending' };
    }
    if (ext === 'xlsx' || containsAscii(bytes, 'xl/workbook.xml')) {
      return { contentType: XLSX_NOTE_CONTENT_TYPE, extractStatus: 'skipped' };
    }
    return { contentType: 'application/zip', extractStatus: 'skipped' };
  }

  const textHead = looksLikePlainUtf8(bytes);
  if (textHead !== null) {
    const trimmedLower = textHead.trimStart().slice(0, 512).toLowerCase();
    // Active markup (SVG, HTML, XHTML, XML) is never classified as inline-safe and never rendered inline.
    if (trimmedLower.includes('<svg') || ext === 'svg' || declared === 'image/svg+xml') {
      return { contentType: 'image/svg+xml', extractStatus: 'skipped' };
    }
    if (
      trimmedLower.startsWith('<!doctype html') ||
      trimmedLower.startsWith('<html') ||
      ext === 'html' ||
      ext === 'htm' ||
      declared === 'text/html'
    ) {
      return { contentType: 'text/html', extractStatus: 'skipped' };
    }
    if (ext === 'xhtml' || declared === 'application/xhtml+xml') {
      return { contentType: 'application/xhtml+xml', extractStatus: 'skipped' };
    }
    if (trimmedLower.startsWith('<?xml') || trimmedLower.startsWith('<') || ext === 'xml' || declared === 'text/xml' || declared === 'application/xml') {
      return { contentType: 'application/xml', extractStatus: 'skipped' };
    }
    if (ext === 'csv' || declared === 'text/csv') {
      return { contentType: 'text/csv', extractStatus: 'pending' };
    }
    if (ext === 'md' || ext === 'markdown' || declared === 'text/markdown') {
      return { contentType: 'text/markdown', extractStatus: 'pending' };
    }
    return { contentType: 'text/plain', extractStatus: 'pending' };
  }

  return { contentType: 'application/octet-stream', extractStatus: 'skipped' };
}

const DEFAULT_EXT_FOR_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  [DOCX_CONTENT_TYPE]: 'docx',
  [XLSX_NOTE_CONTENT_TYPE]: 'xlsx',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'image/svg+xml': 'svg',
  'text/html': 'html',
  'application/xhtml+xml': 'xhtml',
  'application/xml': 'xml',
};

export function sanitizeNoteAttachmentFilename(rawName: string | null | undefined, contentType: string): string {
  const input = (rawName ?? '').trim();
  const chars: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    const ch = input[i] as string;
    if (ch === '/' || ch === '\\') {
      chars.push('_');
      continue;
    }
    chars.push(ch);
  }
  let cleaned = chars.join('').trim();
  while (cleaned.startsWith('.')) cleaned = cleaned.slice(1).trim();
  if (cleaned === '') {
    const ext = DEFAULT_EXT_FOR_TYPE[contentType] ?? 'bin';
    cleaned = `dinh-kem.${ext}`;
  } else if (lowerExtension(cleaned) === '') {
    const ext = DEFAULT_EXT_FOR_TYPE[contentType];
    if (ext) cleaned = `${cleaned}.${ext}`;
  }
  if (cleaned.length > NOTE_ATTACHMENT_FILENAME_MAX) {
    const ext = lowerExtension(cleaned);
    if (ext !== '' && ext.length < 12) {
      const keep = NOTE_ATTACHMENT_FILENAME_MAX - ext.length - 1;
      cleaned = `${cleaned.slice(0, Math.max(1, keep))}.${ext}`;
    } else {
      cleaned = cleaned.slice(0, NOTE_ATTACHMENT_FILENAME_MAX);
    }
  }
  return cleaned;
}

export function noteAttachmentContentDisposition(filename: string, contentType: string): string {
  const mode = isInlineSafeNoteAttachmentType(contentType) ? 'inline' : 'attachment';
  const fallbackChars: string[] = [];
  for (let i = 0; i < filename.length && fallbackChars.length < 120; i++) {
    const code = filename.charCodeAt(i);
    const isSafeAscii =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f;
    fallbackChars.push(isSafeAscii ? (filename[i] as string) : '_');
  }
  const asciiFallback = fallbackChars.join('').replace(/^_+/, '') || 'attachment';
  const encoded = encodeURIComponent(filename)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DomainError('TOO_LARGE', 413, 'Tệp đính kèm vượt quá giới hạn 25 MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readNoteAttachmentUploadRequest(req: Request): Promise<{
  bytes: Uint8Array;
  rawName: string;
  declaredType: string | null;
}> {
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null && req.headers.get('transfer-encoding') === null) {
    const declaredLength = Number(contentLengthHeader);
    // Allow 128 KiB multipart envelope overhead before parsing; file bytes themselves are strictly capped at 25 MiB below.
    if (Number.isFinite(declaredLength) && declaredLength > NOTE_ATTACHMENT_MAX_BYTES + 128 * 1024) {
      throw new DomainError('TOO_LARGE', 413, 'Tệp đính kèm vượt quá giới hạn 25 MB');
    }
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const rawBody = await readBoundedStream(req.body, NOTE_ATTACHMENT_MAX_BYTES + 128 * 1024);
    const copy = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: new Uint8Array(rawBody),
    });
    const form = await copy.formData().catch(() => {
      throw new DomainError('INVALID', 400, 'Dữ liệu biểu mẫu tải lên không hợp lệ');
    });
    const entries = form.getAll('file').filter((entry): entry is File => entry instanceof File);
    if (entries.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp đính kèm');
    if (entries.length > 1) {
      throw new DomainError('TOO_MANY_FILES', 413, 'Mỗi lượt chỉ tải lên 1 tệp đính kèm');
    }
    const file = entries[0] as File;
    if (file.size === 0) throw new DomainError('NO_FILE', 400, 'Tệp đính kèm rỗng');
    if (file.size > NOTE_ATTACHMENT_MAX_BYTES) {
      throw new DomainError('TOO_LARGE', 413, `${file.name || 'Tệp'} vượt quá giới hạn 25 MB`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp đính kèm rỗng');
    if (bytes.byteLength > NOTE_ATTACHMENT_MAX_BYTES) {
      throw new DomainError('TOO_LARGE', 413, `${file.name || 'Tệp'} vượt quá giới hạn 25 MB`);
    }
    return { bytes, rawName: file.name, declaredType: file.type || null };
  }

  const bytes = await readBoundedStream(req.body, NOTE_ATTACHMENT_MAX_BYTES);
  if (bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp đính kèm rỗng');
  const url = new URL(req.url);
  const rawName = url.searchParams.get('filename') ?? req.headers.get('x-file-name') ?? 'dinh-kem';
  return { bytes, rawName, declaredType: contentType || null };
}

export async function handleNoteAttachmentUpload(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  noteId: string;
  req: Request;
}): Promise<NoteAttachment> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }
  if (!UUID_RE.test(deps.noteId)) {
    throw new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');
  }
  const noteId = deps.noteId.toLowerCase();
  const { bytes, rawName, declaredType } = await readNoteAttachmentUploadRequest(deps.req);
  const { contentType, extractStatus } = classifyNoteAttachment(bytes, rawName, declaredType);
  const filename = sanitizeNoteAttachmentFilename(rawName, contentType);
  const sha256 = sha256Hex(bytes);
  const attachmentId = randomUUID();
  const storageKey = noteAttachmentKey(deps.orgId, attachmentId);

  await deps.store.put(storageKey, bytes, contentType);
  let created: NoteAttachmentCreated;
  try {
    created = await deps.runtime.execute<NoteAttachmentCreated>(
      'notes.attachment.create',
      {
        attachmentId,
        noteId,
        filename,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        extractStatus,
      },
      { actor: actorOf(deps.user), orgId: deps.orgId },
    );
  } catch (error) {
    await deps.store.delete(storageKey).catch((cleanupErr: unknown) => {
      console.error('[notes-attachments] failed to roll back uploaded blob', cleanupErr instanceof Error ? cleanupErr.name : 'error');
    });
    throw error;
  }

  return {
    id: created.attachmentId,
    noteId: created.noteId,
    authorUserId: deps.user.userId,
    filename,
    contentType,
    sizeBytes: bytes.byteLength,
    sha256,
    extractStatus: created.extractStatus,
    createdAt: created.createdAt,
  };
}

export async function handleNoteAttachmentDownload(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  attachmentId: string;
}): Promise<Response> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }
  if (!UUID_RE.test(deps.attachmentId)) {
    throw new DomainError('NOTE_ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy tệp đính kèm này');
  }
  const meta = await deps.runtime.query<NoteAttachmentDownloadMeta>(
    'notes.attachment.download_meta',
    { attachmentId: deps.attachmentId.toLowerCase() },
    { actor: actorOf(deps.user), orgId: deps.orgId },
  );

  let bytes: Uint8Array;
  try {
    bytes = await readVerified(
      deps.store,
      { key: meta.storageKey, generation: null, sha256: meta.sha256 },
      NOTE_ATTACHMENT_MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      throw new DomainError('NOTE_ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy tệp đính kèm này');
    }
    throw error;
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': meta.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': noteAttachmentContentDisposition(meta.filename, meta.contentType),
      'content-security-policy': NOTE_ATTACHMENT_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
