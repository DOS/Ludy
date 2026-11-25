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
const RATE_LIMIT_DRAFT_TTL_MS = 60 * 1_000;
const FINALIZED_DRAFT_MAX_ENTRIES = 500;

interface CachedFinalizedDraft {
  expiresAt: number;
  kind: CvSandboxKind;
  draft: Awaited<ReturnType<typeof buildCvExtractDraft>>;
  auditedUsers: Set<string>;
}

interface RuntimeFinalizeCache {
  entries: Map<string, CachedFinalizedDraft>;
  inflight: Map<string, Promise<HrCvExtractResponse>>;
  auditInflight: Map<string, Promise<void>>;
}

const finalizeCacheByRuntime = new WeakMap<Runtime, RuntimeFinalizeCache>();

function getRuntimeFinalizeCache(runtime: Runtime): RuntimeFinalizeCache {
  let state = finalizeCacheByRuntime.get(runtime);
  if (!state) {
    state = { entries: new Map(), inflight: new Map(), auditInflight: new Map() };
    finalizeCacheByRuntime.set(runtime, state);
  }
  return state;
}

async function ensureCvExtractAuditRecorded(
  state: RuntimeFinalizeCache,
  userCacheKey: string,
  deps: {
    runtime: Runtime;
    orgId: string;
    actor: UserActor;
    context: HrCvExtractContext;
  },
  entry: CachedFinalizedDraft,
): Promise<void> {
  if (entry.auditedUsers.has(deps.actor.userId)) return;
  const inflightAudit = state.auditInflight.get(userCacheKey);
  if (inflightAudit) {
    await inflightAudit;
    return;
  }
  const runAudit = (async () => {
    await deps.runtime.execute(
      'hr.recruiting.cv_extract.audit',
      {
        jobId: deps.context.jobId,
        openingId: deps.context.openingId,
        kind: entry.kind,
        extractedChars: entry.draft.extractedChars,
        aiReason: entry.draft.ai.reason,
      },
      { actor: deps.actor, orgId: deps.orgId },
    );
    entry.auditedUsers.add(deps.actor.userId);
  })();
  state.auditInflight.set(userCacheKey, runAudit);
  try {
    await runAudit;
  } finally {
    if (state.auditInflight.get(userCacheKey) === runAudit) {
      state.auditInflight.delete(userCacheKey);
    }
  }
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
  const openingFingerprint = sha256Hex(
    JSON.stringify([deps.context.openingTitle ?? null, [...deps.context.requiredSkills].sort()]),
  );
  const sharedCacheKey = `${deps.orgId}:${deps.context.jobId}:${deps.resultSha256}:${deps.context.openingId ?? ''}:${openingFingerprint}:${deps.lang}:${effectiveAi ? '1' : '0'}`;
  const userCacheKey = `${sharedCacheKey}:${deps.actor.userId}`;
  const state = getRuntimeFinalizeCache(deps.runtime);
  const now = Date.now();
  const lookupEntry = (key: string): CachedFinalizedDraft | undefined => {
    const entry = state.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      state.entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const cached = lookupEntry(sharedCacheKey) ?? lookupEntry(userCacheKey);
  if (cached && cached.auditedUsers.has(deps.actor.userId)) {
    return structuredClone({
      status: 'ready',
      jobId: deps.context.jobId,
      draft: cached.draft,
    });
  }

  const ownInflight = state.inflight.get(userCacheKey);
  if (ownInflight) {
    return structuredClone(await ownInflight);
  }
  const sharedInflight = state.inflight.get(sharedCacheKey);
  if (sharedInflight) {
    const sharedRes = await sharedInflight;
    if (!(sharedRes.status === 'ready' && sharedRes.draft.ai.reason === 'rate_limited')) {
      const sharedEntry = lookupEntry(sharedCacheKey);
      if (sharedEntry) {
        await ensureCvExtractAuditRecorded(state, userCacheKey, deps, sharedEntry);
      }
      return structuredClone(sharedRes);
    }
    const retryInflight = state.inflight.get(userCacheKey);
    if (retryInflight) {
      return structuredClone(await retryInflight);
    }
  }

  const run = (async (): Promise<HrCvExtractResponse> => {
    const checkNow = Date.now();
    const existingShared = state.entries.get(sharedCacheKey);
    const existingUser = state.entries.get(userCacheKey);
    let entry: CachedFinalizedDraft | undefined;
    if (existingShared && existingShared.expiresAt > checkNow) {
      entry = existingShared;
    } else {
      if (existingShared) state.entries.delete(sharedCacheKey);
      if (existingUser && existingUser.expiresAt > checkNow) {
        entry = existingUser;
      } else if (existingUser) {
        state.entries.delete(userCacheKey);
      }
    }

    if (!entry) {
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

      // Persist the generated draft before auditing so a transient audit DB error retries audit without repeating AI calls.
      // Scope per-user rate_limited fallbacks strictly to the caller and their retry window rather than sharing globally.
      const isUserScopedFallback = draft.ai.reason === 'rate_limited';
      const ttlMs = isUserScopedFallback ? RATE_LIMIT_DRAFT_TTL_MS : FINALIZED_DRAFT_TTL_MS;
      const targetKey = isUserScopedFallback ? userCacheKey : sharedCacheKey;
      pruneExpiredCacheEntries(state.entries, Date.now());
      entry = {
        expiresAt: Date.now() + ttlMs,
        kind: parsed.kind,
        draft,
        auditedUsers: new Set<string>(),
      };
      state.entries.set(targetKey, entry);
    }

    await ensureCvExtractAuditRecorded(state, userCacheKey, deps, entry);

    return {
      status: 'ready',
      jobId: deps.context.jobId,
      draft: entry.draft,
    };
  })();

  state.inflight.set(userCacheKey, run);
  const ownsSharedInflight = !state.inflight.has(sharedCacheKey);
  if (ownsSharedInflight) {
    state.inflight.set(sharedCacheKey, run);
  }
  try {
    return structuredClone(await run);
  } finally {
    if (state.inflight.get(userCacheKey) === run) {
      state.inflight.delete(userCacheKey);
    }
    if (ownsSharedInflight && state.inflight.get(sharedCacheKey) === run) {
      state.inflight.delete(sharedCacheKey);
    }
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
      useAi: upload.useAi,
    },
    { actor, orgId: deps.orgId },
  );

  const deadline = Date.now() + (deps.waitMs ?? DEFAULT_CV_WAIT_MS);
  let context = requested;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      context = await deps.runtime.query<HrCvExtractContext>(
        'hr.recruiting.cv_extract.context',
        {
          jobId,
          ...(upload.legalEntityId !== undefined ? { legalEntityId: upload.legalEntityId } : {}),
          ...(upload.openingId !== undefined ? { openingId: upload.openingId } : {}),
        },
        { actor, orgId: deps.orgId },
      );
      if (context.failedCode) {
        throw new DomainError(context.failedCode, 422, 'Không đọc được nội dung tệp CV');
      }
      if (context.resultKey && context.resultSha256) {
        return await finalizeExtractedResult({
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
    } catch (error) {
      if (error instanceof DomainError && error.status < 500) {
        throw error;
      }
      return {
        status: 'pending',
        jobId,
      };
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
  if (context.failedCode) {
    throw new DomainError(context.failedCode, 422, 'Không đọc được nội dung tệp CV');
  }
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
    useAi: context.useAi !== false && deps.useAi !== false,
    cvAi: deps.cvAi,
    runInAiScope: deps.runInAiScope,
  });
}
