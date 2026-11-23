// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePdfSealInput } from '@ludy/extract-contract';
import {
  signWebhookBody,
  signWebhookPayload,
  zSignDetectedTag,
  zSignTemplateRoleKey,
} from '@ludy/kernel-contract';
import {
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealFields,
  buildPdfSealInputBytes,
  canonicalJson,
  computeSigningEventHash,
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  maskEmail,
  signManifest,
  verifyEventChain,
  type SignFieldForSeal,
  type SignSignerForSeal,
  type SigningEventChainRow,
} from '../src/index.ts';
import { parseFieldOptions, serializeFieldOptionsForType } from '../src/shared.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000001';
const ENVELOPE_ID = '00000000-0000-7000-8000-000000000002';
const SIGNER_1 = '00000000-0000-7000-8000-000000000003';
const SIGNER_2 = '00000000-0000-7000-8000-000000000004';
const DOC_SHA = 'a'.repeat(64);
const SEALED_SHA = 'b'.repeat(64);
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeEventChain(): SigningEventChainRow[] {
  const t1 = '2026-11-15T10:00:00.000Z';
  const t2 = '2026-11-15T10:05:00.000Z';
  const base1 = {
    orgId: ORG_ID,
    envelopeId: ENVELOPE_ID,
    signerId: null,
    seq: 1,
    eventType: 'envelope_created',
    actorType: 'user' as const,
    actorId: '00000000-0000-7000-8000-000000000010',
    actorLabel: 'user:00000000-0000-7000-8000-000000000010',
    ipHash: null,
    userAgent: null,
    documentSha256: DOC_SHA,
    prevEventHash: null,
    payloadJson: { routingMode: 'sequential', sourceKind: 'standalone' },
    occurredAt: t1,
  };
  const hash1 = computeSigningEventHash(base1);

  const base2 = {
    orgId: ORG_ID,
    envelopeId: ENVELOPE_ID,
    signerId: SIGNER_1,
    seq: 2,
    eventType: 'signer_signed',
    actorType: 'signer' as const,
    actorId: SIGNER_1,
    actorLabel: 'Alice',
    ipHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    userAgent: 'TestAgent/1.0',
    documentSha256: DOC_SHA,
    prevEventHash: hash1,
    payloadJson: { nested: { z: 2, a: 1 } },
    occurredAt: t2,
  };
  const hash2 = computeSigningEventHash(base2);

  return [
    {
      id: '00000000-0000-7000-8000-000000000101',
      org_id: ORG_ID,
      envelope_id: ENVELOPE_ID,
      signer_id: base1.signerId,
      seq: base1.seq,
      event_type: base1.eventType,
      actor_type: base1.actorType,
      actor_id: base1.actorId,
      actor_label: base1.actorLabel,
      ip_hash: base1.ipHash,
      user_agent: base1.userAgent,
      document_sha256: base1.documentSha256,
      prev_event_hash: base1.prevEventHash,
      event_hash: hash1,
      payload_json: { sourceKind: 'standalone', routingMode: 'sequential' },
      occurred_at: new Date(t1),
    },
    {
      id: '00000000-0000-7000-8000-000000000102',
      org_id: ORG_ID,
      envelope_id: ENVELOPE_ID,
      signer_id: base2.signerId,
      seq: base2.seq,
      event_type: base2.eventType,
      actor_type: base2.actorType,
      actor_id: base2.actorId,
      actor_label: base2.actorLabel,
      ip_hash: base2.ipHash,
      user_agent: base2.userAgent,
      document_sha256: base2.documentSha256,
      prev_event_hash: base2.prevEventHash,
      event_hash: hash2,
      payload_json: { nested: { a: 1, z: 2 } },
      occurred_at: t2,
    },
  ];
}

describe('sign events and canonicalization', () => {
  it('produces identical canonical JSON independent of object key order and Date values', () => {
    const a = { b: 1, a: { y: true, x: 'ok' }, d: new Date('2026-11-15T00:00:00.000Z'), drop: undefined };
    const b = { d: '2026-11-15T00:00:00.000Z', a: { x: 'ok', y: true }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/Non-finite/);
  });

  it('verifies intact chains across jsonb key reordering and detects tampering', () => {
    const chain = makeEventChain();
    const ok = verifyEventChain(chain);
    expect(ok).toEqual({
      valid: true,
      count: 2,
      tipHash: chain[1]!.event_hash,
      brokenSeq: null,
      reason: null,
    });

    const tamperedPayload: SigningEventChainRow[] = [
      chain[0]!,
      { ...chain[1]!, payload_json: { nested: { a: 99, z: 2 } } },
    ];
    expect(verifyEventChain(tamperedPayload)).toMatchObject({
      valid: false,
      brokenSeq: 2,
      reason: 'Hash mismatch at seq 2',
    });

    const tamperedLink: SigningEventChainRow[] = [
      chain[0]!,
      { ...chain[1]!, prev_event_hash: 'f'.repeat(64) },
    ];
    expect(verifyEventChain(tamperedLink)).toMatchObject({
      valid: false,
      brokenSeq: 2,
    });

    const brokenSeq: SigningEventChainRow[] = [chain[0]!, { ...chain[1]!, seq: 3 }];
    expect(verifyEventChain(brokenSeq)).toMatchObject({
      valid: false,
      brokenSeq: 3,
    });
  });
});

describe('sign sealing payloads and certificate artifacts', () => {
  it('maps ludy_sign initials to pdf_seal initial and encodes valid payloads', () => {
    const fields: SignFieldForSeal[] = [
      {
        id: 'f1',
        field_type: 'signature',
        page_number: 1,
        x_norm: '0.100000',
        y_norm: '0.700000',
        w_norm: '0.250000',
        h_norm: '0.080000',
        required: true,
        font_size_pt: null,
        value_text: null,
        value_checked: null,
        signature_png_base64: PNG_1X1_BASE64,
        filled_at: '2026-11-15T10:05:00.000Z',
      },
      {
        id: 'f2',
        field_type: 'initials',
        page_number: 1,
        x_norm: '0.400000',
        y_norm: '0.700000',
        w_norm: '0.120000',
        h_norm: '0.060000',
        required: true,
        font_size_pt: 12,
        value_text: 'NV',
        value_checked: null,
        signature_png_base64: null,
        filled_at: '2026-11-15T10:05:00.000Z',
      },
      {
        id: 'f3',
        field_type: 'checkbox',
        page_number: 2,
        x_norm: '0.100000',
        y_norm: '0.200000',
        w_norm: '0.030000',
        h_norm: '0.030000',
        required: true,
        font_size_pt: null,
        value_text: null,
        value_checked: true,
        signature_png_base64: null,
        filled_at: '2026-11-15T10:05:00.000Z',
      },
      {
        id: 'f4-optional-unfilled',
        field_type: 'text',
        page_number: 1,
        x_norm: '0.100000',
        y_norm: '0.100000',
        w_norm: '0.200000',
        h_norm: '0.050000',
        required: false,
        font_size_pt: 10,
        value_text: null,
        value_checked: null,
        signature_png_base64: null,
        filled_at: null,
      },
    ];

    const mapped = buildPdfSealFields(2, fields);
    expect(mapped).toHaveLength(3);
    expect(mapped[1]).toMatchObject({ type: 'initial', text: 'NV', fontSizePt: 12 });
    expect(mapped[2]).toMatchObject({ type: 'checkbox', checked: true });

    const signers: SignSignerForSeal[] = [
      {
        id: SIGNER_2,
        routing_order: 2,
        signer_role: 'cc',
        role_label: 'Observer',
        name: 'CC Reader',
        email: 'cc@example.com',
        delivery_mode: 'email',
        require_email_otp: false,
        status: 'signed',
        signed_at: '2026-11-15T10:06:00.000Z',
        otp_verified_at: null,
        signature_kind: null,
        signer_ip_hash: null,
        created_at: '2026-11-15T10:00:00.000Z',
      },
      {
        id: SIGNER_1,
        routing_order: 1,
        signer_role: 'signer',
        role_label: 'Director',
        name: 'Nguyen Van A',
        email: 'alice@example.com',
        delivery_mode: 'email',
        require_email_otp: true,
        status: 'signed',
        signed_at: '2026-11-15T10:05:00.000Z',
        otp_verified_at: '2026-11-15T10:04:00.000Z',
        signature_kind: 'draw',
        signer_ip_hash: '0123456789abcdef'.repeat(4),
        created_at: '2026-11-15T10:00:00.000Z',
      },
    ];

    const chain = makeEventChain();
    const tipHash = chain[1]!.event_hash;
    const completedAtIso = '2026-11-15T10:06:00.000Z';
    const certificateCode = generateCertificateCode(ENVELOPE_ID, completedAtIso, tipHash);
    const cert = buildPdfSealCertificate({
      certificateCode,
      envelopeTitle: 'Service Agreement',
      sourceSha256: DOC_SHA,
      completedAtIso,
      eventChainTipHash: tipHash,
      signers,
    });
    expect(cert.signers).toHaveLength(1);
    expect(cert.signers[0]).toMatchObject({
      name: 'Nguyen Van A',
      maskedEmail: 'a***e@example.com',
      otpStatus: 'verified',
      ipHashPrefix: '0123456789abcdef',
      signatureKind: 'draw',
    });

    const encoded = buildPdfSealInputBytes({
      sourcePdfBytes: new TextEncoder().encode('%PDF-1.4\n'),
      pageCount: 2,
      fields,
      certificate: cert,
    });
    const decoded = decodePdfSealInput(encoded);
    expect(decoded.fields).toEqual(mapped);
    expect(decoded.certificate).toEqual(cert);

    const artifact1 = buildCanonicalCertificateArtifact({
      envelopeId: ENVELOPE_ID,
      orgId: ORG_ID,
      certificateCode,
      envelopeTitle: 'Service Agreement',
      sourceSha256: DOC_SHA,
      sealedSha256: SEALED_SHA,
      completedAtIso,
      eventChainTipHash: tipHash,
      signers: cert.signers,
      events: chain.map((ev) => ({
        seq: ev.seq,
        eventType: ev.event_type,
        signerId: ev.signer_id,
        actorType: ev.actor_type,
        documentSha256: ev.document_sha256,
        prevEventHash: ev.prev_event_hash,
        eventHash: ev.event_hash,
        occurredAtIso: new Date(ev.occurred_at).toISOString(),
      })),
    });
    const artifact2 = buildCanonicalCertificateArtifact({
      envelopeId: ENVELOPE_ID,
      orgId: ORG_ID,
      certificateCode,
      envelopeTitle: 'Service Agreement',
      sourceSha256: DOC_SHA,
      sealedSha256: SEALED_SHA,
      completedAtIso,
      eventChainTipHash: tipHash,
      signers: cert.signers,
      events: chain.map((ev) => ({
        seq: ev.seq,
        eventType: ev.event_type,
        signerId: ev.signer_id,
        actorType: ev.actor_type,
        documentSha256: ev.document_sha256,
        prevEventHash: ev.prev_event_hash,
        eventHash: ev.event_hash,
        occurredAtIso: new Date(ev.occurred_at).toISOString(),
      })),
    });
    expect(artifact1.sha256).toBe(artifact2.sha256);
    expect(artifact1.json).toBe(artifact2.json);
  });

  it('produces high-entropy opaque signing tokens and deterministic SHA-256 hashes', () => {
    const t1 = generateRawSigningToken();
    const t2 = generateRawSigningToken();
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(40);
    expect(hashSigningToken(t1)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSigningToken(t1)).toBe(hashSigningToken(t1));
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('ab@example.com')).toBe('a***@example.com');
    expect(maskEmail(null)).toBeNull();
  });

  it('never imports a PDF parser directly inside modules/sign/src', () => {
    const srcDir = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      expect(content).not.toMatch(/\b(pdf-lib|pdfjs-dist|pdf-parse|pdfkit|mupdf)\b/);
    }
    expect(Object.keys(signManifest.tables.ludy_sign)).toEqual([
      'ai_analysis',
      'ca_connection',
      'ca_signing_request',
      'envelope',
      'envelope_obligation',
      'field',
      'member_signature',
      'org_stamp',
      'signer',
      'signing_event',
      'signing_otp',
      'signing_token',
      'template',
      'template_direct_link',
      'template_field',
      'template_role',
      'webhook',
      'webhook_delivery',
    ]);
  });

  it('rejects lone UTF-16 surrogates in zSignDetectedTag.label and accepts hyphenated 64-char roleKeys (#3552)', () => {
    expect(zSignTemplateRoleKey.safeParse('ben-a').success).toBe(true);
    expect(zSignTemplateRoleKey.safeParse('r'.repeat(64)).success).toBe(true);
    expect(zSignTemplateRoleKey.safeParse('r'.repeat(65)).success).toBe(false);

    expect(
      zSignDetectedTag.safeParse({
        pageNumber: 1,
        fieldType: 'text',
        roleOrder: 1,
        roleKey: 'r1',
        required: true,
        label: 'Bad\uDC00Low',
        xNorm: 0.1,
        yNorm: 0.1,
        wNorm: 0.2,
        hNorm: 0.05,
      }).success,
    ).toBe(false);
    expect(
      zSignDetectedTag.safeParse({
        pageNumber: 1,
        fieldType: 'text',
        roleOrder: 1,
        roleKey: 'r1',
        required: true,
        label: 'Hợp đồng chuẩn',
        xNorm: 0.1,
        yNorm: 0.1,
        wNorm: 0.2,
        hNorm: 0.05,
      }).success,
    ).toBe(true);
  });

  it('validates dropdown/radio choice options and embeds attachment SHA-256 in sealed certificate (#3818)', () => {
    expect(serializeFieldOptionsForType('dropdown', [' Chuyển khoản ', 'Tiền mặt'])).toBe(
      JSON.stringify(['Chuyển khoản', 'Tiền mặt']),
    );
    expect(parseFieldOptions('["Chuyển khoản","Tiền mặt"]')).toEqual(['Chuyển khoản', 'Tiền mặt']);
    expect(() => serializeFieldOptionsForType('dropdown', [])).toThrow(/1/);
    expect(() => serializeFieldOptionsForType('radio', ['A', 'A'])).toThrow(/unique/i);
    expect(() => serializeFieldOptionsForType('text', ['A'])).toThrow(/dropdown and radio/);

    const attSha = 'c'.repeat(64);
    const fields: SignFieldForSeal[] = [
      {
        id: 'f-sig',
        signer_id: SIGNER_1,
        field_type: 'signature',
        page_number: 1,
        x_norm: '0.100000',
        y_norm: '0.700000',
        w_norm: '0.240000',
        h_norm: '0.080000',
        required: true,
        font_size_pt: null,
        value_text: null,
        value_checked: null,
        signature_png_base64: PNG_1X1_BASE64,
        filled_at: '2026-11-21T10:05:00.000Z',
      },
      {
        id: 'f-dd',
        signer_id: SIGNER_1,
        field_type: 'dropdown',
        page_number: 1,
        x_norm: '0.100000',
        y_norm: '0.400000',
        w_norm: '0.240000',
        h_norm: '0.050000',
        required: true,
        font_size_pt: 11,
        value_text: 'Chuyển khoản ngân hàng',
        value_checked: null,
        signature_png_base64: null,
        filled_at: '2026-11-21T10:05:00.000Z',
      },
      {
        id: 'f-radio',
        signer_id: SIGNER_1,
        field_type: 'radio',
        page_number: 1,
        x_norm: '0.450000',
        y_norm: '0.400000',
        w_norm: '0.180000',
        h_norm: '0.040000',
        required: true,
        font_size_pt: 11,
        value_text: 'Đồng ý điều khoản',
        value_checked: null,
        signature_png_base64: null,
        filled_at: '2026-11-21T10:05:00.000Z',
      },
      {
        id: 'f-att',
        signer_id: SIGNER_1,
        field_type: 'attachment',
        page_number: 1,
        x_norm: '0.100000',
        y_norm: '0.520000',
        w_norm: '0.260000',
        h_norm: '0.060000',
        label: 'Giấy ĐKKD',
        required: true,
        font_size_pt: null,
        value_text: null,
        value_checked: null,
        signature_png_base64: null,
        attachment_file_id: '00000000-0000-7000-8000-000000000099',
        attachment_filename: 'giay-dkkd.pdf',
        attachment_sha256: attSha,
        filled_at: '2026-11-21T10:04:30.000Z',
      },
    ];

    const mapped = buildPdfSealFields(1, fields);
    expect(mapped).toHaveLength(3);
    expect(mapped[1]).toMatchObject({ type: 'dropdown', text: 'Chuyển khoản ngân hàng', fontSizePt: 11 });
    expect(mapped[2]).toMatchObject({ type: 'radio', text: 'Đồng ý điều khoản', checked: true });

    const signers: SignSignerForSeal[] = [
      {
        id: SIGNER_1,
        routing_order: 1,
        signer_role: 'signer',
        role_label: 'Bên B',
        name: 'Trần Thị B',
        email: 'tran@example.com',
        delivery_mode: 'email',
        require_email_otp: false,
        status: 'signed',
        signed_at: '2026-11-21T10:05:00.000Z',
        otp_verified_at: null,
        signature_kind: 'draw',
        signer_ip_hash: null,
        created_at: '2026-11-21T10:00:00.000Z',
      },
    ];

    const cert = buildPdfSealCertificate({
      certificateCode: 'CS-2026-TEST-3818',
      envelopeTitle: 'Hợp đồng dịch vụ',
      sourceSha256: DOC_SHA,
      completedAtIso: '2026-11-21T10:06:00.000Z',
      eventChainTipHash: 'd'.repeat(64),
      signers,
      fields,
    });
    expect(cert.signers[0]?.attachments).toEqual([
      {
        label: 'Giấy ĐKKD',
        filename: 'giay-dkkd.pdf',
        sha256: attSha,
      },
    ]);

    const encoded = buildPdfSealInputBytes({
      sourcePdfBytes: new TextEncoder().encode('%PDF-1.4\n%%EOF\n'),
      pageCount: 1,
      fields,
      certificate: cert,
    });
    const decoded = decodePdfSealInput(encoded);
    expect(decoded.fields).toEqual(mapped);
    expect(decoded.certificate.signers[0]?.attachments).toEqual(cert.signers[0]?.attachments);
  });

  it('serializes eSign webhook payloads in canonical key order and rejects PII/document keys (#4440)', () => {
    const eventId = '00000000-0000-7000-8000-000000000099';
    const raw = {
      sealedSha256: SEALED_SHA,
      certificateCode: 'CS-2026-TEST-4440',
      completedAt: '2026-11-22T12:00:00.000Z',
      status: 'completed',
      envelopeId: ENVELOPE_ID,
      orgId: ORG_ID,
      occurredAt: '2026-11-22T12:00:01.000Z',
      eventType: 'sign.envelope.completed',
      eventId,
    };
    const body = signWebhookBody(raw);
    expect(Object.keys(JSON.parse(body))).toEqual([
      'eventId',
      'eventType',
      'occurredAt',
      'orgId',
      'envelopeId',
      'status',
      'completedAt',
      'certificateCode',
      'sealedSha256',
    ]);
    expect(
      signWebhookPayload({
        status: 'ok',
        orgId: ORG_ID,
        occurredAt: '2026-11-22T12:00:00.000Z',
        eventType: 'ping',
        eventId,
      }),
    ).toEqual({
      eventId,
      eventType: 'ping',
      occurredAt: '2026-11-22T12:00:00.000Z',
      orgId: ORG_ID,
      status: 'ok',
    });

    for (const forbidden of [
      { title: 'Hop dong lao dong' },
      { email: 'signer@example.com' },
      { phone: '+15550199' },
      { token: 'secret-token' },
      { otp: '123456' },
      { pdfBase64: 'JVBERi0xLjQ=' },
    ]) {
      expect(() => signWebhookPayload({ ...raw, ...forbidden })).toThrow();
    }
  });
});
