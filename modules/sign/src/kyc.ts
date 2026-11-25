// SPDX-License-Identifier: AGPL-3.0-only
// Sender-side Signer KYC Attachment Verification Check (Slice 5e, #4443).
// - Workspace-authenticated members only (never exposed on public /-/sign routes).
// - Enforces assertCanAccessEnvelopeRow, assertCanAccessMeetingMinutesEnvelopeRow, and
//   ludy_sign.can_read_sign_file(field.attachment_file_id) before reading metadata/bytes or running AI (404 parity).
// - 100% AI-off deterministic flow: verifies MIME, size, and SHA-256 on PDF/PNG/JPEG attachments, extracts Vietnamese
//   Tax IDs (MST 10/13 digits), CCCD (12 digits), and signer/entity name matches from crove-extract pdf_inspect or
//   extracted PDF pages, and supports human confirmation ('matched' / 'mismatch' / 'needs_review').
// - Optional metered Vy proposals ('sign.kyc_check') remain tainted ('needs_review', proposedByAi: true) with zero auto-reject.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  SIGN_ATTACHMENT_CONTENT_TYPES,
  type MemberRole,
  type SignAttachmentContentType,
  type SignKycCheckMode,
  type SignKycCheckStatus,
} from '@ludy/db';
import {
  SIGN_ATTACHMENT_MAX_BYTES,
  SIGN_KYC_AI_CATEGORIES,
  SIGN_KYC_DOC_KINDS,
  SIGN_KYC_FINDING_CATEGORIES,
  SIGN_KYC_ITEM_STATUSES,
  SIGN_MAX_PAGES,
  SIGN_SHA256_HEX_PATTERN,
  tableWrite,
  zId,
  zSignKycConfirmInput,
  zSignKycPageTextInput,
  zSignKycRunDeterministicInput,
  type SignKycAiCategoryContract,
  type SignKycAiDiscrepancyContract,
  type SignKycAiProposalContract,
  type SignKycAttachmentSlotContract,
  type SignKycCheckRecordContract,
  type SignKycDeterministicItemContract,
  type SignKycDocKindContract,
  type SignKycFindingCategoryContract,
  type SignKycFindingsContract,
  type SignKycItemStatusContract,
  type SignKycListResultContract,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import { isSignAiStoppedOnTrx, type SignAiExtractedPage } from './ai.ts';
import { assertCanAccessEnvelopeRow } from './hr-visibility.ts';
import { signManifest } from './manifest.ts';
import { assertCanAccessMeetingMinutesEnvelopeRow } from './meeting-visibility.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const FORMAT_CONTROL_RE = /\p{Cf}+/gu;
const ATTACHMENT_MIME_SET: ReadonlySet<string> = new Set(SIGN_ATTACHMENT_CONTENT_TYPES);
const DOC_KIND_SET: ReadonlySet<string> = new Set(SIGN_KYC_DOC_KINDS);
const ITEM_STATUS_SET: ReadonlySet<string> = new Set(SIGN_KYC_ITEM_STATUSES);
const FINDING_CATEGORY_SET: ReadonlySet<string> = new Set(SIGN_KYC_FINDING_CATEGORIES);
const AI_CATEGORY_SET: ReadonlySet<string> = new Set(SIGN_KYC_AI_CATEGORIES);

const LABELED_MST_RE =
  /(?:mã\s*số\s*(?:thuế|doanh\s*nghiệp)|ma\s*so\s*(?:thue|doanh\s*nghiep)|\bmst\b|\bmsdn\b|tax\s*(?:code|id))[\s():#-]*(\d{10}(?:-\d{3})?)(?!\d)/giu;
const BRANCH_MST_RE = /(?<!\d)(\d{10}-\d{3})(?!\d)/g;
const LABELED_CCCD_RE =
  /(?:căn\s*cước(?:\s*công\s*dân)?|can\s*cuoc(?:\s*cong\s*dan)?|\bcccd\b|\bcmnd\b|(?:số\s*định\s*danh(?:\s*cá\s*nhân)?|so\s*dinh\s*danh(?:\s*ca\s*nhan)?)(?:[\s(]*(?:cccd|cmnd)[\s)]*)?|id\s*(?:no|number|card))[\s():#-]*?(0\d{11})(?!\d)/giu;
const STANDALONE_CCCD_RE = /(?<!\d)(0\d{11})(?!\d)/g;

const EXPLICIT_REP_LINE_RE =
  /(?:người\s*đại\s*diện(?:\s*theo\s*pháp\s*luật)?|nguoi\s*dai\s*dien(?:\s*theo\s*phap\s*luat)?|họ\s*(?:và\s*)?tên|ho\s*(?:va\s*)?ten|bên\s*nhận\s*ủy\s*quyền|ben\s*nhan\s*uy\s*quyen)\s*[:#-]?\s*([^\r\n]{2,120})/giu;
const EXPLICIT_ENTITY_LINE_RE =
  /(?:tên\s*(?:công\s*ty|doanh\s*nghiệp(?:\s*viết\s*bằng\s*tiếng\s*việt)?)|ten\s*(?:cong\s*ty|doanh\s*nghiep))\s*[:#-]?\s*([^\r\n]{3,200})/giu;

const target = <T extends { fieldId: string }>(input: T) => ({
  type: 'sign.kyc_check',
  id: input.fieldId,
});

const KYC_CHECK_UPSERT_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'kyc_check', [
  'org_id',
  'envelope_id',
  'field_id',
  'file_id',
  'file_sha256',
  'status',
  'mode',
  'findings_json',
  'checked_by',
  'checked_at',
  'updated_at',
]);

export interface SignKycSource {
  envelopeId: string;
  envelopeTitle: string;
  envelopeStatus: string;
  fieldId: string;
  fieldLabel: string | null;
  signerId: string;
  signerName: string;
  signerRoleLabel: string;
  fileId: string;
  filename: string;
  contentType: SignAttachmentContentType;
  sizeBytes: number;
  fileSha256: string;
  storageKey: string;
  generation: string;
  sha256Verified: boolean;
  obligationCounterpartyName: string | null;
  storedTextPreview: string | null;
  storedPageCount: number | null;
  aiStopped: boolean;
}

export interface SignKycInspectJobData {
  envelopeId: string;
  fieldId: string;
  fileId: string;
  fileSha256: string;
  storageKey: string;
  generation: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DeterministicKycEvalInput {
  fieldLabel: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentSha256: string;
  storedFileSha256: string;
  signerName: string;
  obligationCounterpartyName: string | null;
  expectedSignerName?: string | null | undefined;
  expectedEntityName?: string | null | undefined;
  expectedTaxCode?: string | null | undefined;
  pages?: readonly SignAiExtractedPage[] | null | undefined;
  inspectState: 'pending' | 'inspected' | 'image_metadata_only' | 'failed';
  inspectError?: string | null | undefined;
  existingAiProposal?: SignKycAiProposalContract | null | undefined;
  existingManualNote?: string | null | undefined;
}

export interface DeterministicKycEvalResult {
  status: SignKycCheckStatus;
  findings: SignKycFindingsContract;
}

function stripFormatControl(value: string): string {
  return value.replace(FORMAT_CONTROL_RE, '');
}

function cleanLine(value: string, max: number): string {
  const one = stripFormatControl(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('').trimEnd();
}

export function normalizeFoldedVi(value: string): string {
  return stripFormatControl(value)
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTaxCodeInput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripFormatControl(raw).trim().replace(/\s+/g, '');
  if (!cleaned) return null;
  return cleanLine(cleaned, 32);
}

function matchDocKindProbe(probe: string): SignKycDocKindContract | null {
  if (/\b(?:uy quyen|giay gioi thieu|power of attorney|\bpoa\b)\b/.test(probe)) {
    return 'poa';
  }
  if (/\b(?:dkkd|dang ky kinh doanh|dang ky doanh nghiep|giay chung nhan dang ky|enterprise registration)\b/.test(probe)) {
    return 'dkkd';
  }
  if (/\b(?:cccd|cmnd|can cuoc|chung minh nhan dan|so dinh danh|citizen id)\b/.test(probe)) {
    return 'cccd';
  }
  return null;
}

export function detectKycDocumentKind(
  label: string | null | undefined,
  filename: string | null | undefined,
  text?: string | null | undefined,
): SignKycDocKindContract {
  const headerKind = matchDocKindProbe(normalizeFoldedVi([label ?? '', filename ?? ''].join(' ')));
  if (headerKind) return headerKind;
  if (text) {
    const textKind = matchDocKindProbe(normalizeFoldedVi(text.slice(0, 1200)));
    if (textKind) return textKind;
  }
  return 'other';
}

export function extractVietnamTaxCodes(rawText: string): string[] {
  const cleaned = stripFormatControl(rawText);
  const found = new Set<string>();
  for (const m of cleaned.matchAll(LABELED_MST_RE)) {
    if (m[1]) found.add(m[1]);
  }
  for (const m of cleaned.matchAll(BRANCH_MST_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].slice(0, 10);
}

export function extractVietnamNationalIds(rawText: string): string[] {
  const cleaned = stripFormatControl(rawText);
  const found = new Set<string>();
  for (const m of cleaned.matchAll(LABELED_CCCD_RE)) {
    if (m[1]) found.add(m[1]);
  }
  for (const m of cleaned.matchAll(STANDALONE_CCCD_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].slice(0, 10);
}

function hasExplicitDifferentValue(rawText: string, pattern: RegExp, expectedFolded: string): string | null {
  for (const m of rawText.matchAll(pattern)) {
    const candidateRaw = m[1] ? cleanLine(m[1], 160) : '';
    const candidateFolded = normalizeFoldedVi(candidateRaw);
    if (candidateFolded.length >= 4 && !candidateFolded.includes(expectedFolded) && !expectedFolded.includes(candidateFolded)) {
      return candidateRaw;
    }
  }
  return null;
}

export function evaluateDeterministicKycAttachment(input: DeterministicKycEvalInput): DeterministicKycEvalResult {
  const pages = (input.pages ?? []).filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= SIGN_MAX_PAGES);
  const combinedText = pages
    .map((p) => stripFormatControl(p.text).trim())
    .filter(Boolean)
    .join('\n');
  const foldedText = normalizeFoldedVi(combinedText);

  const validMime = ATTACHMENT_MIME_SET.has(input.mimeType);
  const validSize = Number.isInteger(input.sizeBytes) && input.sizeBytes >= 1 && input.sizeBytes <= SIGN_ATTACHMENT_MAX_BYTES;
  const sha256Verified =
    SIGN_SHA256_HEX_PATTERN.test(input.attachmentSha256) && input.attachmentSha256 === input.storedFileSha256;
  const integrityOk = validMime && validSize && sha256Verified;

  const expectedSignerName = cleanLine(input.expectedSignerName ?? input.signerName, 200) || null;
  const expectedEntityName =
    input.expectedEntityName !== undefined
      ? cleanLine(input.expectedEntityName ?? '', 300) || null
      : cleanLine(input.obligationCounterpartyName ?? '', 300) || null;
  const expectedTaxCode = normalizeTaxCodeInput(input.expectedTaxCode);

  const documentKind = detectKycDocumentKind(input.fieldLabel, input.filename, combinedText);
  const extractedTaxCodes = combinedText ? extractVietnamTaxCodes(combinedText) : [];
  const extractedNationalIds = combinedText ? extractVietnamNationalIds(combinedText) : [];

  const deterministicChecks: SignKycDeterministicItemContract[] = [
    {
      category: 'file_integrity',
      status: integrityOk ? 'matched' : 'mismatch',
      extractedValue: `${input.mimeType} (${input.sizeBytes} B)`,
      expectedValue: input.attachmentSha256.slice(0, 16),
      detail: integrityOk
        ? 'Verified MIME type, size bounds, and SHA-256 digest match stored evidence.'
        : 'Attachment MIME type, size bounds, or SHA-256 digest failed verification.',
    },
  ];

  if (input.inspectState === 'pending') {
    return {
      status: 'pending',
      findings: {
        documentKind,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256Verified,
        pageCount: null,
        inspectState: 'pending',
        inspectError: null,
        expectedSignerName,
        expectedEntityName,
        expectedTaxCode,
        extractedTaxCodes: [],
        extractedNationalIds: [],
        extractedTextPreview: null,
        deterministicChecks,
        aiProposal: input.existingAiProposal ?? null,
        manualNote: input.existingManualNote ?? null,
      },
    };
  }

  if (input.inspectState === 'inspected' && combinedText.length > 0) {
    if (expectedTaxCode !== null || extractedTaxCodes.length > 0) {
      const normalizedExpectedDigits = expectedTaxCode ? expectedTaxCode.replace(/\s+/g, '') : null;
      if (normalizedExpectedDigits) {
        if (extractedTaxCodes.length === 0) {
          deterministicChecks.push({
            category: 'tax_code',
            status: 'needs_review',
            extractedValue: null,
            expectedValue: normalizedExpectedDigits,
            detail: 'No 10/13-digit MST was detected in the attachment text; verify manually.',
          });
        } else if (
          extractedTaxCodes.some(
            (code) => code === normalizedExpectedDigits || code.slice(0, 10) === normalizedExpectedDigits.slice(0, 10),
          )
        ) {
          const matchedCode =
            extractedTaxCodes.find((code) => code === normalizedExpectedDigits) ??
            extractedTaxCodes.find((code) => code.slice(0, 10) === normalizedExpectedDigits.slice(0, 10)) ??
            extractedTaxCodes[0]!;
          deterministicChecks.push({
            category: 'tax_code',
            status: matchedCode === normalizedExpectedDigits ? 'matched' : 'needs_review',
            extractedValue: matchedCode,
            expectedValue: normalizedExpectedDigits,
            detail:
              matchedCode === normalizedExpectedDigits
                ? 'Extracted MST matches expected tax code.'
                : 'Extracted branch/headquarters 10-digit MST root matches; confirm suffix manually.',
          });
        } else {
          deterministicChecks.push({
            category: 'tax_code',
            status: 'mismatch',
            extractedValue: extractedTaxCodes.join(', '),
            expectedValue: normalizedExpectedDigits,
            detail: 'Extracted MST in attachment differs from expected tax code.',
          });
        }
      } else {
        deterministicChecks.push({
          category: 'tax_code',
          status: 'needs_review',
          extractedValue: extractedTaxCodes.join(', '),
          expectedValue: null,
          detail: 'Extracted MST from attachment; compare against counterparty contract details.',
        });
      }
    }

    if (expectedEntityName) {
      const foldedEntity = normalizeFoldedVi(expectedEntityName);
      if (foldedEntity.length >= 3 && foldedText.includes(foldedEntity)) {
        deterministicChecks.push({
          category: 'entity_name',
          status: 'matched',
          extractedValue: expectedEntityName,
          expectedValue: expectedEntityName,
          detail: 'Expected legal entity name appears in attachment text.',
        });
      } else {
        const otherEntity =
          foldedEntity.length >= 3 ? hasExplicitDifferentValue(combinedText, EXPLICIT_ENTITY_LINE_RE, foldedEntity) : null;
        deterministicChecks.push({
          category: 'entity_name',
          status: otherEntity ? 'mismatch' : 'needs_review',
          extractedValue: otherEntity,
          expectedValue: expectedEntityName,
          detail: otherEntity
            ? 'Attachment names a different enterprise than expected.'
            : 'Expected legal entity name was not matched verbatim; verify manually.',
        });
      }
    }

    if (expectedSignerName) {
      const foldedSigner = normalizeFoldedVi(expectedSignerName);
      if (foldedSigner.length >= 2 && foldedText.includes(foldedSigner)) {
        deterministicChecks.push({
          category: 'authorized_signer',
          status: 'matched',
          extractedValue: expectedSignerName,
          expectedValue: expectedSignerName,
          detail: 'Contract signer name appears in attachment text.',
        });
      } else {
        const otherRep =
          foldedSigner.length >= 3 ? hasExplicitDifferentValue(combinedText, EXPLICIT_REP_LINE_RE, foldedSigner) : null;
        deterministicChecks.push({
          category: 'authorized_signer',
          status: otherRep ? 'mismatch' : 'needs_review',
          extractedValue: otherRep,
          expectedValue: expectedSignerName,
          detail: otherRep
            ? 'Attachment lists a different representative/holder name than the contract signer.'
            : 'Contract signer name was not matched verbatim in attachment text; verify manually.',
        });
      }
    }

    if (extractedNationalIds.length > 0) {
      deterministicChecks.push({
        category: 'national_id',
        status: 'needs_review',
        extractedValue: extractedNationalIds.join(', '),
        expectedValue: null,
        detail: 'Detected 12-digit CCCD number(s) in attachment; confirm against signatory identity.',
      });
    }
  } else if (input.inspectState === 'image_metadata_only') {
    deterministicChecks.push({
      category: 'authorized_signer',
      status: 'needs_review',
      extractedValue: null,
      expectedValue: expectedSignerName,
      detail: 'Image attachment verified by MIME/size/SHA-256; inspect side-by-side preview and confirm manually.',
    });
  } else {
    deterministicChecks.push({
      category: 'authorized_signer',
      status: 'needs_review',
      extractedValue: null,
      expectedValue: expectedSignerName,
      detail:
        input.inspectState === 'failed'
          ? 'PDF text inspection reported an error; download or preview attachment and confirm manually.'
          : 'PDF contains no extractable text layer (scanned image); preview side-by-side and confirm manually.',
    });
  }

  let status: SignKycCheckStatus = 'needs_review';
  if (deterministicChecks.some((c) => c.status === 'mismatch')) {
    status = 'mismatch';
  } else if (
    integrityOk &&
    input.inspectState === 'inspected' &&
    combinedText.length > 0 &&
    deterministicChecks.some((c) => c.category === 'authorized_signer' && c.status === 'matched') &&
    deterministicChecks.every((c) => c.category === 'national_id' || c.status === 'matched')
  ) {
    status = 'matched';
  }

  const previewText = combinedText ? cleanLine(combinedText, 1200) : null;

  return {
    status,
    findings: {
      documentKind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256Verified,
      pageCount: pages.length > 0 ? pages.length : null,
      inspectState: input.inspectState,
      inspectError: input.inspectError ? cleanLine(input.inspectError, 300) : null,
      expectedSignerName,
      expectedEntityName,
      expectedTaxCode,
      extractedTaxCodes,
      extractedNationalIds,
      extractedTextPreview: previewText,
      deterministicChecks,
      aiProposal: input.existingAiProposal ?? null,
      manualNote: input.existingManualNote ?? null,
    },
  };
}

function assertUser(ctx: QueryContext | CommandContext): string {
  if (ctx.actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can perform KYC attachment checks');
  }
  return ctx.actor.userId;
}

function assertSystem(ctx: QueryContext | CommandContext): void {
  if (ctx.actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only system workers can execute sandboxed KYC inspection callbacks');
  }
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function parseStoredFindings(
  raw: unknown,
  fallback: { mimeType: string; sizeBytes: number; sha256Verified: boolean },
): SignKycFindingsContract {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      obj = null;
    }
  }
  const rec = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  const rawDocKind = typeof rec.documentKind === 'string' ? rec.documentKind : 'other';
  const documentKind: SignKycDocKindContract = DOC_KIND_SET.has(rawDocKind)
    ? (rawDocKind as SignKycDocKindContract)
    : 'other';
  const mimeType = typeof rec.mimeType === 'string' && rec.mimeType ? rec.mimeType : fallback.mimeType;
  const sizeBytes =
    typeof rec.sizeBytes === 'number' && Number.isInteger(rec.sizeBytes) && rec.sizeBytes >= 0
      ? rec.sizeBytes
      : fallback.sizeBytes;
  const sha256Verified = typeof rec.sha256Verified === 'boolean' ? rec.sha256Verified : fallback.sha256Verified;
  const pageCount =
    typeof rec.pageCount === 'number' &&
    Number.isInteger(rec.pageCount) &&
    rec.pageCount >= 1 &&
    rec.pageCount <= SIGN_MAX_PAGES
      ? rec.pageCount
      : null;
  const rawInspect = typeof rec.inspectState === 'string' ? rec.inspectState : 'inspected';
  const inspectState =
    rawInspect === 'pending' ||
    rawInspect === 'inspected' ||
    rawInspect === 'image_metadata_only' ||
    rawInspect === 'failed'
      ? rawInspect
      : 'inspected';
  const inspectError = typeof rec.inspectError === 'string' && rec.inspectError ? cleanLine(rec.inspectError, 300) : null;
  const expectedSignerName =
    typeof rec.expectedSignerName === 'string' && rec.expectedSignerName ? cleanLine(rec.expectedSignerName, 200) : null;
  const expectedEntityName =
    typeof rec.expectedEntityName === 'string' && rec.expectedEntityName ? cleanLine(rec.expectedEntityName, 300) : null;
  const expectedTaxCode =
    typeof rec.expectedTaxCode === 'string' && rec.expectedTaxCode ? cleanLine(rec.expectedTaxCode, 32) : null;
  const extractedTaxCodes = Array.isArray(rec.extractedTaxCodes)
    ? rec.extractedTaxCodes.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 10)
    : [];
  const extractedNationalIds = Array.isArray(rec.extractedNationalIds)
    ? rec.extractedNationalIds.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 10)
    : [];
  const extractedTextPreview =
    typeof rec.extractedTextPreview === 'string' && rec.extractedTextPreview
      ? cleanLine(rec.extractedTextPreview, 1200)
      : null;

  const deterministicChecks: SignKycDeterministicItemContract[] = [];
  if (Array.isArray(rec.deterministicChecks)) {
    for (const item of rec.deterministicChecks) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const cat = typeof entry.category === 'string' ? entry.category : '';
      const st = typeof entry.status === 'string' ? entry.status : '';
      const detail = typeof entry.detail === 'string' ? cleanLine(entry.detail, 400) : '';
      if (!FINDING_CATEGORY_SET.has(cat) || !ITEM_STATUS_SET.has(st) || !detail) continue;
      deterministicChecks.push({
        category: cat as SignKycFindingCategoryContract,
        status: st as SignKycItemStatusContract,
        extractedValue: typeof entry.extractedValue === 'string' ? cleanLine(entry.extractedValue, 300) : null,
        expectedValue: typeof entry.expectedValue === 'string' ? cleanLine(entry.expectedValue, 300) : null,
        detail,
      });
    }
  }

  let aiProposal: SignKycAiProposalContract | null = null;
  if (rec.aiProposal && typeof rec.aiProposal === 'object' && !Array.isArray(rec.aiProposal)) {
    const rawProp = rec.aiProposal as Record<string, unknown>;
    const rawSug = typeof rawProp.suggestedStatus === 'string' ? rawProp.suggestedStatus : 'needs_review';
    const suggestedStatus =
      rawSug === 'matched' || rawSug === 'mismatch' || rawSug === 'needs_review' ? rawSug : 'needs_review';
    const findings: SignKycAiDiscrepancyContract[] = [];
    if (Array.isArray(rawProp.findings)) {
      for (const f of rawProp.findings) {
        if (!f || typeof f !== 'object') continue;
        const fi = f as Record<string, unknown>;
        const cat = typeof fi.category === 'string' ? fi.category : '';
        const assessment = typeof fi.assessment === 'string' ? fi.assessment : '';
        const pageNumber = fi.pageNumber;
        const quoteExcerpt = typeof fi.quoteExcerpt === 'string' ? cleanLine(fi.quoteExcerpt, 600) : '';
        const explanation = typeof fi.explanation === 'string' ? cleanLine(fi.explanation, 400) : '';
        if (
          AI_CATEGORY_SET.has(cat) &&
          (assessment === 'match' || assessment === 'mismatch' || assessment === 'unclear') &&
          typeof pageNumber === 'number' &&
          Number.isInteger(pageNumber) &&
          pageNumber >= 1 &&
          pageNumber <= SIGN_MAX_PAGES &&
          quoteExcerpt &&
          explanation
        ) {
          findings.push({
            category: cat as SignKycAiCategoryContract,
            assessment,
            extractedValue: typeof fi.extractedValue === 'string' ? cleanLine(fi.extractedValue, 300) : null,
            expectedValue: typeof fi.expectedValue === 'string' ? cleanLine(fi.expectedValue, 300) : null,
            pageNumber,
            quoteExcerpt,
            explanation,
            proposedByAi: true,
          });
        }
      }
    }
    if (findings.length > 0 || typeof rawProp.summaryNote === 'string') {
      aiProposal = {
        suggestedStatus,
        summaryNote: typeof rawProp.summaryNote === 'string' ? cleanLine(rawProp.summaryNote, 500) : null,
        findings,
        promptVersion: typeof rawProp.promptVersion === 'string' ? cleanLine(rawProp.promptVersion, 32) : 'v1',
        proposedByAi: true,
      };
    }
  }

  const manualNote = typeof rec.manualNote === 'string' && rec.manualNote ? cleanLine(rec.manualNote, 1000) : null;

  return {
    documentKind,
    mimeType,
    sizeBytes,
    sha256Verified,
    pageCount,
    inspectState,
    inspectError,
    expectedSignerName,
    expectedEntityName,
    expectedTaxCode,
    extractedTaxCodes,
    extractedNationalIds,
    extractedTextPreview,
    deterministicChecks,
    aiProposal,
    manualNote,
  };
}

function toCheckRecord(
  row: {
    id: string;
    envelope_id: string;
    field_id: string;
    file_id: string;
    file_sha256: string;
    status: SignKycCheckStatus;
    mode: SignKycCheckMode;
    findings_json: unknown;
    checked_by: string | null;
    checked_at: Date | null;
    created_at: Date;
    updated_at: Date;
  },
  fallback: { mimeType: string; sizeBytes: number; sha256Verified: boolean },
): SignKycCheckRecordContract {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    fieldId: row.field_id,
    fileId: row.file_id,
    fileSha256: row.file_sha256,
    status: row.status,
    mode: row.mode,
    findings: parseStoredFindings(row.findings_json, fallback),
    checkedBy: row.checked_by,
    checkedAt: isoOrNull(row.checked_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function assertCanReadSignFileOrNotFound(trx: QueryContext['trx'], fileId: string): Promise<void> {
  const { rows } = await sql<{ allowed: boolean }>`
    SELECT ludy_sign.can_read_sign_file(${fileId}::uuid) AS allowed
  `.execute(trx);
  if (rows[0]?.allowed !== true) {
    throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
  }
}

async function loadVerifiedAttachmentContext(
  ctx: QueryContext | CommandContext,
  envelopeId: string,
  fieldId: string,
) {
  const env = await ctx.trx
    .selectFrom('ludy_sign.envelope')
    .select(['id', 'title', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', envelopeId)
    .executeTakeFirst();
  if (!env) {
    throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
  }
  assertCanAccessEnvelopeRow(ctx, env);
  await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);

  const field = await ctx.trx
    .selectFrom('ludy_sign.field')
    .select([
      'id',
      'envelope_id',
      'signer_id',
      'field_type',
      'label',
      'attachment_file_id',
      'attachment_filename',
      'attachment_content_type',
      'attachment_size_bytes',
      'attachment_sha256',
      'filled_at',
    ])
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', env.id)
    .where('id', '=', fieldId)
    .executeTakeFirst();
  if (!field || field.field_type !== 'attachment' || !field.attachment_file_id || !field.attachment_sha256) {
    throw new DomainError('SIGN_FIELD_NOT_FOUND', 404, 'Uploaded attachment field not found on envelope');
  }

  await assertCanReadSignFileOrNotFound(ctx.trx, field.attachment_file_id);

  const fileRow = await ctx.trx
    .selectFrom('ludy_kernel.file')
    .select(['id', 'storage_key', 'generation', 'sha256', 'content_type', 'size_bytes', 'source'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', field.attachment_file_id)
    .executeTakeFirst();
  if (!fileRow || fileRow.source !== 'sign_attachment' || !fileRow.generation) {
    throw new DomainError('SIGN_FIELD_NOT_FOUND', 404, 'Uploaded attachment file not found');
  }

  const signer = await ctx.trx
    .selectFrom('ludy_sign.signer')
    .select(['id', 'name', 'email', 'role_label'])
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', env.id)
    .where('id', '=', field.signer_id)
    .executeTakeFirst();
  if (!signer) {
    throw new DomainError('SIGN_SIGNER_NOT_FOUND', 404, 'Signer not found on envelope');
  }

  const obligation = await ctx.trx
    .selectFrom('ludy_sign.envelope_obligation')
    .select(['counterparty_name', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', env.id)
    .executeTakeFirst();

  const existing = await ctx.trx
    .selectFrom('ludy_sign.kyc_check')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('field_id', '=', field.id)
    .executeTakeFirst();

  const contentType: SignAttachmentContentType =
    field.attachment_content_type ??
    (ATTACHMENT_MIME_SET.has(fileRow.content_type) ? (fileRow.content_type as SignAttachmentContentType) : 'application/pdf');
  const sizeBytes = field.attachment_size_bytes ?? Number(fileRow.size_bytes);
  const sha256Verified = field.attachment_sha256 === fileRow.sha256;

  return {
    env,
    field: {
      ...field,
      attachment_file_id: field.attachment_file_id,
      attachment_sha256: field.attachment_sha256,
      filename: field.attachment_filename ?? 'attachment',
      contentType,
      sizeBytes,
    },
    fileRow: {
      ...fileRow,
      generation: fileRow.generation,
    },
    signer,
    obligationCounterpartyName: obligation?.status === 'confirmed' ? obligation.counterparty_name : null,
    existing: existing ?? null,
    sha256Verified,
  };
}

export const signKycList = defineQuery({
  name: 'sign.kyc.list',
  input: z.strictObject({ envelopeId: zId }),
  access: READERS,
  handler: async (ctx, input): Promise<SignKycListResultContract> => {
    const userId = assertUser(ctx);
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'source_id', 'created_by', 'retained_org_visible', 'retained_reader_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .executeTakeFirst();
    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    assertCanAccessEnvelopeRow(ctx, env);
    await assertCanAccessMeetingMinutesEnvelopeRow(ctx, env);

    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select(['role'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const canWrite = Boolean(member && (member.role === 'owner' || member.role === 'admin' || member.role === 'member'));

    const fields = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select([
        'id',
        'signer_id',
        'field_type',
        'label',
        'attachment_file_id',
        'attachment_filename',
        'attachment_content_type',
        'attachment_size_bytes',
        'attachment_sha256',
        'filled_at',
        'page_number',
        'created_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .where('field_type', '=', 'attachment')
      .where('attachment_file_id', 'is not', null)
      .orderBy('page_number', 'asc')
      .orderBy('created_at', 'asc')
      .execute();

    if (fields.length === 0) {
      return { envelopeId: env.id, canWrite, items: [] };
    }

    const signers = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['id', 'name', 'email', 'role_label'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .execute();
    const signerById = new Map(signers.map((s) => [s.id, s]));

    const obligation = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .select(['counterparty_name', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .executeTakeFirst();
    const obligationCounterpartyName = obligation?.status === 'confirmed' ? obligation.counterparty_name : null;

    const checks = await ctx.trx
      .selectFrom('ludy_sign.kyc_check')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .execute();
    const checkByFieldId = new Map(checks.map((c) => [c.field_id, c]));

    const fileIds = [...new Set(fields.map((f) => f.attachment_file_id!))];
    const { rows: accessRows } = await sql<{ allowed: boolean }>`
      SELECT pg_catalog.bool_and(ludy_sign.can_read_sign_file(u.id)) AS allowed
      FROM pg_catalog.unnest(${fileIds}::uuid[]) AS u(id)
    `.execute(ctx.trx);
    if (accessRows[0]?.allowed !== true) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }

    const files = await ctx.trx
      .selectFrom('ludy_kernel.file')
      .select(['id', 'sha256', 'content_type', 'size_bytes', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', fileIds)
      .execute();
    const fileById = new Map(files.map((f) => [f.id, f]));

    const items: SignKycAttachmentSlotContract[] = [];
    for (const f of fields) {
      const fileId = f.attachment_file_id!;
      const fileRow = fileById.get(fileId);
      if (!fileRow || fileRow.source !== 'sign_attachment' || !f.attachment_sha256) continue;
      const signer = signerById.get(f.signer_id);
      if (!signer) continue;
      const contentType: SignAttachmentContentType =
        f.attachment_content_type ??
        (ATTACHMENT_MIME_SET.has(fileRow.content_type) ? (fileRow.content_type as SignAttachmentContentType) : 'application/pdf');
      const sizeBytes = f.attachment_size_bytes ?? Number(fileRow.size_bytes);
      const sha256Verified = f.attachment_sha256 === fileRow.sha256;
      const checkRow = checkByFieldId.get(f.id);

      items.push({
        fieldId: f.id,
        signerId: signer.id,
        signerName: signer.name,
        signerEmail: signer.email,
        signerRoleLabel: signer.role_label,
        fieldLabel: f.label,
        fileId,
        filename: f.attachment_filename ?? 'attachment',
        contentType,
        sizeBytes,
        fileSha256: f.attachment_sha256,
        filledAt: isoOrNull(f.filled_at),
        obligationCounterpartyName,
        check:
          checkRow && checkRow.file_id === fileId
            ? toCheckRecord(checkRow, { mimeType: contentType, sizeBytes, sha256Verified })
            : null,
      });
    }

    return {
      envelopeId: env.id,
      canWrite,
      items,
    };
  },
});

export const signKycSource = defineQuery({
  name: 'sign.kyc.source',
  input: z.strictObject({ envelopeId: zId, fieldId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<SignKycSource> => {
    assertUser(ctx);
    const loaded = await loadVerifiedAttachmentContext(ctx, input.envelopeId, input.fieldId);
    const parsedExisting =
      loaded.existing && loaded.existing.file_id === loaded.fileRow.id
        ? parseStoredFindings(loaded.existing.findings_json, {
            mimeType: loaded.field.contentType,
            sizeBytes: loaded.field.sizeBytes,
            sha256Verified: loaded.sha256Verified,
          })
        : null;

    return {
      envelopeId: loaded.env.id,
      envelopeTitle: loaded.env.title,
      envelopeStatus: loaded.env.status,
      fieldId: loaded.field.id,
      fieldLabel: loaded.field.label,
      signerId: loaded.signer.id,
      signerName: loaded.signer.name,
      signerRoleLabel: loaded.signer.role_label,
      fileId: loaded.fileRow.id,
      filename: loaded.field.filename,
      contentType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      fileSha256: loaded.field.attachment_sha256,
      storageKey: loaded.fileRow.storage_key,
      generation: loaded.fileRow.generation,
      sha256Verified: loaded.sha256Verified,
      obligationCounterpartyName: loaded.obligationCounterpartyName,
      storedTextPreview: parsedExisting?.extractedTextPreview ?? null,
      storedPageCount: parsedExisting?.pageCount ?? null,
      aiStopped: await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId),
    };
  },
});

export const signKycInspectJobData = defineQuery({
  name: 'sign.kyc.inspect_job_data',
  input: z.strictObject({ envelopeId: zId, fieldId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SignKycInspectJobData | null> => {
    assertSystem(ctx);
    const kycRow = await ctx.trx
      .selectFrom('ludy_sign.kyc_check')
      .select(['id', 'envelope_id', 'field_id', 'file_id', 'file_sha256', 'status', 'mode'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .where('field_id', '=', input.fieldId)
      .executeTakeFirst();
    if (!kycRow || kycRow.status !== 'pending' || kycRow.mode !== 'deterministic') {
      return null;
    }

    const fileRow = await ctx.trx
      .selectFrom('ludy_kernel.file')
      .select(['id', 'storage_key', 'generation', 'sha256', 'content_type', 'size_bytes', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', kycRow.file_id)
      .executeTakeFirst();
    if (!fileRow || fileRow.source !== 'sign_attachment' || fileRow.content_type !== 'application/pdf' || !fileRow.generation) {
      return null;
    }

    return {
      envelopeId: kycRow.envelope_id,
      fieldId: kycRow.field_id,
      fileId: fileRow.id,
      fileSha256: kycRow.file_sha256,
      storageKey: fileRow.storage_key,
      generation: fileRow.generation,
      mimeType: fileRow.content_type,
      sizeBytes: Number(fileRow.size_bytes),
    };
  },
});

async function upsertKycCheckRow(
  ctx: CommandContext,
  params: {
    envelopeId: string;
    fieldId: string;
    fileId: string;
    fileSha256: string;
    status: SignKycCheckStatus;
    mode: SignKycCheckMode;
    findings: SignKycFindingsContract;
    checkedBy: string | null;
    checkedAt: Date | null;
    fallback: { mimeType: string; sizeBytes: number; sha256Verified: boolean };
  },
): Promise<SignKycCheckRecordContract> {
  const findingsText = JSON.stringify(params.findings);
  const row = await ctx.trx
    .insertInto('ludy_sign.kyc_check')
    .values({
      org_id: ctx.orgId,
      envelope_id: params.envelopeId,
      field_id: params.fieldId,
      file_id: params.fileId,
      file_sha256: params.fileSha256,
      status: params.status,
      mode: params.mode,
      findings_json: findingsText,
      checked_by: params.checkedBy,
      checked_at: params.checkedAt,
    })
    .onConflict((oc) =>
      oc.columns(['org_id', 'field_id']).doUpdateSet({
        envelope_id: params.envelopeId,
        file_id: params.fileId,
        file_sha256: params.fileSha256,
        status: params.status,
        mode: params.mode,
        findings_json: findingsText,
        checked_by: params.checkedBy,
        checked_at: params.checkedAt,
        updated_at: ctx.now,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toCheckRecord(row, params.fallback);
}

export const signKycRunDeterministic = defineCommand({
  name: 'sign.kyc.run_deterministic',
  input: zSignKycRunDeterministicInput,
  access: WRITERS,
  risk: 'R1',
  sideEffect: 'internal',
  target,
  writes: [KYC_CHECK_UPSERT_WRITE],
  handler: async (ctx, input): Promise<SignKycCheckRecordContract> => {
    assertUser(ctx);
    const loaded = await loadVerifiedAttachmentContext(ctx, input.envelopeId, input.fieldId);
    const fallback = {
      mimeType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      sha256Verified: loaded.sha256Verified,
    };
    const priorFindings =
      loaded.existing && loaded.existing.file_id === loaded.fileRow.id
        ? parseStoredFindings(loaded.existing.findings_json, fallback)
        : null;

    const isImage = loaded.field.contentType === 'image/png' || loaded.field.contentType === 'image/jpeg';
    const hasInlinePages = Array.isArray(input.attachmentPages);

    const inspectState: 'pending' | 'inspected' | 'image_metadata_only' = isImage
      ? 'image_metadata_only'
      : hasInlinePages
        ? 'inspected'
        : 'pending';

    const evaluated = evaluateDeterministicKycAttachment({
      fieldLabel: loaded.field.label,
      filename: loaded.field.filename,
      mimeType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      attachmentSha256: loaded.field.attachment_sha256,
      storedFileSha256: loaded.fileRow.sha256,
      signerName: loaded.signer.name,
      obligationCounterpartyName: loaded.obligationCounterpartyName,
      expectedSignerName:
        input.expectedSignerName !== undefined ? input.expectedSignerName : priorFindings?.expectedSignerName,
      expectedEntityName:
        input.expectedEntityName !== undefined ? input.expectedEntityName : priorFindings?.expectedEntityName,
      expectedTaxCode: input.expectedTaxCode !== undefined ? input.expectedTaxCode : priorFindings?.expectedTaxCode,
      pages: input.attachmentPages ?? null,
      inspectState,
      existingAiProposal: priorFindings?.aiProposal ?? null,
      existingManualNote: priorFindings?.manualNote ?? null,
    });

    const saved = await upsertKycCheckRow(ctx, {
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      fileSha256: loaded.field.attachment_sha256,
      status: evaluated.status,
      mode: 'deterministic',
      findings: evaluated.findings,
      checkedBy: null,
      checkedAt: null,
      fallback,
    });

    if (inspectState === 'pending') {
      await ctx.emit('sign.kyc.inspect_queued', {
        envelopeId: loaded.env.id,
        fieldId: loaded.field.id,
      });
    }

    ctx.audit({
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      status: saved.status,
      mode: saved.mode,
      inspectState,
    });

    return saved;
  },
});

const zSignKycInspectCompleteInput = z.strictObject({
  envelopeId: zId,
  fieldId: zId,
  fileId: zId,
  fileSha256: z.string().regex(SIGN_SHA256_HEX_PATTERN),
  outcome: z.enum(['passed', 'failed']),
  pages: z.array(zSignKycPageTextInput).max(SIGN_MAX_PAGES).optional(),
  error: z.string().max(500).optional(),
  expectedUpdatedAtBefore: z.iso.datetime({ offset: true }).optional(),
});

export const signKycInspectComplete = defineCommand({
  name: 'sign.kyc.inspect_complete',
  input: zSignKycInspectCompleteInput,
  access: 'system',
  risk: 'R1',
  sideEffect: 'internal',
  target,
  writes: [KYC_CHECK_UPSERT_WRITE],
  handler: async (ctx, input): Promise<SignKycCheckRecordContract | null> => {
    assertSystem(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_sign.kyc_check')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .where('field_id', '=', input.fieldId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !existing ||
      existing.status !== 'pending' ||
      existing.mode !== 'deterministic' ||
      existing.file_id !== input.fileId ||
      existing.file_sha256 !== input.fileSha256
    ) {
      return null;
    }
    if (input.expectedUpdatedAtBefore !== undefined) {
      const expectedBeforeMs = new Date(input.expectedUpdatedAtBefore).getTime();
      const updatedMs = new Date(existing.updated_at).getTime();
      if (Number.isFinite(expectedBeforeMs) && Number.isFinite(updatedMs) && updatedMs > expectedBeforeMs) {
        return null;
      }
    }

    const field = await ctx.trx
      .selectFrom('ludy_sign.field')
      .select([
        'id',
        'signer_id',
        'label',
        'attachment_file_id',
        'attachment_filename',
        'attachment_content_type',
        'attachment_size_bytes',
        'attachment_sha256',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .where('id', '=', input.fieldId)
      .executeTakeFirst();
    if (
      !field ||
      field.attachment_file_id !== input.fileId ||
      field.attachment_sha256 !== input.fileSha256
    ) {
      return null;
    }

    const fileRow = await ctx.trx
      .selectFrom('ludy_kernel.file')
      .select(['id', 'sha256', 'content_type', 'size_bytes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', field.attachment_file_id)
      .executeTakeFirst();
    if (!fileRow) return null;

    const signer = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['id', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .where('id', '=', field.signer_id)
      .executeTakeFirst();
    if (!signer) return null;

    const obligation = await ctx.trx
      .selectFrom('ludy_sign.envelope_obligation')
      .select(['counterparty_name', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', input.envelopeId)
      .executeTakeFirst();

    const contentType = field.attachment_content_type ?? fileRow.content_type;
    const sizeBytes = field.attachment_size_bytes ?? Number(fileRow.size_bytes);
    const sha256Verified = field.attachment_sha256 === fileRow.sha256;
    const fallback = { mimeType: contentType, sizeBytes, sha256Verified };
    const prior = parseStoredFindings(existing.findings_json, fallback);

    const evaluated = evaluateDeterministicKycAttachment({
      fieldLabel: field.label,
      filename: field.attachment_filename ?? 'attachment.pdf',
      mimeType: contentType,
      sizeBytes,
      attachmentSha256: field.attachment_sha256,
      storedFileSha256: fileRow.sha256,
      signerName: signer.name,
      obligationCounterpartyName: obligation?.status === 'confirmed' ? obligation.counterparty_name : null,
      expectedSignerName: prior.expectedSignerName,
      expectedEntityName: prior.expectedEntityName,
      expectedTaxCode: prior.expectedTaxCode,
      pages: input.outcome === 'passed' ? (input.pages ?? []) : [],
      inspectState: input.outcome === 'passed' ? 'inspected' : 'failed',
      inspectError: input.outcome === 'failed' ? (input.error ?? 'PDF text extraction failed') : null,
      existingAiProposal: prior.aiProposal,
      existingManualNote: prior.manualNote,
    });

    const saved = await upsertKycCheckRow(ctx, {
      envelopeId: input.envelopeId,
      fieldId: field.id,
      fileId: fileRow.id,
      fileSha256: field.attachment_sha256,
      status: evaluated.status,
      mode: 'deterministic',
      findings: evaluated.findings,
      checkedBy: null,
      checkedAt: null,
      fallback,
    });

    ctx.audit({
      envelopeId: input.envelopeId,
      fieldId: field.id,
      outcome: input.outcome,
      status: saved.status,
    });

    return saved;
  },
});

const zSignKycProposeAiInput = z.strictObject({
  envelopeId: zId,
  fieldId: zId,
  promptVersion: z.string().trim().min(1).max(32),
  expectedEntityName: z.string().trim().max(300).nullable().optional(),
  expectedTaxCode: z.string().trim().max(32).nullable().optional(),
  expectedSignerName: z.string().trim().max(200).nullable().optional(),
  extractedPages: z.array(zSignKycPageTextInput).max(SIGN_MAX_PAGES),
  proposal: z.strictObject({
    suggestedStatus: z.enum(['matched', 'mismatch', 'needs_review']),
    summaryNote: z.string().max(500).nullable(),
    findings: z
      .array(
        z.strictObject({
          category: z.enum(SIGN_KYC_AI_CATEGORIES),
          assessment: z.enum(['match', 'mismatch', 'unclear']),
          extractedValue: z.string().max(300).nullable(),
          expectedValue: z.string().max(300).nullable(),
          pageNumber: z.number().int().min(1).max(SIGN_MAX_PAGES),
          quoteExcerpt: z.string().min(1).max(1000),
          explanation: z.string().min(1).max(500),
          proposedByAi: z.literal(true),
        }),
      )
      .max(20),
    proposedByAi: z.literal(true),
  }),
});

export const signKycProposeAi = defineCommand({
  name: 'sign.kyc.propose_ai',
  input: zSignKycProposeAiInput,
  access: WRITERS,
  risk: 'R1',
  sideEffect: 'internal',
  target,
  writes: [KYC_CHECK_UPSERT_WRITE],
  handler: async (ctx, input): Promise<SignKycCheckRecordContract> => {
    assertUser(ctx);
    const loaded = await loadVerifiedAttachmentContext(ctx, input.envelopeId, input.fieldId);
    if (await isSignAiStoppedOnTrx(ctx.trx, ctx.orgId)) {
      throw new DomainError('SIGN_AI_DISABLED', 409, 'AI kill switch is active');
    }

    const fallback = {
      mimeType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      sha256Verified: loaded.sha256Verified,
    };
    const priorFindings =
      loaded.existing && loaded.existing.file_id === loaded.fileRow.id
        ? parseStoredFindings(loaded.existing.findings_json, fallback)
        : null;

    const aiProposal: SignKycAiProposalContract = {
      suggestedStatus: input.proposal.suggestedStatus,
      summaryNote: input.proposal.summaryNote ? cleanLine(input.proposal.summaryNote, 500) : null,
      findings: input.proposal.findings.map((f) => ({
        category: f.category,
        assessment: f.assessment,
        extractedValue: f.extractedValue ? cleanLine(f.extractedValue, 300) : null,
        expectedValue: f.expectedValue ? cleanLine(f.expectedValue, 300) : null,
        pageNumber: f.pageNumber,
        quoteExcerpt: cleanLine(f.quoteExcerpt, 600),
        explanation: cleanLine(f.explanation, 400),
        proposedByAi: true,
      })),
      promptVersion: cleanLine(input.promptVersion, 32),
      proposedByAi: true,
    };

    const evaluated = evaluateDeterministicKycAttachment({
      fieldLabel: loaded.field.label,
      filename: loaded.field.filename,
      mimeType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      attachmentSha256: loaded.field.attachment_sha256,
      storedFileSha256: loaded.fileRow.sha256,
      signerName: loaded.signer.name,
      obligationCounterpartyName: loaded.obligationCounterpartyName,
      expectedSignerName:
        input.expectedSignerName !== undefined ? input.expectedSignerName : priorFindings?.expectedSignerName,
      expectedEntityName:
        input.expectedEntityName !== undefined ? input.expectedEntityName : priorFindings?.expectedEntityName,
      expectedTaxCode: input.expectedTaxCode !== undefined ? input.expectedTaxCode : priorFindings?.expectedTaxCode,
      pages: input.extractedPages,
      inspectState: 'inspected',
      existingAiProposal: aiProposal,
      existingManualNote: priorFindings?.manualNote ?? null,
    });

    // Tainted AI proposals NEVER auto-approve or auto-reject: status remains 'needs_review' until a human confirms.
    const saved = await upsertKycCheckRow(ctx, {
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      fileSha256: loaded.field.attachment_sha256,
      status: 'needs_review',
      mode: 'ai',
      findings: evaluated.findings,
      checkedBy: null,
      checkedAt: null,
      fallback,
    });

    ctx.audit({
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      suggestedStatus: aiProposal.suggestedStatus,
      findingCount: aiProposal.findings.length,
    });

    return saved;
  },
});

export const signKycConfirm = defineCommand({
  name: 'sign.kyc.confirm',
  input: zSignKycConfirmInput,
  access: WRITERS,
  risk: 'R1',
  sideEffect: 'internal',
  target,
  writes: [KYC_CHECK_UPSERT_WRITE],
  handler: async (ctx, input): Promise<SignKycCheckRecordContract> => {
    const userId = assertUser(ctx);
    const loaded = await loadVerifiedAttachmentContext(ctx, input.envelopeId, input.fieldId);
    const fallback = {
      mimeType: loaded.field.contentType,
      sizeBytes: loaded.field.sizeBytes,
      sha256Verified: loaded.sha256Verified,
    };

    const priorFindings =
      loaded.existing && loaded.existing.file_id === loaded.fileRow.id
        ? parseStoredFindings(loaded.existing.findings_json, fallback)
        : null;

    const isImage = loaded.field.contentType === 'image/png' || loaded.field.contentType === 'image/jpeg';
    const baseFindings =
      priorFindings ??
      evaluateDeterministicKycAttachment({
        fieldLabel: loaded.field.label,
        filename: loaded.field.filename,
        mimeType: loaded.field.contentType,
        sizeBytes: loaded.field.sizeBytes,
        attachmentSha256: loaded.field.attachment_sha256,
        storedFileSha256: loaded.fileRow.sha256,
        signerName: loaded.signer.name,
        obligationCounterpartyName: loaded.obligationCounterpartyName,
        expectedSignerName: input.expectedSignerName,
        expectedEntityName: input.expectedEntityName,
        expectedTaxCode: input.expectedTaxCode,
        inspectState: isImage ? 'image_metadata_only' : 'inspected',
      }).findings;

    const mergedFindings: SignKycFindingsContract = {
      ...baseFindings,
      expectedSignerName:
        input.expectedSignerName !== undefined
          ? cleanLine(input.expectedSignerName ?? '', 200) || null
          : baseFindings.expectedSignerName,
      expectedEntityName:
        input.expectedEntityName !== undefined
          ? cleanLine(input.expectedEntityName ?? '', 300) || null
          : baseFindings.expectedEntityName,
      expectedTaxCode:
        input.expectedTaxCode !== undefined
          ? normalizeTaxCodeInput(input.expectedTaxCode)
          : baseFindings.expectedTaxCode,
      manualNote:
        input.manualNote !== undefined
          ? input.manualNote
            ? cleanLine(input.manualNote, 1000)
            : null
          : baseFindings.manualNote,
    };

    const saved = await upsertKycCheckRow(ctx, {
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      fileSha256: loaded.field.attachment_sha256,
      status: input.status,
      mode: 'manual',
      findings: mergedFindings,
      checkedBy: userId,
      checkedAt: ctx.now,
      fallback,
    });

    ctx.audit({
      envelopeId: loaded.env.id,
      fieldId: loaded.field.id,
      fileId: loaded.fileRow.id,
      status: saved.status,
      mode: saved.mode,
    });

    return saved;
  },
});

const zSignKycTouchPendingInput = z.strictObject({
  ids: z.array(zId).min(1).max(500),
});

export const signKycTouchPending = defineCommand({
  name: 'sign.kyc.touch_pending',
  input: zSignKycTouchPendingInput,
  access: 'system',
  risk: 'R1',
  sideEffect: 'internal',
  target: (input) => ({ type: 'sign.kyc_check', id: input.ids[0]! }),
  writes: [tableWrite(signManifest.tables, 'ludy_sign', 'kyc_check', ['updated_at'])],
  handler: async (ctx, input): Promise<{ updated: number }> => {
    assertSystem(ctx);
    const uniqueIds = Array.from(new Set(input.ids));
    const updatedRows = await ctx.trx
      .updateTable('ludy_sign.kyc_check')
      .set({ updated_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'pending')
      .where('mode', '=', 'deterministic')
      .where('id', 'in', uniqueIds)
      .returning(['id'])
      .execute();
    return { updated: updatedRows.length };
  },
});

export const signKycQueries = [signKycList, signKycSource, signKycInspectJobData];
export const signKycCommands = [
  signKycRunDeterministic,
  signKycInspectComplete,
  signKycTouchPending,
  signKycProposeAi,
  signKycConfirm,
];
