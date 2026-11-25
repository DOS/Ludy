// SPDX-License-Identifier: AGPL-3.0-only
// Shared eSign .pdf / .docx validation + calm conversion status/warning banner (#4721).
import { useTranslations } from 'use-intl';
import { MAX_UPLOAD_BYTES, SIGN_DOCX_TO_PDF_WARNINGS } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import {
  SIGN_DOCX_MAX_BYTES,
  isSignDocxFile,
  looksLikeOle2Bytes,
  looksLikeZipBytes,
  type SignDocxConvertCompletedResult,
  type SignDocxToPdfWarning,
} from '../../lib/sign-api.ts';
import { looksLikePdfBytes } from '../../lib/sign-pdf.ts';

export type DocxConversionStatus = 'idle' | 'converting' | 'ready' | 'error';

const ENVELOPE_DOCX_WARNINGS_STORAGE_KEY = 'ludy.sign.created_docx_warnings';
const MAX_STORED_DOCX_NOTICES = 20;
const DOCX_NOTICE_TTL_MS = 24 * 60 * 60_000;
const ALLOWED_DOCX_WARNINGS = new Set<string>(SIGN_DOCX_TO_PDF_WARNINGS);

interface StoredDocxWarningNotice {
  envelopeId: string;
  warnings: SignDocxToPdfWarning[];
  createdAt: number;
}

const fallbackDocxNotices = new Map<string, StoredDocxWarningNotice>();
const fallbackDismissedIds = new Set<string>();

function sanitizeDocxWarnings(raw: readonly unknown[]): SignDocxToPdfWarning[] {
  const seen = new Set<SignDocxToPdfWarning>();
  for (const item of raw) {
    if (typeof item === 'string' && ALLOWED_DOCX_WARNINGS.has(item)) {
      seen.add(item as SignDocxToPdfWarning);
    }
  }
  return [...seen];
}

function getDocxNoticeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readFallbackDocxNotices(now: number): StoredDocxWarningNotice[] {
  const valid: StoredDocxWarningNotice[] = [];
  for (const [key, entry] of fallbackDocxNotices) {
    if (now - entry.createdAt > DOCX_NOTICE_TTL_MS || now < entry.createdAt || entry.warnings.length === 0) {
      fallbackDocxNotices.delete(key);
    } else {
      valid.push(entry);
    }
  }
  return valid;
}

function readRawStorageNotices(storage: Storage, now: number): StoredDocxWarningNotice[] {
  try {
    const raw = storage.getItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const byId = new Map<string, StoredDocxWarningNotice>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Partial<StoredDocxWarningNotice>;
      if (typeof rec.envelopeId !== 'string' || !rec.envelopeId || typeof rec.createdAt !== 'number' || !Array.isArray(rec.warnings)) {
        continue;
      }
      if (now - rec.createdAt > DOCX_NOTICE_TTL_MS || now < rec.createdAt) continue;
      const warnings = sanitizeDocxWarnings(rec.warnings);
      if (warnings.length === 0) continue;
      byId.set(rec.envelopeId, { envelopeId: rec.envelopeId, warnings, createdAt: rec.createdAt });
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

function readStoredDocxNotices(now: number): StoredDocxWarningNotice[] {
  const byId = new Map<string, StoredDocxWarningNotice>();
  const storage = getDocxNoticeStorage();
  if (storage) {
    for (const entry of readRawStorageNotices(storage, now)) {
      if (!fallbackDismissedIds.has(entry.envelopeId)) {
        byId.set(entry.envelopeId, entry);
      }
    }
  }
  for (const fb of readFallbackDocxNotices(now)) {
    byId.set(fb.envelopeId, fb);
  }
  return [...byId.values()];
}

function tryPersistDocxNotices(storage: Storage, entries: readonly StoredDocxWarningNotice[]): boolean {
  const bounded = entries.slice(-MAX_STORED_DOCX_NOTICES);
  try {
    if (bounded.length === 0) {
      storage.removeItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
    } else {
      storage.setItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY, JSON.stringify(bounded));
    }
    return true;
  } catch {
    return false;
  }
}

/** Persists post-creation .docx warnings for an envelope across detail navigation until explicitly dismissed (#4729). */
export function saveCreatedDocxWarnings(
  envelopeId: string,
  warnings: readonly SignDocxToPdfWarning[],
  now = Date.now(),
): void {
  if (!envelopeId) return;
  const clean = sanitizeDocxWarnings(warnings);
  if (clean.length === 0) {
    clearCreatedDocxWarnings(envelopeId, now);
    return;
  }
  const nextEntry: StoredDocxWarningNotice = { envelopeId, warnings: clean, createdAt: now };
  const merged = readStoredDocxNotices(now).filter((entry) => entry.envelopeId !== envelopeId);
  merged.push(nextEntry);
  const storage = getDocxNoticeStorage();
  if (storage && tryPersistDocxNotices(storage, merged)) {
    fallbackDocxNotices.clear();
    fallbackDismissedIds.clear();
    return;
  }
  // Preserve existing sessionStorage records intact if setItem throws (e.g. QuotaExceededError);
  // store only the unpersisted update in bounded memory for this tab.
  fallbackDismissedIds.delete(envelopeId);
  fallbackDocxNotices.delete(envelopeId);
  fallbackDocxNotices.set(envelopeId, nextEntry);
  while (fallbackDocxNotices.size > MAX_STORED_DOCX_NOTICES) {
    const oldestKey = fallbackDocxNotices.keys().next().value;
    if (oldestKey === undefined) break;
    fallbackDocxNotices.delete(oldestKey);
  }
}

/** Reads persisted post-creation .docx warnings for an envelope without consuming them so they survive until dismissed. */
export function readCreatedDocxWarnings(envelopeId: string, now = Date.now()): SignDocxToPdfWarning[] {
  if (!envelopeId) return [];
  const entries = readStoredDocxNotices(now);
  const match = entries.find((entry) => entry.envelopeId === envelopeId);
  return match ? [...match.warnings] : [];
}

/** Clears persisted post-creation .docx warnings after the user dismisses DocxWarningsAlert. */
export function clearCreatedDocxWarnings(envelopeId: string, now = Date.now()): void {
  if (!envelopeId) return;
  fallbackDocxNotices.delete(envelopeId);
  const storage = getDocxNoticeStorage();
  if (!storage) {
    fallbackDismissedIds.add(envelopeId);
    return;
  }
  const remainingMerged = readStoredDocxNotices(now).filter((entry) => entry.envelopeId !== envelopeId);
  if (tryPersistDocxNotices(storage, remainingMerged)) {
    fallbackDocxNotices.clear();
    fallbackDismissedIds.clear();
    return;
  }
  // Shrink storage separately so dismissing an already-persisted entry still survives reloads under write quota pressure.
  const rawStorage = readRawStorageNotices(storage, now);
  const remainingStorage = rawStorage.filter((entry) => entry.envelopeId !== envelopeId);
  if (tryPersistDocxNotices(storage, remainingStorage)) {
    fallbackDismissedIds.delete(envelopeId);
  } else if (rawStorage.some((entry) => entry.envelopeId === envelopeId)) {
    fallbackDismissedIds.add(envelopeId);
  }
}

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
