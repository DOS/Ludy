// SPDX-License-Identifier: AGPL-3.0-only
// Worker-side sandboxed CV PDF/DOCX extraction (#4446 Stage 5D, T12):
// runs ONLY in the worker process (which holds EXTRACT_URL), fetches raw CV bytes from BlobStore,
// parses plain text exclusively through crove-extract (pdf_text / docx_text), writes bounded result JSON
// to content-addressed tmp/<orgId>/<resultSha256>, and records the result hash via hr.recruiting.cv_extract.complete.
import type { ExtractClient } from '@ludy/extract-contract';
import { DomainError, sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { extractCvTextInSandbox, hrCvBlobKey, type CvSandboxKind } from '@ludy/mod-hr';

const SYSTEM = { type: 'system' as const, component: 'hr.cv_extract' };

export interface HrCvExtractJob {
  orgId: string;
  jobId: string;
  storageKey: string;
  kind: CvSandboxKind;
  sha256: string;
  sizeBytes: number;
}

export interface HrCvExtractStoredResult {
  jobId: string;
  ok: boolean;
  kind: CvSandboxKind;
  text?: string;
  errorCode?: string;
  errorMessage?: string;
}

export async function runHrCvExtractJob(
  deps: { runtime: Pick<Runtime, 'execute' | 'appOn'>; store: BlobStore; extract: ExtractClient },
  job: HrCvExtractJob,
): Promise<HrCvExtractStoredResult> {
  if (!(await deps.runtime.appOn(job.orgId, 'hr', { fresh: true }))) {
    return { jobId: job.jobId, ok: false, kind: job.kind, errorCode: 'MODULE_OFF', errorMessage: 'Mô-đun Nhân sự đang tắt' };
  }
  const expectedKey = hrCvBlobKey(job.orgId, job.sha256);
  if (job.storageKey !== expectedKey) {
    throw new DomainError('INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ tệp CV không hợp lệ');
  }

  let stored: HrCvExtractStoredResult;
  try {
    const bytes = await deps.store.get(job.storageKey, null, job.sizeBytes);
    if (bytes.byteLength !== job.sizeBytes || sha256Hex(bytes) !== job.sha256) {
      throw new DomainError('HR_CV_INTEGRITY', 422, 'Nội dung tệp CV không khớp chữ ký lưu trữ');
    }
    const extracted = await extractCvTextInSandbox({
      extract: deps.extract,
      kind: job.kind,
      bytes,
    });
    stored = {
      jobId: job.jobId,
      ok: true,
      kind: extracted.kind,
      text: extracted.text,
    };
  } catch (error: unknown) {
    const errorCode = error instanceof DomainError ? error.code : 'HR_CV_EXTRACT_FAILED';
    const errorMessage = error instanceof DomainError ? error.message : 'Không đọc được nội dung tệp CV';
    stored = {
      jobId: job.jobId,
      ok: false,
      kind: job.kind,
      errorCode,
      errorMessage,
    };
  }

  const encoded = new TextEncoder().encode(JSON.stringify(stored));
  const resultSha256 = sha256Hex(encoded);
  const resultKey = hrCvBlobKey(job.orgId, resultSha256);
  await deps.store.put(resultKey, encoded, 'application/json');
  await deps.runtime.execute(
    'hr.recruiting.cv_extract.complete',
    {
      jobId: job.jobId,
      ok: stored.ok,
      resultSha256,
    },
    { actor: SYSTEM, orgId: job.orgId },
  );

  return stored;
}
