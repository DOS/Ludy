// SPDX-License-Identifier: AGPL-3.0-only
// HTTP upload & poll helpers for sandboxed HR CV PDF/DOCX extraction (#4446 Stage 5D, T12).
// Never parses untrusted PDF/DOCX bytes in the API process: only validates magic header bytes,
// stages raw bytes into BlobStore tmp/<orgId>/<sha256>, triggers worker crove-extract via outbox,
// waits briefly (or returns 202 pending for poll), and enriches with optional metered Ly proposal draft.
import { randomUUID } from 'node:crypto';
import {
  HR_CV_MAX_BYTES,
  zHrCvExtractContextInput,
  type HrCvExtractResponse,
} from '@ludy/kernel-contract';
import { DomainError, sha256Hex, type BlobStore, type Runtime, type UserActor } from '@ludy/kernel-runtime';
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
const DEFAULT_CV_WAIT_MS = 12_000;
const POLL_INTERVAL_MS = 100;

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
  const rawBody = await readBoundedStream(req.body, HR_CV_MAX_BYTES + 128 * 1024);
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
  lang: 'vi' | 'en';
  useAi: boolean;
  cvAi: RecruitingCvAi;
  runInAiScope: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<HrCvExtractResponse> {
  const bytes = await deps.store.get(deps.resultKey);
  await Promise.allSettled([deps.store.delete(deps.resultKey), deps.store.delete(deps.context.storageKey)]);

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

  return {
    status: 'ready',
    jobId: deps.context.jobId,
    draft,
  };
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
  const upload = await readCvUploadForm(deps.req);
  const { kind, contentType } = classifyCvUpload(upload.bytes, upload.rawName, upload.declaredType);
  const jobId = randomUUID();
  const sha256 = sha256Hex(upload.bytes);
  const storageKey = hrCvBlobKey(deps.orgId, sha256);

  await deps.store.put(storageKey, upload.bytes, contentType);
  let requested: HrCvExtractContext;
  try {
    requested = await deps.runtime.execute<HrCvExtractContext>(
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
  } catch (error) {
    await deps.store.delete(storageKey).catch(() => undefined);
    throw error;
  }

  const deadline = Date.now() + (deps.waitMs ?? DEFAULT_CV_WAIT_MS);
  let context = requested;
  while (Date.now() < deadline) {
    context = await deps.runtime.query<HrCvExtractContext>(
      'hr.recruiting.cv_extract.context',
      {
        jobId,
        ...(upload.legalEntityId !== undefined ? { legalEntityId: upload.legalEntityId } : {}),
        ...(upload.openingId !== undefined ? { openingId: upload.openingId } : {}),
      },
      { actor, orgId: deps.orgId },
    );
    if (context.resultKey) {
      return finalizeExtractedResult({
        runtime: deps.runtime,
        store: deps.store,
        orgId: deps.orgId,
        actor,
        context,
        resultKey: context.resultKey,
        lang: upload.lang,
        useAi: upload.useAi,
        cvAi: deps.cvAi,
        runInAiScope: deps.runInAiScope,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
  const parsed = zHrCvExtractContextInput.safeParse({
    jobId: deps.jobId,
    ...(deps.openingId ? { openingId: deps.openingId } : {}),
    ...(deps.legalEntityId ? { legalEntityId: deps.legalEntityId } : {}),
  });
  if (!parsed.success) {
    throw new DomainError('HR_CV_JOB_NOT_FOUND', 404, 'Không tìm thấy yêu cầu tách CV này');
  }
  const actor = actorOf(deps.user);
  const context = await deps.runtime.query<HrCvExtractContext>('hr.recruiting.cv_extract.context', parsed.data, {
    actor,
    orgId: deps.orgId,
  });
  if (!context.resultKey) {
    return { status: 'pending', jobId: context.jobId };
  }
  return finalizeExtractedResult({
    runtime: deps.runtime,
    store: deps.store,
    orgId: deps.orgId,
    actor,
    context,
    resultKey: context.resultKey,
    lang: deps.lang ?? 'vi',
    useAi: deps.useAi !== false,
    cvAi: deps.cvAi,
    runInAiScope: deps.runInAiScope,
  });
}
