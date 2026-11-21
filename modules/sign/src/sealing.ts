// SPDX-License-Identifier: AGPL-3.0-only
// Token helpers, canonical certificate.json builder, and @crove/extract-contract pdf_seal payload encoder (#3323).
// Never imports a PDF parser directly; all PDF parsing and sealing happens in crove-extract.
import { randomBytes } from 'node:crypto';
import type { SignDeliveryMode, SignFieldType, SignSignatureKind } from '@crove/db';
import {
  EXTRACT_LIMITS,
  encodePdfSealInput,
  type PdfSealCertificate,
  type PdfSealCertificateSigner,
  type PdfSealField,
  type PdfSealOtpStatus,
} from '@crove/extract-contract';
import { canonicalJson, sha256Hex } from './events.ts';

export interface SignFieldForSeal {
  id: string;
  field_type: SignFieldType;
  page_number: number;
  x_norm: string;
  y_norm: string;
  w_norm: string;
  h_norm: string;
  required: boolean;
  font_size_pt: number | null;
  value_text: string | null;
  value_checked: boolean | null;
  signature_png_base64: string | null;
  filled_at: Date | string | null;
}

export interface SignSignerForSeal {
  id: string;
  routing_order: number;
  signer_role: 'signer' | 'approver' | 'cc';
  role_label: string;
  name: string;
  email: string | null;
  delivery_mode: SignDeliveryMode;
  require_email_otp: boolean;
  status: string;
  signed_at: Date | string | null;
  otp_verified_at: Date | string | null;
  signature_kind: SignSignatureKind | null;
  signer_ip_hash: string | null;
  delegated_from_name?: string | null;
  delegated_from_email?: string | null;
  delegation_count?: number;
  created_at: Date | string;
}

export interface CanonicalCertificateEvent {
  seq: number;
  eventType: string;
  signerId: string | null;
  actorType: string;
  documentSha256: string;
  prevEventHash: string | null;
  eventHash: string;
  occurredAtIso: string;
}

export interface CanonicalCertificateArtifactInput {
  envelopeId: string;
  orgId: string;
  certificateCode: string;
  envelopeTitle: string;
  sourceSha256: string;
  sealedSha256: string;
  completedAtIso: string;
  eventChainTipHash: string;
  signers: readonly PdfSealCertificateSigner[];
  events: readonly CanonicalCertificateEvent[];
}

export function generateRawSigningToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSigningToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

export function generateCertificateCode(envelopeId: string, completedAtIso: string, tipHash: string): string {
  const digest = sha256Hex(`${envelopeId}|${completedAtIso}|${tipHash}`).toUpperCase();
  return `CS-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  let maskedLocal: string;
  if (local.length === 1) maskedLocal = `${local}***`;
  else if (local.length === 2) maskedLocal = `${local[0]}***`;
  else maskedLocal = `${local[0]}***${local[local.length - 1]}`;
  return `${maskedLocal}@${domain}`.slice(0, 200);
}

function ipHashPrefixOf(ipHash: string | null): string | null {
  if (!ipHash) return null;
  const lower = ipHash.toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(lower)) return null;
  return lower.slice(0, 16);
}

export function buildPdfSealFields(pageCount: number, rows: readonly SignFieldForSeal[]): PdfSealField[] {
  const out: PdfSealField[] = [];
  for (const f of rows) {
    if (f.filled_at === null && !f.required) continue;
    if (f.page_number < 1 || f.page_number > pageCount) {
      throw new Error(`Field ${f.id} references page ${f.page_number}, outside PDF page count ${pageCount}`);
    }
    const xNorm = Number(f.x_norm);
    const yNorm = Number(f.y_norm);
    const wNorm = Number(f.w_norm);
    const hNorm = Number(f.h_norm);
    if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm) || !Number.isFinite(wNorm) || !Number.isFinite(hNorm)) {
      throw new Error(`Field ${f.id} has non-finite normalized coordinates`);
    }
    const fontOpt = f.font_size_pt !== null ? { fontSizePt: f.font_size_pt } : {};

    switch (f.field_type) {
      case 'signature': {
        if (!f.signature_png_base64) {
          throw new Error(`Signature field ${f.id} requires signature_png_base64 before sealing`);
        }
        out.push({
          type: 'signature',
          page: f.page_number,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          imagePngBase64: f.signature_png_base64,
        });
        break;
      }
      case 'initials': {
        if (!f.signature_png_base64 && f.value_text === null) {
          throw new Error(`Initials field ${f.id} requires image or text before sealing`);
        }
        // crove_sign stores 'initials'; @crove/extract-contract names the pdf_seal variant 'initial'.
        out.push({
          type: 'initial',
          page: f.page_number,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          ...(f.signature_png_base64 ? { imagePngBase64: f.signature_png_base64 } : {}),
          ...(f.value_text !== null ? { text: f.value_text } : {}),
          ...fontOpt,
        });
        break;
      }
      case 'date': {
        if (f.value_text === null) {
          throw new Error(`Date field ${f.id} requires value_text before sealing`);
        }
        out.push({
          type: 'date',
          page: f.page_number,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          text: f.value_text,
          ...fontOpt,
        });
        break;
      }
      case 'text': {
        if (f.value_text === null) {
          throw new Error(`Text field ${f.id} requires value_text before sealing`);
        }
        out.push({
          type: 'text',
          page: f.page_number,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          text: f.value_text,
          ...fontOpt,
        });
        break;
      }
      case 'checkbox': {
        out.push({
          type: 'checkbox',
          page: f.page_number,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          checked: Boolean(f.value_checked),
        });
        break;
      }
    }
  }
  if (out.length > EXTRACT_LIMITS.maxPdfSealFields) {
    throw new Error(`Envelope field count ${out.length} exceeds pdf_seal limit ${EXTRACT_LIMITS.maxPdfSealFields}`);
  }
  return out;
}

export function buildPdfSealSigners(
  signers: readonly SignSignerForSeal[],
  options?: { correctedSignerIds?: ReadonlySet<string> },
): PdfSealCertificateSigner[] {
  const signed = signers
    .filter((s) => s.signer_role !== 'cc' && s.status === 'signed' && s.signed_at !== null)
    .sort((a, b) => {
      if (a.routing_order !== b.routing_order) return a.routing_order - b.routing_order;
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });
  if (signed.length === 0) {
    throw new Error('Cannot build sealing certificate without at least one signed signer');
  }
  return signed.map((s): PdfSealCertificateSigner => {
    const otpStatus: PdfSealOtpStatus = !s.require_email_otp
      ? 'not_required'
      : s.otp_verified_at !== null
        ? 'verified'
        : 'unverified';
    const delegatedFromName = s.delegated_from_name ? s.delegated_from_name.trim().slice(0, 200) || null : null;
    const delegatedFromMaskedEmail = delegatedFromName ? maskEmail(s.delegated_from_email ?? null) : null;
    const delegationCount = s.delegation_count ?? 0;
    const recipientCorrected = options?.correctedSignerIds?.has(s.id) === true;
    return {
      name: s.name.trim().slice(0, 200) || 'Signer',
      roleLabel: s.role_label.trim().slice(0, 100) || 'Signer',
      maskedEmail: maskEmail(s.email),
      deliveryMode: s.delivery_mode,
      otpStatus,
      signedAtIso: new Date(s.signed_at!).toISOString(),
      ipHashPrefix: ipHashPrefixOf(s.signer_ip_hash),
      ...(s.signature_kind ? { signatureKind: s.signature_kind } : {}),
      ...(delegatedFromName
        ? {
            delegatedFromName,
            delegatedFromMaskedEmail,
            delegationCount: Math.max(1, Math.min(2, delegationCount)),
          }
        : {}),
      ...(recipientCorrected ? { recipientCorrected: true } : {}),
    };
  });
}

export function buildPdfSealCertificate(input: {
  certificateCode: string;
  envelopeTitle: string;
  sourceSha256: string;
  completedAtIso: string;
  eventChainTipHash: string;
  signers: readonly SignSignerForSeal[];
  events?: ReadonlyArray<{ signer_id: string | null; event_type: string }>;
}): PdfSealCertificate {
  const correctedSignerIds = new Set<string>();
  for (const ev of input.events ?? []) {
    if (ev.event_type === 'signer_corrected' && ev.signer_id) {
      correctedSignerIds.add(ev.signer_id);
    }
  }
  return {
    certificateCode: input.certificateCode,
    envelopeTitle: input.envelopeTitle.trim().slice(0, 300) || 'Document',
    sourceSha256: input.sourceSha256,
    completedAtIso: input.completedAtIso,
    eventChainTipHash: input.eventChainTipHash,
    signers: buildPdfSealSigners(input.signers, { correctedSignerIds }),
  };
}

export function buildPdfSealInputBytes(input: {
  sourcePdfBytes: Uint8Array;
  pageCount: number;
  fields: readonly SignFieldForSeal[];
  certificate: PdfSealCertificate;
}): Uint8Array {
  return encodePdfSealInput({
    pdfBase64: Buffer.from(input.sourcePdfBytes).toString('base64'),
    fields: buildPdfSealFields(input.pageCount, input.fields),
    certificate: input.certificate,
  });
}

export function buildCanonicalCertificateArtifact(input: CanonicalCertificateArtifactInput): {
  json: string;
  bytes: Uint8Array;
  sha256: string;
} {
  const payload = {
    schemaVersion: 1,
    envelopeId: input.envelopeId,
    orgId: input.orgId,
    certificateCode: input.certificateCode,
    envelopeTitle: input.envelopeTitle,
    sourceSha256: input.sourceSha256,
    sealedSha256: input.sealedSha256,
    completedAtIso: input.completedAtIso,
    eventChainTipHash: input.eventChainTipHash,
    signers: input.signers,
    events: input.events,
  };
  const json = canonicalJson(payload);
  const bytes = new TextEncoder().encode(json);
  return { json, bytes, sha256: sha256Hex(bytes) };
}
