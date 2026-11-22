// SPDX-License-Identifier: AGPL-3.0-only
// HTTP upload & poll helpers for sandboxed HR CV PDF/DOCX extraction (#4446 Stage 5D, T12).
// Never parses untrusted PDF/DOCX bytes in the API process: only validates magic header bytes,
// stages raw bytes into BlobStore tmp/<orgId>/<sha256>, triggers worker crove-extract via outbox,
// waits briefly (or returns 202 pending for poll), and enriches with optional metered Ly proposal draft.
import { randomUUID } from 'node:crypto';
import {
  HR_CV_MAX_BYTES,
  zHrCvExtractAuthorizeInput,
  zHrCvExtractContextInput,
  type HrCvExtractResponse,
} from '@ludy/kernel-contract';
import { BlobNotFoundError, DomainError, readVerified, sha256Hex, type BlobStore, type Runtime, type UserActor } from '@ludy/kernel-runtime';
import {
  buildCvExtractDraft,
  hrCvBlobKey,
  type CvSandboxKind,
  type HrCvExtractContext,
} from '@ludy/mod-hr';
import type { AuthUser } from './auth.ts';
import { actorOf } from './auth.ts';
import { readBoundedStream } from './note-attachments.ts';
import { proposeCvDraftWithLy, type RecruitingCvAi } from './recruiting-coworker-ai.ts';
import type { HrCvExtractStoredResult } from './hr-cv-worker.ts';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_CV_WAIT_MS = 1_500;
const POLL_INTERVAL_MS = 250;
const HR_CV_RESULT_MAX_BYTES = 2 * 1024 * 1024;
const FINALIZED_DRAFT_TTL_MS = 10 * 60 * 1_000;
const FINALIZED_DRAFT_MAX_ENTRIES = 500;

interface CachedFinalizedDraft {
  expiresAt: number;
  response: HrCvExtractResponse;
}

interface RuntimeFinalizeCache {
  entries: Map<string, CachedFinalizedDraft>;
  inflight: Map<string, Promise<HrCvExtractResponse>>;
}

const finalizeCacheByRuntime = new WeakMap<Runtime, RuntimeFinalizeCache>();

function getRuntimeFinalizeCache(runtime: Runtime): RuntimeFinalizeCache {
  let state = finalizeCacheByRuntime.get(runtime);
  if (!state) {
    state = { entries: new Map(), inflight: new Map() };
    finalizeCacheByRuntime.set(runtime, state);
  }
  return state;
}

function pruneExpiredCacheEntries(entries: Map<string, CachedFinalizedDraft>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(key);
    }
  }
  while (entries.size >= FINALIZED_DRAFT_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((b, idx) => bytes[idx] === b);
}

export function classifyCvUpload(
  bytes: Uint8Array,
  rawName: string,
  declaredType: string | null,
): { kind: CvSandboxKind; contentType: string } {
  if (startsWith(bytes, PDF_MAGIC)) {
    return { kind: 'pdf_text', contentType: 'application/pdf' };
  }
  const lowerName = rawName.trim().toLowerCase();
  const normalizedMime = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (startsWith(bytes, ZIP_MAGIC) && (lowerName.endsWith('.docx') || normalizedMime === DOCX_MIME)) {
    return { kind: 'docx_text', contentType: DOCX_MIME };
  }
  throw new DomainError('UNSUPPORTED_FILE_TYPE', 415, 'Chỉ hỗ trợ tệp CV định dạng PDF hoặc DOCX');
}

async function readCvUploadForm(req: Request): Promise<{
  bytes: Uint8Array;
  rawName: string;
  declaredType: string | null;
  openingId?: string;
  legalEntityId?: string;
  lang: 'vi' | 'en';
  useAi: boolean;
}> {
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null && req.headers.get('transfer-encoding') === null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > HR_CV_MAX_BYTES + 128 * 1024) {
      throw new DomainError('TOO_LARGE', 413, 'Tệp CV vượt quá giới hạn 10 MB');
    }
  }
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new DomainError('INVALID', 400, 'Hãy gửi tệp CV dưới dạng multipart/form-data');
  }
  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedStream(req.body, HR_CV_MAX_BYTES + 128 * 1024);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'TOO_LARGE') {
      throw new DomainError('TOO_LARGE', 413, 'Tệp CV vượt quá giới hạn 10 MB');
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
  if (entries.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp CV');
  if (entries.length > 1) throw new DomainError('TOO_MANY_FILES', 413, 'Mỗi lượt chỉ tải lên 1 tệp CV');
  const file = entries[0] as File;
  if (file.size === 0) throw new DomainError('NO_FILE', 400, 'Tệp CV rỗng');
  if (file.size > HR_CV_MAX_BYTES) throw new DomainError('TOO_LARGE', 413, 'Tệp CV vượt quá giới hạn 10 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp CV rỗng');
  if (bytes.byteLength > HR_CV_MAX_BYTES) throw new DomainError('TOO_LARGE', 413, 'Tệp CV vượt quá giới hạn 10 MB');

  const openingRaw = form.get('openingId');
  const legalEntityRaw = form.get('legalEntityId');
  const langRaw = form.get('lang');
  const useAiRaw = form.get('useAi');
  const openingId = typeof openingRaw === 'string' && openingRaw.trim() !== '' ? openingRaw.trim() : undefined;
  const legalEntityId = typeof legalEntityRaw === 'string' && legalEntityRaw.trim() !== '' ? legalEntityRaw.trim() : undefined;
  const lang = langRaw === 'en' ? 'en' : 'vi';
  const useAi = useAiRaw !== 'false';

  const parsedIds = zHrCvExtractContextInput.safeParse({
    jobId: '00000000-0000-0000-0000-000000000000',
    ...(openingId !== undefined ? { openingId } : {}),
    ...(legalEntityId !== undefined ? { legalEntityId } : {}),
  });
  if (!parsedIds.success) {
    throw new DomainError('VALIDATION', 422, 'Thông tin vị trí tuyển dụng hoặc pháp nhân không hợp lệ');
  }

  return {
    bytes,
    rawName: file.name || 'cv',
    declaredType: file.type || null,
    ...(openingId !== undefined ? { openingId } : {}),
    ...(legalEntityId !== undefined ? { legalEntityId } : {}),
    lang,
    useAi,
  };
}

async function finalizeExtractedResult(deps: {
  runtime: Runtime;
  store: BlobStore;
  orgId: string;
  actor: UserActor;
  context: HrCvExtractContext;
  resultKey: string;
  resultSha256: string;
  lang: 'vi' | 'en';
  useAi: boolean;
  cvAi: RecruitingCvAi;
  runInAiScope: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<HrCvExtractResponse> {
  const effectiveAi = deps.useAi && deps.cvAi.aiEnabled && Boolean(deps.cvAi.reader);
  const cacheKey = `${deps.orgId}:${deps.context.jobId}:${deps.resultSha256}:${deps.context.openingId ?? ''}:${deps.lang}:${effectiveAi ? '1' : '0'}`;
  const state = getRuntimeFinalizeCache(deps.runtime);
  const now = Date.now();
  const cached = state.entries.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > now) {
      return structuredClone(cached.response);
    }
    state.entries.delete(cacheKey);
  }

  const existingInflight = state.inflight.get(cacheKey);
  if (existingInflight) {
    return structuredClone(await existingInflight);
  }

  const run = (async (): Promise<HrCvExtractResponse> => {
    let bytes: Uint8Array;
    try {
      bytes = await readVerified(
        deps.store,
        { key: deps.resultKey, generation: null, sha256: deps.resultSha256 },
        HR_CV_RESULT_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        throw new DomainError('HR_CV_JOB_NOT_FOUND', 404, 'Kết quả tách CV đã hết hạn, vui lòng tải lại tệp');
      }
      throw error;
    }

    let parsed: HrCvExtractStoredResult;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as HrCvExtractStoredResult;
    } catch {
      throw new DomainError('HR_CV_EXTRACT_FAILED', 500, 'Không đọc được kết quả tách CV');
    }

    if (!parsed.ok || typeof parsed.text !== 'string') {
      throw new DomainError(parsed.errorCode ?? 'HR_CV_EXTRACT_FAILED', 422, parsed.errorMessage ?? 'Không đọc được nội dung tệp CV');
    }

    const draft = await deps.runInAiScope(() =>
      buildCvExtractDraft({
        text: parsed.text as string,
        sourceKind: parsed.kind,
        openingId: deps.context.openingId,
        openingTitle: deps.context.openingTitle,
        requiredSkills: deps.context.requiredSkills,
        lang: deps.lang,
        propose: (proposeInput) => proposeCvDraftWithLy(deps.cvAi, deps.orgId, deps.actor.userId, proposeInput, deps.useAi),
      }),
    );

    await deps.runtime.execute(
      'hr.recruiting.cv_extract.audit',
      {
        jobId: deps.context.jobId,
        openingId: deps.context.openingId,
        kind: parsed.kind,
        extractedChars: draft.extractedChars,
        aiReason: draft.ai.reason,
      },
      { actor: deps.actor, orgId: deps.orgId },
    );

    const response: HrCvExtractResponse = {
      status: 'ready',
      jobId: deps.context.jobId,
      draft,
    };
    pruneExpiredCacheEntries(state.entries, Date.now());
    state.entries.set(cacheKey, {
      expiresAt: Date.now() + FINALIZED_DRAFT_TTL_MS,
      response,
    });
    return response;
  })();

  state.inflight.set(cacheKey, run);
  try {
    return structuredClone(await run);
  } finally {
    state.inflight.delete(cacheKey);
  }
}

export async function handleHrCvExtractUpload(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  req: Request;
  cvAi: RecruitingCvAi;
  waitMs?: number;
  runInAiScope: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<HrCvExtractResponse> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }
  const actor = actorOf(deps.user);
  // Check manager role, session standing, and MFA BEFORE reading form bytes or touching BlobStore.
  await deps.runtime.query('hr.recruiting.cv_extract.authorize', {}, { actor, orgId: deps.orgId });

  const upload = await readCvUploadForm(deps.req);
  const { kind, contentType } = classifyCvUpload(upload.bytes, upload.rawName, upload.declaredType);

  if (upload.openingId !== undefined || upload.legalEntityId !== undefined) {
    await deps.runtime.query(
      'hr.recruiting.cv_extract.authorize',
      {
        ...(upload.legalEntityId !== undefined ? { legalEntityId: upload.legalEntityId } : {}),
        ...(upload.openingId !== undefined ? { openingId: upload.openingId } : {}),
      },
      { actor, orgId: deps.orgId },
    );
  }

  const jobId = randomUUID();
  const sha256 = sha256Hex(upload.bytes);
  const storageKey = hrCvBlobKey(deps.orgId, sha256);

  await deps.store.put(storageKey, upload.bytes, contentType);
  const requested = await deps.runtime.execute<HrCvExtractContext>(
    'hr.recruiting.cv_extract.request',
    {
      jobId,
      kind,
      ...(upload.legalEntityId !== undefined ? { legalEntityId: upload.legalEntityId } : {}),
      ...(upload.openingId !== undefined ? { openingId: upload.openingId } : {}),
      sizeBytes: upload.bytes.byteLength,
      sha256,
    },
    { actor, orgId: deps.orgId },
  );

  const deadline = Date.now() + (deps.waitMs ?? DEFAULT_CV_WAIT_MS);
  let context = requested;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    context = await deps.runtime.query<HrCvExtractContext>(
      'hr.recruiting.cv_extract.context',
      {
        jobId,
        ...(upload.legalEntityId !== undefined ? { legalEntityId: upload.legalEntityId } : {}),
        ...(upload.openingId !== undefined ? { openingId: upload.openingId } : {}),
      },
      { actor, orgId: deps.orgId },
    );
    if (context.resultKey && context.resultSha256) {
      return finalizeExtractedResult({
        runtime: deps.runtime,
        store: deps.store,
        orgId: deps.orgId,
        actor,
        context,
        resultKey: context.resultKey,
        resultSha256: context.resultSha256,
        lang: upload.lang,
        useAi: upload.useAi,
        cvAi: deps.cvAi,
        runInAiScope: deps.runInAiScope,
      });
    }
  }

  return {
    status: 'pending',
    jobId,
  };
}

export async function handleHrCvExtractPoll(deps: {
  runtime: Runtime;
  store: BlobStore;
  user: AuthUser;
  orgId: string;
  jobId: string;
  openingId?: string;
  legalEntityId?: string;
  lang?: 'vi' | 'en';
  useAi?: boolean;
  cvAi: RecruitingCvAi;
  runInAiScope: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<HrCvExtractResponse> {
  if (deps.user.extension) {
    throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  }
  if (!zHrCvExtractContextInput.shape.jobId.safeParse(deps.jobId).success) {
    throw new DomainError('HR_CV_JOB_NOT_FOUND', 404, 'Không tìm thấy yêu cầu tách CV này');
  }
  const parsedIds = zHrCvExtractAuthorizeInput.safeParse({
    ...(deps.openingId !== undefined ? { openingId: deps.openingId } : {}),
    ...(deps.legalEntityId !== undefined ? { legalEntityId: deps.legalEntityId } : {}),
  });
  if (!parsedIds.success) {
    throw new DomainError('VALIDATION', 422, 'Thông tin vị trí tuyển dụng hoặc pháp nhân không hợp lệ');
  }
  const actor = actorOf(deps.user);
  const context = await deps.runtime.query<HrCvExtractContext>(
    'hr.recruiting.cv_extract.context',
    {
      jobId: deps.jobId,
      ...parsedIds.data,
    },
    {
      actor,
      orgId: deps.orgId,
    },
  );
  if (!context.resultKey || !context.resultSha256) {
    return { status: 'pending', jobId: context.jobId };
  }
  return finalizeExtractedResult({
    runtime: deps.runtime,
    store: deps.store,
    orgId: deps.orgId,
    actor,
    context,
    resultKey: context.resultKey,
    resultSha256: context.resultSha256,
    lang: deps.lang ?? 'vi',
    useAi: deps.useAi !== false,
    cvAi: deps.cvAi,
    runInAiScope: deps.runInAiScope,
  });
}
