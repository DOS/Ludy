// SPDX-License-Identifier: AGPL-3.0-only
// HTTP upload & poll relay for eSign native .docx -> tagged A4 PDF conversion (#4721, Gate T12).
// The API process NEVER parses .docx bytes or calls crove-extract directly: it validates file bounds/magic,
// stages raw bytes into BlobStore tmp/<orgId>/<sha256>, triggers worker execution via outbox, waits briefly
// (or returns 202 pending), and ingests converted PDF strictly as actorOf(user). Shared content-addressed tmp/
// blobs are left to sweepTmpBlobs (retention.ts) so concurrent identical uploads never delete each other's blobs.
import { randomUUID } from 'node:crypto';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import type { SignDocxConvertCompletedResult, SignDocxConvertHttpResponse } from '@ludy/kernel-contract';
import {
  BlobNotFoundError,
  DomainError,
  contentGeneration,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
  type UserActor,
} from '@ludy/kernel-runtime';
import {
  SIGN_DOCX_MAX_BYTES,
  pdfFilenameFromDocx,
  signDocxBlobKey,
  type SignDocxConvertStatus,
} from '@ludy/mod-sign';
import type { AuthUser } from './auth.ts';
import { actorOf } from './auth.ts';
import { readBoundedStream } from './note-attachments.ts';
import { RateLimiter } from './rate-limit.ts';

export const SIGN_DOCX_WAIT_MS = 3_000;
const SIGN_DOCX_POLL_INTERVAL_MS = 100;
export const SIGN_DOCX_PER_MINUTE = 20;
export const SIGN_DOCX_RATE_LIMIT_MAX_KEYS = 4_096;
const SIGN_DOCX_MAX_BODY_BYTES = SIGN_DOCX_MAX_BYTES + 128 * 1024;
export const SIGN_DOCX_FINALIZED_TTL_MS = 10 * 60_000;
export const SIGN_DOCX_FINALIZED_MAX_ENTRIES = 256;
export const SIGN_DOCX_FILENAMES_MAX_ENTRIES = 256;
export const SIGN_DOCX_INFLIGHT_MAX_ENTRIES = 64;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_UPLOAD_MIMES = new Set(['', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed', DOCX_MIME]);
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_MESSAGES: Readonly<Record<string, { status: 413 | 422; message: string }>> = {
  TOO_LARGE: { status: 413, message: 'Tệp Word (.docx) hoặc PDF tạo ra vượt quá giới hạn kích thước cho phép' },
  SIGN_DOCX_TOO_LARGE: { status: 413, message: 'Tệp PDF sau khi chuyển đổi vượt quá giới hạn 25 MB' },
  SIGN_DOCX_TRACK_CHANGES: {
    status: 422,
    message: 'Tệp Word còn nội dung Theo dõi thay đổi (Track Changes) chưa được chấp nhận; vui lòng xử lý toàn bộ thay đổi trước khi tải lên',
  },
  SIGN_DOCX_HIDDEN_TEXT: {
    status: 422,
    message: 'Tệp Word có chứa văn bản ẩn (hidden text); vui lòng hiện hoặc xóa nội dung ẩn trước khi tải lên',
  },
  SIGN_DOCX_ENCRYPTED: {
    status: 422,
    message: 'Tệp Word được đặt mật khẩu hoặc mã hóa; vui lòng lưu lại không có mật khẩu',
  },
  SIGN_DOCX_UNSAFE_XML: {
    status: 422,
    message: 'Tệp DOCX chứa khai báo XML không an toàn',
  },
  SIGN_DOCX_TOO_MANY_PAGES: {
    status: 422,
    message: 'Tài liệu sau khi chuyển đổi vượt quá giới hạn 200 trang',
  },
  SIGN_DOCX_INVALID: {
    status: 422,
    message: 'Tệp Word (.docx) không hợp lệ hoặc bị hỏng',
  },
  SIGN_DOCX_SOURCE_MISSING: {
    status: 422,
    message: 'Không tìm thấy tệp Word nguồn để chuyển đổi; vui lòng tải lên lại',
  },
};

/** Bounded LRU cache with per-entry TTL cleanup so burst traffic cannot grow memory without bound. */
export class ExpiringLruCache<T> {
  private readonly map = new Map<string, { expiresAt: number; value: T }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive number');
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.map.delete(key);
    this.pruneExpired(now);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { expiresAt: now + this.ttlMs, value });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

interface RuntimeDocxState {
  limiter: RateLimiter;
  entries: ExpiringLruCache<SignDocxConvertCompletedResult>;
  filenames: ExpiringLruCache<string>;
  inflight: Map<string, Promise<SignDocxConvertCompletedResult>>;
}

const stateByRuntime = new WeakMap<Runtime, RuntimeDocxState>();

function getRuntimeState(runtime: Runtime): RuntimeDocxState {
  let state = stateByRuntime.get(runtime);
  if (!state) {
    state = {
      limiter: new RateLimiter({ perMinute: SIGN_DOCX_PER_MINUTE, maxKeys: SIGN_DOCX_RATE_LIMIT_MAX_KEYS }),
      entries: new ExpiringLruCache(SIGN_DOCX_FINALIZED_MAX_ENTRIES, SIGN_DOCX_FINALIZED_TTL_MS),
      filenames: new ExpiringLruCache(SIGN_DOCX_FILENAMES_MAX_ENTRIES, SIGN_DOCX_FINALIZED_TTL_MS),
      inflight: new Map(),
    };
    stateByRuntime.set(runtime, state);
  }
  return state;
}

export function getSignDocxRuntimeStats(runtime: Runtime): {
  rateLimiterKeys: number;
  finalizedEntries: number;
  filenameEntries: number;
  inflightCount: number;
} | null {
  const state = stateByRuntime.get(runtime);
  if (!state) return null;
  return {
    rateLimiterKeys: state.limiter.size,
    finalizedEntries: state.entries.size,
    filenameEntries: state.filenames.size,
    inflightCount: state.inflight.size,
  };
}

function jobCacheKey(orgId: string, userId: string, jobId: string): string {
  return `${orgId.toLowerCase()}:${userId.toLowerCase()}:${jobId.toLowerCase()}`;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((b, idx) => bytes[idx] === b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanUploadFilename(rawName: string): string {
  const leaf = rawName.split(/[\\/]/).pop() ?? '';
  const safe = leaf.replace(/[\r\n\t\0]/g, '').trim();
  return (safe || 'hop-dong.docx').slice(0, 255);
}

function signDocxFailureError(errorCode: string | null): DomainError {
  const code = errorCode ?? 'SIGN_DOCX_CONVERT_FAILED';
  const mapped = ERROR_MESSAGES[code];
  if (mapped) {
    return new DomainError(code, mapped.status, mapped.message);
  }
  return new DomainError(code, 422, 'Không thể chuyển đổi tệp Word (.docx) sang PDF');
}

export function assertValidSignDocxBytes(bytes: Uint8Array, rawFilename: string, rawMime: string): string {
  if (bytes.byteLength === 0) {
    throw new DomainError('NO_FILE', 400, 'Tệp Word (.docx) rỗng');
  }
  if (bytes.byteLength > SIGN_DOCX_MAX_BYTES) {
    throw new DomainError('TOO_LARGE', 413, 'Tệp Word (.docx) vượt quá giới hạn 10 MB');
  }

  const filename = cleanUploadFilename(rawFilename);
  const lowerName = filename.toLowerCase();
  const mime = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';

  // Legacy .doc / encrypted OLE2 containers get an explicit 422 explanation rather than generic 415.
  if (startsWith(bytes, OLE2_MAGIC)) {
    throw new DomainError(
      'SIGN_DOCX_OLE2_UNSUPPORTED',
      422,
      'Không hỗ trợ tệp Word được mã hóa hoặc định dạng .doc cũ; vui lòng lưu lại dưới dạng .docx không mật khẩu',
    );
  }

  if (!startsWith(bytes, ZIP_MAGIC)) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, `${filename}: chỉ hỗ trợ tệp Word (.docx) chuẩn Office Open XML`);
  }

  if (lowerName.endsWith('.doc')) {
    throw new DomainError(
      'SIGN_DOCX_OLE2_UNSUPPORTED',
      422,
      'Không hỗ trợ định dạng .doc cũ; vui lòng lưu lại dưới dạng .docx',
    );
  }

  const hasDocxExt = lowerName.endsWith('.docx');
  const hasDocxMime = mime === DOCX_MIME;
  if (!hasDocxExt && !hasDocxMime) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, `${filename}: chỉ chấp nhận tệp định dạng .docx`);
  }
  if (!ALLOWED_UPLOAD_MIMES.has(mime)) {
    throw new DomainError('UNSUPPORTED_TYPE', 415, `${filename}: loại tệp ${mime} không phải .docx hợp lệ`);
  }

  return filename;
}

async function readUploadedDocx(req: Request): Promise<{ bytes: Uint8Array; filename: string }> {
  const declaredLen = req.headers.get('content-length');
  if (declaredLen !== null) {
    const n = Number(declaredLen);
    if (Number.isFinite(n) && n > SIGN_DOCX_MAX_BODY_BYTES) {
      throw new DomainError('TOO_LARGE', 413, 'Tệp Word (.docx) vượt quá giới hạn 10 MB');
    }
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new DomainError('INVALID', 400, 'Hãy gửi tệp Word dưới dạng multipart/form-data');
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedStream(req.body, SIGN_DOCX_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'TOO_LARGE') {
      throw new DomainError('TOO_LARGE', 413, 'Tệp Word (.docx) vượt quá giới hạn 10 MB');
    }
    throw error;
  }

  const copy = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: new Uint8Array(rawBody),
  });
  const form = await copy.formData().catch(() => {
    throw new DomainError('INVALID', 400, 'Dữ liệu biểu mẫu tải lên không hợp lệ');
  });

  const entries = form.getAll('file').filter((entry): entry is File => entry instanceof File);
  if (entries.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp Word (.docx)');
  if (entries.length > 1) throw new DomainError('TOO_MANY_FILES', 413, 'Mỗi lượt chỉ tải lên 1 tệp Word (.docx)');

  const file = entries[0]!;
  if (file.size === 0) throw new DomainError('NO_FILE', 400, 'Tệp Word (.docx) rỗng');
  if (file.size > SIGN_DOCX_MAX_BYTES) throw new DomainError('TOO_LARGE', 413, 'Tệp Word (.docx) vượt quá giới hạn 10 MB');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = assertValidSignDocxBytes(bytes, file.name, file.type);
  return { bytes, filename };
}

async function readConvertedPdfBytes(
  store: BlobStore,
  orgId: string,
  pdfStorageKey: string,
  pdfSha256: string,
): Promise<Uint8Array> {
  const ref = { key: pdfStorageKey, generation: contentGeneration(pdfSha256), sha256: pdfSha256 };
  try {
    return await readVerified(store, ref, EXTRACT_LIMITS.maxFileBytes);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return readVerified(
        store,
        { key: fileKey(orgId, pdfSha256), generation: contentGeneration(pdfSha256), sha256: pdfSha256 },
        EXTRACT_LIMITS.maxFileBytes,
      );
    }
    throw error;
  }
}

function resolveJobPdfFilename(state: RuntimeDocxState, cacheKey: string, hintFilename?: string): string {
  return state.filenames.get(cacheKey, Date.now()) ?? pdfFilenameFromDocx(hintFilename);
}

async function finalizeSignDocxResult(deps: {
  runtime: Runtime;
  store: BlobStore;
  orgId: string;
  actor: UserActor;
  status: SignDocxConvertStatus;
  hintFilename?: string | undefined;
}): Promise<SignDocxConvertCompletedResult> {
  const { runtime, store, orgId, actor, status, hintFilename } = deps;
  if (!status.pdfStorageKey || !status.pdfSha256 || !status.pageCount) {
    throw new DomainError('SIGN_DOCX_CONVERT_FAILED', 422, 'Kết quả chuyển đổi tệp Word không đầy đủ');
  }

  const cacheKey = jobCacheKey(orgId, actor.userId, status.jobId);
  const state = getRuntimeState(runtime);
  const cached = state.entries.get(cacheKey, Date.now());
  if (cached) {
    return structuredClone(cached);
  }

  const running = state.inflight.get(cacheKey);
  if (running) {
    return structuredClone(await running);
  }
  if (state.inflight.size >= SIGN_DOCX_INFLIGHT_MAX_ENTRIES) {
    throw new DomainError('UPLOAD_BUSY', 503, 'Hệ thống đang bận xử lý chuyển đổi tệp Word; vui lòng thử lại sau ít giây');
  }

  const pdfFilename = resolveJobPdfFilename(state, cacheKey, hintFilename);

  const work = (async (): Promise<SignDocxConvertCompletedResult> => {
    const pdfBytes = await readConvertedPdfBytes(store, orgId, status.pdfStorageKey!, status.pdfSha256!);
    if (pdfBytes.byteLength === 0 || pdfBytes.byteLength > EXTRACT_LIMITS.maxFileBytes || !startsWith(pdfBytes, PDF_MAGIC)) {
      throw new DomainError('SIGN_DOCX_CONVERT_FAILED', 422, 'Tệp PDF sau chuyển đổi không hợp lệ');
    }

    const permanentKey = fileKey(orgId, status.pdfSha256!);
    const generation = await putFile(store, permanentKey, pdfBytes, 'application/pdf', status.pdfSha256!);

    // Ingest strictly as the uploading user so unattached sign_document confidentiality (can_read_sign_file) holds.
    const ingested = await runtime.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      {
        filename: pdfFilename,
        contentType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
        sha256: status.pdfSha256!,
        storageKey: permanentKey,
        generation,
        source: 'sign_document',
      },
      { actor, orgId },
    );

    const result: SignDocxConvertCompletedResult = {
      status: 'completed',
      fileId: ingested.fileId,
      filename: pdfFilename,
      pageCount: status.pageCount!,
      sourceDocxSha256: status.inputSha256,
      warnings: [...status.warnings],
    };

    state.entries.set(cacheKey, structuredClone(result), Date.now());
    state.filenames.delete(cacheKey);
    return result;
  })();

  state.inflight.set(cacheKey, work);
  try {
    return structuredClone(await work);
  } finally {
    if (state.inflight.get(cacheKey) === work) {
      state.inflight.delete(cacheKey);
    }
  }
}

async function resolveStatusResponse(deps: {
  runtime: Runtime;
  store: BlobStore;
  orgId: string;
  actor: UserActor;
  status: SignDocxConvertStatus;
  hintFilename?: string | undefined;
}): Promise<SignDocxConvertHttpResponse> {
  const { status } = deps;
  if (status.status === 'pending') {
    return { status: 'pending', jobId: status.jobId };
  }
  if (status.status === 'failed') {
    getRuntimeState(deps.runtime).filenames.delete(jobCacheKey(deps.orgId, deps.actor.userId, status.jobId));
    throw signDocxFailureError(status.errorCode);
  }
  return finalizeSignDocxResult(deps);
}

export async function handleSignDocxConvertUpload(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  req: Request;
  waitMs?: number;
  onRateLimited?: (retryAfterSeconds: number) => void;
}): Promise<SignDocxConvertHttpResponse> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }

  const actor = actorOf(deps.user);
  // Check SIGN_WRITERS role, session standing, and MFA BEFORE rate-limit budget, reading upload bytes, or touching BlobStore.
  await deps.runtime.query('sign.docx_convert.authorize', {}, { actor, orgId: deps.orgId });

  const state = getRuntimeState(deps.runtime);
  const decision = state.limiter.take(`${deps.orgId.toLowerCase()}:${actor.userId.toLowerCase()}`);
  if (!decision.allowed) {
    deps.onRateLimited?.(decision.retryAfterSeconds);
    throw new DomainError('RATE_LIMITED', 429, 'Bạn chuyển đổi quá nhiều tệp Word; hãy thử lại sau ít phút');
  }

  const { bytes, filename } = await readUploadedDocx(deps.req);
  const sha256 = sha256Hex(bytes);
  const inputStorageKey = signDocxBlobKey(deps.orgId, sha256);
  const jobId = randomUUID();
  const pdfName = pdfFilenameFromDocx(filename);

  await deps.store.put(inputStorageKey, bytes, DOCX_MIME);
  await deps.runtime.execute(
    'sign.docx_convert.request',
    {
      jobId,
      sha256,
      sizeBytes: bytes.byteLength,
    },
    { actor, orgId: deps.orgId },
  );

  state.filenames.set(jobCacheKey(deps.orgId, actor.userId, jobId), pdfName, Date.now());

  const waitMs = Math.max(0, Math.min(30_000, deps.waitMs ?? SIGN_DOCX_WAIT_MS));
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const status = await deps.runtime.query<SignDocxConvertStatus>(
        'sign.docx_convert.status',
        { jobId },
        { actor, orgId: deps.orgId },
      );
      if (status.status !== 'pending') {
        return await resolveStatusResponse({
          runtime: deps.runtime,
          store: deps.store,
          orgId: deps.orgId,
          actor,
          status,
          hintFilename: pdfName,
        });
      }
    } catch (error) {
      if (error instanceof DomainError && error.status < 500 && error.code !== 'SIGN_DOCX_JOB_NOT_FOUND') {
        throw error;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(SIGN_DOCX_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }

  return { status: 'pending', jobId };
}

export async function handleSignDocxConvertPoll(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  jobId: string;
  filename?: string | undefined;
}): Promise<SignDocxConvertHttpResponse> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }
  if (!UUID_PATTERN.test(deps.jobId)) {
    throw new DomainError('INVALID_JOB_ID', 400, 'Mã tác vụ chuyển đổi không hợp lệ');
  }

  const actor = actorOf(deps.user);
  const status = await deps.runtime.query<SignDocxConvertStatus>(
    'sign.docx_convert.status',
    { jobId: deps.jobId },
    { actor, orgId: deps.orgId },
  );

  return resolveStatusResponse({
    runtime: deps.runtime,
    store: deps.store,
    orgId: deps.orgId,
    actor,
    status,
    hintFilename: deps.filename,
  });
}
