// SPDX-License-Identifier: AGPL-3.0-only
// Worker handler for eSign native .docx -> tagged A4 PDF conversion (#4721, Gate T12).
// Runs crove-extract('docx_to_pdf') outside the API process, checks ADR-0053 org_app_on('sign'), verifies input/output
// hashes and %PDF- magic bytes, writes converted PDF to tmp/<orgId>/<pdfSha256>, and records sign.docx_convert.complete
// using a closed non-PII errorCode enum (never writing raw document text or errorMessage into audit_event).
import { EXTRACT_LIMITS, ExtractServiceError, type ExtractClient } from '@ludy/extract-contract';
import {
  BlobIntegrityError,
  BlobNotFoundError,
  BlobTooLargeError,
  DomainError,
  contentGeneration,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@ludy/kernel-runtime';
import { SIGN_DOCX_MAX_BYTES, signDocxBlobKey } from '@ludy/mod-sign';

const SYSTEM = { type: 'system' as const, component: 'sign.docx_convert' };
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export const SIGN_DOCX_RETRY_LIMIT = 1;

export interface SignDocxConvertJob {
  orgId: string;
  targetKind: 'docx_convert';
  jobId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

export function isSignDocxConvertJob(job: unknown): job is SignDocxConvertJob {
  return job !== null && typeof job === 'object' && 'targetKind' in job && (job as { targetKind?: unknown }).targetKind === 'docx_convert';
}

function isPermanentError(error: unknown): boolean {
  if (error instanceof DomainError) return true;
  return error instanceof BlobNotFoundError || error instanceof BlobTooLargeError || error instanceof BlobIntegrityError;
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, idx) => bytes[idx] === b);
}

function classifyExtractFailureCode(code: string, message: string): string {
  if (code === 'too_large') return 'TOO_LARGE';
  const lower = message.toLowerCase();
  if (lower.includes('track changes') || lower.includes('theo dõi thay đổi')) return 'SIGN_DOCX_TRACK_CHANGES';
  if (lower.includes('hidden text') || lower.includes('văn bản ẩn')) return 'SIGN_DOCX_HIDDEN_TEXT';
  if (lower.includes('mật khẩu') || lower.includes('mã hóa')) return 'SIGN_DOCX_ENCRYPTED';
  if (lower.includes('khai báo xml không an toàn')) return 'SIGN_DOCX_UNSAFE_XML';
  if (lower.includes('200 trang')) return 'SIGN_DOCX_TOO_MANY_PAGES';
  if (code === 'invalid') return 'SIGN_DOCX_INVALID';
  return 'SIGN_DOCX_CONVERT_FAILED';
}

async function recordFailureBestEffort(
  runtime: Pick<Runtime, 'execute'>,
  orgId: string,
  jobId: string,
  errorCode: string,
): Promise<void> {
  try {
    await runtime.execute(
      'sign.docx_convert.complete',
      {
        jobId,
        ok: false,
        pdfSha256: null,
        errorCode,
      },
      { actor: SYSTEM, orgId, idempotencyKey: `sign-docx-complete:${jobId}` },
    );
  } catch (error: unknown) {
    if (error instanceof DomainError && (error.code === 'MODULE_OFF' || error.code === 'FORBIDDEN' || error.status === 404)) {
      return;
    }
    throw error;
  }
}

export async function runSignDocxConvertJob(
  deps: { runtime: Pick<Runtime, 'execute' | 'appOn'>; store: BlobStore; extract: ExtractClient },
  job: SignDocxConvertJob,
  retryCount = 0,
): Promise<{ status: 'skipped_app_off' | 'completed' | 'failed'; pdfSha256?: string; errorCode?: string }> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    return { status: 'skipped_app_off' };
  }

  try {
    const expectedKey = signDocxBlobKey(job.orgId, job.sha256);
    if (job.storageKey !== expectedKey) {
      throw new DomainError('SIGN_DOCX_INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ tệp Word không hợp lệ');
    }
    if (!Number.isSafeInteger(job.sizeBytes) || job.sizeBytes <= 0 || job.sizeBytes > SIGN_DOCX_MAX_BYTES) {
      throw new DomainError('TOO_LARGE', 413, 'Tệp Word (.docx) vượt quá giới hạn 10 MB');
    }

    const inputBytes = await readVerified(
      deps.store,
      { key: expectedKey, generation: contentGeneration(job.sha256), sha256: job.sha256 },
      SIGN_DOCX_MAX_BYTES,
    );
    if (inputBytes.byteLength !== job.sizeBytes) {
      throw new DomainError('SIGN_DOCX_SIZE_MISMATCH', 422, 'Kích thước tệp Word không khớp bản ghi');
    }

    const extracted = await deps.extract.extract('docx_to_pdf', inputBytes);
    if (!extracted.ok) {
      if ((extracted.code === 'timeout' || extracted.code === 'memory') && retryCount < SIGN_DOCX_RETRY_LIMIT) {
        throw new ExtractServiceError('unavailable', `crove-extract ${extracted.code}`);
      }
      const mappedCode = classifyExtractFailureCode(extracted.code, extracted.message || '');
      throw new DomainError(mappedCode, mappedCode === 'TOO_LARGE' ? 413 : 422, 'Không thể chuyển đổi tệp Word (.docx) sang PDF');
    }

    const pdfBytes = Buffer.from(extracted.pdfBase64, 'base64');
    if (pdfBytes.byteLength === 0 || pdfBytes.byteLength > EXTRACT_LIMITS.maxFileBytes || !hasPdfMagic(pdfBytes)) {
      throw new DomainError('SIGN_DOCX_INVALID_OUTPUT', 422, 'Tệp PDF tạo ra không hợp lệ hoặc vượt giới hạn 25 MB');
    }

    const pdfSha256 = sha256Hex(pdfBytes);
    const pdfKey = signDocxBlobKey(job.orgId, pdfSha256);
    await deps.store.put(pdfKey, pdfBytes, 'application/pdf');

    await deps.runtime.execute(
      'sign.docx_convert.complete',
      {
        jobId: job.jobId,
        ok: true,
        pdfSha256,
        pdfSizeBytes: pdfBytes.byteLength,
        pageCount: extracted.pageCount,
        warnings: extracted.warnings,
      },
      { actor: SYSTEM, orgId: job.orgId, idempotencyKey: `sign-docx-complete:${job.jobId}` },
    );

    return { status: 'completed', pdfSha256 };
  } catch (error: unknown) {
    if (!isPermanentError(error) && retryCount < SIGN_DOCX_RETRY_LIMIT) {
      throw error;
    }

    const errorCode =
      error instanceof BlobNotFoundError
        ? 'SIGN_DOCX_SOURCE_MISSING'
        : error instanceof BlobTooLargeError
          ? 'TOO_LARGE'
          : error instanceof DomainError
            ? error.code
            : 'SIGN_DOCX_CONVERT_FAILED';

    await recordFailureBestEffort(deps.runtime, job.orgId, job.jobId, errorCode);
    return { status: 'failed', errorCode };
  }
}
