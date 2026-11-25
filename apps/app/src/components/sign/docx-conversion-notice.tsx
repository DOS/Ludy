// SPDX-License-Identifier: AGPL-3.0-only
// Shared eSign .pdf / .docx validation + calm conversion status/warning banner (#4721).
import { useTranslations } from 'use-intl';
import { MAX_UPLOAD_BYTES } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import {
  SIGN_DOCX_MAX_BYTES,
  isSignDocxFile,
  looksLikeOle2Bytes,
  looksLikeZipBytes,
  type SignDocxConvertCompletedResult,
  type SignDocxToPdfWarning,
} from '../../lib/sign-api.ts';
import {
  clearAllCreatedDocxWarnings,
  clearCreatedDocxWarnings,
  readCreatedDocxWarnings,
  saveCreatedDocxWarnings,
  type CreatedDocxWarningScope,
} from '../../lib/sign-docx-notices.ts';
import { looksLikePdfBytes } from '../../lib/sign-pdf.ts';

export type DocxConversionStatus = 'idle' | 'converting' | 'ready' | 'error';

export {
  clearAllCreatedDocxWarnings,
  clearCreatedDocxWarnings,
  readCreatedDocxWarnings,
  saveCreatedDocxWarnings,
  type CreatedDocxWarningScope,
};

export type SignFileCheckResult =
  | { ok: true; kind: 'pdf'; fallbackTitle: string }
  | { ok: true; kind: 'docx'; fallbackTitle: string }
  | { ok: false; errorKey: 'pdfInvalidType' | 'pdfTooLarge' | 'docxEmpty' | 'docxTooLarge' | 'docxInvalidType' | 'docxOle2Unsupported' };

export async function inspectSelectedSignUploadFile(file: File): Promise<SignFileCheckResult> {
  if (isSignDocxFile(file)) {
    if (file.size === 0) return { ok: false, errorKey: 'docxEmpty' };
    if (file.size > SIGN_DOCX_MAX_BYTES) return { ok: false, errorKey: 'docxTooLarge' };
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (looksLikeOle2Bytes(head)) return { ok: false, errorKey: 'docxOle2Unsupported' };
    if (!looksLikeZipBytes(head)) return { ok: false, errorKey: 'docxInvalidType' };
    return { ok: true, kind: 'docx', fallbackTitle: file.name.replace(/\.docx$/i, '') };
  }

  const lowerName = file.name.trim().toLowerCase();
  if (lowerName.endsWith('.doc')) {
    return { ok: false, errorKey: 'docxOle2Unsupported' };
  }
  if (file.type && file.type !== 'application/pdf') {
    return { ok: false, errorKey: 'pdfInvalidType' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, errorKey: 'pdfTooLarge' };
  }
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!looksLikePdfBytes(head)) {
    return { ok: false, errorKey: 'pdfInvalidType' };
  }
  return { ok: true, kind: 'pdf', fallbackTitle: file.name.replace(/\.pdf$/i, '') };
}

export function DocxWarningsAlert({
  warnings,
  onDismiss,
}: {
  warnings: readonly SignDocxToPdfWarning[];
  onDismiss?: () => void;
}) {
  const t = useTranslations('sign');
  const common = useTranslations('common');
  if (warnings.length === 0) return null;

  return (
    <Alert data-testid="sign-docx-warning-banner">
      <AlertDescription className="space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium text-foreground">{t('docxWarningBanner')}</p>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={common('close')}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-base text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {warnings.map((w) => (
            <li key={w}>{t(`docxWarnings.${w}`)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function DocxConversionNotice({
  status,
  result,
}: {
  status: DocxConversionStatus;
  result: SignDocxConvertCompletedResult | null;
}) {
  const t = useTranslations('sign');

  if (status === 'converting') {
    return (
      <Alert role="status" aria-live="polite" data-testid="sign-docx-converting">
        <AlertDescription>{t('docxConverting')}</AlertDescription>
      </Alert>
    );
  }

  if (status === 'ready' && result) {
    return (
      <div className="space-y-2">
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
          data-testid="sign-docx-converted-ready"
        >
          {t('docxConvertedReady', { pages: String(result.pageCount), filename: result.filename })}
        </p>
        <DocxWarningsAlert warnings={result.warnings} />
      </div>
    );
  }

  return null;
}
