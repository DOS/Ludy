// SPDX-License-Identifier: AGPL-3.0-only
// Native .docx -> tagged A4 PDF conversion job state via ludy_kernel.audit_event (#4721, Gate T12).
// Mirrors modules/hr/src/recruiting-intake.ts: API stages .docx to tmp/<orgId>/<sha256>, worker runs
// crove-extract('docx_to_pdf') and records output SHA-256 + pageCount + warnings + enum errorCode via sign.docx_convert.complete.
// Note: no PII/sensitive filenames or raw errorMessage strings are written to ludy_kernel.audit_event.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DOCX_TO_PDF_WARNINGS,
  EXTRACT_LIMITS,
  zDocxToPdfWarning,
  type DocxToPdfWarning,
} from '@ludy/extract-contract';
import { SIGN_SHA256_HEX_PATTERN, zId } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, tmpKey } from '@ludy/kernel-runtime';
import { SIGN_WRITERS, assertSystemCommand, assertSystemQuery, assertUserQuery, userIdOf } from './shared.ts';

export const SIGN_DOCX_MAX_BYTES = EXTRACT_LIMITS.maxSignDocxBytes;

const zSha256Hex = z.string().regex(SIGN_SHA256_HEX_PATTERN);

export function signDocxBlobKey(orgId: string, sha256: string): string {
  return tmpKey(orgId, sha256);
}

export function pdfFilenameFromDocx(rawFilename: string | null | undefined): string {
  const leaf = (rawFilename ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(/[\r\n\t\0]/g, '').trim();
  const base = cleaned.length > 0 ? cleaned.replace(/\.(docx|pdf)$/i, '') : 'hop-dong';
  const withExt = `${base || 'hop-dong'}.pdf`;
  return withExt.length <= 255 ? withExt : `${withExt.slice(0, 251)}.pdf`;
}

export const zSignDocxConvertRequestInput = z.strictObject({
  jobId: zId,
  sha256: zSha256Hex,
  sizeBytes: z.number().int().min(1).max(SIGN_DOCX_MAX_BYTES),
});

export const zSignDocxConvertCompleteInput = z.strictObject({
  jobId: zId,
  ok: z.boolean(),
  pdfSha256: zSha256Hex.nullable().optional(),
  pdfSizeBytes: z.number().int().min(1).max(EXTRACT_LIMITS.maxFileBytes).nullable().optional(),
  pageCount: z.number().int().min(1).max(EXTRACT_LIMITS.maxPdfSignPages).nullable().optional(),
  warnings: z.array(zDocxToPdfWarning).max(DOCX_TO_PDF_WARNINGS.length).optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
});

export const zSignDocxConvertStatusInput = z.strictObject({
  jobId: zId,
});

export const zSignDocxConvertPendingInput = z.strictObject({});

export interface SignDocxConvertStatus {
  status: 'pending' | 'completed' | 'failed';
  jobId: string;
  inputSha256: string;
  inputStorageKey: string;
  pdfSha256: string | null;
  pdfStorageKey: string | null;
  pdfSizeBytes: number | null;
  pageCount: number | null;
  warnings: DocxToPdfWarning[];
  errorCode: string | null;
}

export interface SignDocxConvertPendingJob {
  jobId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

function parseWarningsJson(raw: unknown): DocxToPdfWarning[] {
  const parsed = z.array(zDocxToPdfWarning).max(DOCX_TO_PDF_WARNINGS.length).safeParse(raw);
  return parsed.success ? [...new Set(parsed.data)] : [];
}

function parsePositiveInt(raw: string | null, max: number): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

export const signDocxConvertRequest = defineCommand({
  name: 'sign.docx_convert.request',
  input: zSignDocxConvertRequestInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: SIGN_WRITERS,
  writes: [],
  handler: async (ctx, input) => {
    const requestedBy = userIdOf(ctx);
    const storageKey = signDocxBlobKey(ctx.orgId, input.sha256);

    await ctx.emit('sign.docx_convert_queued', {
      jobId: input.jobId,
      storageKey,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
    });

    ctx.audit({
      jobId: input.jobId,
      requestedBy,
      inputSha256: input.sha256,
      sizeBytes: input.sizeBytes,
    });

    return {
      jobId: input.jobId,
      storageKey,
      requestedBy,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
    };
  },
});

export const signDocxConvertComplete = defineCommand({
  name: 'sign.docx_convert.complete',
  input: zSignDocxConvertCompleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [],
  handler: async (ctx, input): Promise<{ ok: true }> => {
    assertSystemCommand(ctx);

    // Terminal state per jobId is write-once so retries/dead-letter/apps_changed sweeps never overwrite an earlier completion.
    const existing = await sql<{ id: string }>`
      SELECT id::text AS id
      FROM ludy_kernel.audit_event
      WHERE org_id = ${ctx.orgId}::uuid
        AND command = 'sign.docx_convert.complete'
        AND detail ->> 'jobId' = ${input.jobId}
        AND outcome = 'ok'
        AND occurred_at >= pg_catalog.now() - interval '24 hours'
      ORDER BY id DESC
      LIMIT 1
    `.execute(ctx.trx);
    if (existing.rows.length > 0) {
      return { ok: true };
    }

    const warnings = input.warnings ? [...new Set(input.warnings)] : [];
    ctx.audit({
      jobId: input.jobId,
      ok: input.ok,
      pdfSha256: input.pdfSha256 ?? null,
      pdfSizeBytes: input.pdfSizeBytes ?? null,
      pageCount: input.pageCount ?? null,
      warnings,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    });
    return { ok: true };
  },
});

export const signDocxConvertStatus = defineQuery({
  name: 'sign.docx_convert.status',
  input: zSignDocxConvertStatusInput,
  access: SIGN_WRITERS,
  handler: async (ctx, input): Promise<SignDocxConvertStatus> => {
    assertUserQuery(ctx);
    const actorUserId = ctx.actor.type === 'user' ? ctx.actor.userId : '';

    const eventsRes = await sql<{
      command: string;
      requested_by: string | null;
      input_sha256: string | null;
      complete_ok: string | null;
      pdf_sha256: string | null;
      pdf_size_bytes: string | null;
      page_count: string | null;
      warnings_json: unknown;
      error_code: string | null;
    }>`
      SELECT
        command,
        detail ->> 'requestedBy' AS requested_by,
        detail ->> 'inputSha256' AS input_sha256,
        detail ->> 'ok' AS complete_ok,
        detail ->> 'pdfSha256' AS pdf_sha256,
        detail ->> 'pdfSizeBytes' AS pdf_size_bytes,
        detail ->> 'pageCount' AS page_count,
        detail -> 'warnings' AS warnings_json,
        detail ->> 'errorCode' AS error_code
      FROM ludy_kernel.audit_event
      WHERE org_id = ${ctx.orgId}::uuid
        AND command IN ('sign.docx_convert.request', 'sign.docx_convert.complete')
        AND detail ->> 'jobId' = ${input.jobId}
        AND outcome = 'ok'
        AND occurred_at >= pg_catalog.now() - interval '24 hours'
      ORDER BY id DESC
      LIMIT 10
    `.execute(ctx.trx);

    const req = eventsRes.rows.find((row) => row.command === 'sign.docx_convert.request');
    if (
      !req?.input_sha256 ||
      !SIGN_SHA256_HEX_PATTERN.test(req.input_sha256) ||
      !req.requested_by ||
      req.requested_by.toLowerCase() !== actorUserId.toLowerCase()
    ) {
      throw new DomainError('SIGN_DOCX_JOB_NOT_FOUND', 404, 'Không tìm thấy tác vụ chuyển đổi tệp Word này');
    }

    const inputStorageKey = signDocxBlobKey(ctx.orgId, req.input_sha256);
    const completeRow = eventsRes.rows.find((row) => row.command === 'sign.docx_convert.complete');

    if (!completeRow) {
      return {
        status: 'pending',
        jobId: input.jobId,
        inputSha256: req.input_sha256,
        inputStorageKey,
        pdfSha256: null,
        pdfStorageKey: null,
        pdfSizeBytes: null,
        pageCount: null,
        warnings: [],
        errorCode: null,
      };
    }

    const validPdfSha =
      completeRow.pdf_sha256 && SIGN_SHA256_HEX_PATTERN.test(completeRow.pdf_sha256)
        ? completeRow.pdf_sha256
        : null;
    const pageCount = parsePositiveInt(completeRow.page_count, EXTRACT_LIMITS.maxPdfSignPages);
    const pdfSizeBytes = parsePositiveInt(completeRow.pdf_size_bytes, EXTRACT_LIMITS.maxFileBytes);
    const warnings = parseWarningsJson(completeRow.warnings_json);

    if (completeRow.complete_ok === 'true' && validPdfSha && pageCount !== null && pdfSizeBytes !== null) {
      return {
        status: 'completed',
        jobId: input.jobId,
        inputSha256: req.input_sha256,
        inputStorageKey,
        pdfSha256: validPdfSha,
        pdfStorageKey: signDocxBlobKey(ctx.orgId, validPdfSha),
        pdfSizeBytes,
        pageCount,
        warnings,
        errorCode: null,
      };
    }

    return {
      status: 'failed',
      jobId: input.jobId,
      inputSha256: req.input_sha256,
      inputStorageKey,
      pdfSha256: null,
      pdfStorageKey: null,
      pdfSizeBytes: null,
      pageCount: null,
      warnings: [],
      errorCode: completeRow.error_code ?? 'SIGN_DOCX_CONVERT_FAILED',
    };
  },
});

export const signDocxConvertPending = defineQuery({
  name: 'sign.docx_convert.pending',
  input: zSignDocxConvertPendingInput,
  access: 'system',
  handler: async (ctx): Promise<SignDocxConvertPendingJob[]> => {
    assertSystemQuery(ctx);
    const res = await sql<{
      job_id: string | null;
      input_sha256: string | null;
      size_bytes: string | null;
    }>`
      SELECT
        r.detail ->> 'jobId' AS job_id,
        r.detail ->> 'inputSha256' AS input_sha256,
        r.detail ->> 'sizeBytes' AS size_bytes
      FROM ludy_kernel.audit_event r
      WHERE r.org_id = ${ctx.orgId}::uuid
        AND r.command = 'sign.docx_convert.request'
        AND r.outcome = 'ok'
        AND r.occurred_at >= pg_catalog.now() - interval '24 hours'
        AND NOT EXISTS (
          SELECT 1
          FROM ludy_kernel.audit_event c
          WHERE c.org_id = r.org_id
            AND c.command = 'sign.docx_convert.complete'
            AND c.outcome = 'ok'
            AND c.detail ->> 'jobId' = r.detail ->> 'jobId'
        )
      ORDER BY r.id ASC
      LIMIT 50
    `.execute(ctx.trx);

    const out: SignDocxConvertPendingJob[] = [];
    for (const row of res.rows) {
      if (!row.job_id || !row.input_sha256 || !SIGN_SHA256_HEX_PATTERN.test(row.input_sha256)) continue;
      const sizeBytes = Number(row.size_bytes ?? 0);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > SIGN_DOCX_MAX_BYTES) continue;
      out.push({
        jobId: row.job_id,
        storageKey: signDocxBlobKey(ctx.orgId, row.input_sha256),
        sha256: row.input_sha256,
        sizeBytes,
      });
    }
    return out;
  },
});

export const signDocxConvertCommands = [signDocxConvertRequest, signDocxConvertComplete];
export const signDocxConvertQueries = [signDocxConvertStatus, signDocxConvertPending];
