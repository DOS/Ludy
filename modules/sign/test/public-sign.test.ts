// SPDX-License-Identifier: AGPL-3.0-only
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SIGN_OTP_CODE_PATTERN,
  SIGN_PAGE_PATH,
  SIGN_PUBLIC_FIELDS_MAX,
  SIGN_SIGNATURE_PNG_MAX_BYTES,
  SIGN_SIGNATURE_PNG_MAX_HEIGHT,
  SIGN_SIGNATURE_PNG_MAX_WIDTH,
  SIGN_TOKEN_PATTERN,
  zSignPublicSubmitInput,
} from '@crove/kernel-contract';
import {
  SIGN_COMPLETED_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_OTP_MAIL_TEMPLATE,
  SIGN_REMIND_MAIL_TEMPLATE,
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  maskEmail,
  renderSignCompletedMail,
  renderSignInviteMail,
  renderSignOtpMail,
  validateSignaturePngBase64,
  zSignCompletedMailPayload,
  zSignInviteMailPayload,
  zSignOtpMailPayload,
} from '../src/index.ts';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function makePng(width: number, height: number, extraChunks: Buffer[] = [], idatOverride?: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rawBytes = width > 0 && height > 0 ? Buffer.alloc(height * (1 + width * 4), 0) : Buffer.from([0, 0, 0, 0, 255]);
  const idat = pngChunk('IDAT', idatOverride ?? deflateSync(rawBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    idat,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ENVELOPE_ID = '11111111-1111-4111-8111-111111111111';
const SIGNER_ID = '22222222-2222-4222-8222-222222222222';
const OTP_ID = '33333333-3333-4333-8333-333333333333';
const SEALED_SHA256 = 'a'.repeat(64);

describe('sign PNG signature validation and ADR-0034 mail templates (#3324)', () => {
  it('validates clean PNG bytes and rejects polyglots, SVG, HTML, text-chunk scripts, bad CRC, and oversized PNGs', () => {
    const okPng = makePng(320, 120);
    const okRaw = validateSignaturePngBase64(okPng.toString('base64'));
    expect(okRaw.width).toBe(320);
    expect(okRaw.height).toBe(120);
    expect(okRaw.byteLength).toBe(okPng.byteLength);
    expect(okRaw.base64).toBe(okPng.toString('base64'));

    const okDataUrl = validateSignaturePngBase64(`data:image/png;base64,${okPng.toString('base64')}`);
    expect(okDataUrl.base64).toBe(okPng.toString('base64'));
    expect(okDataUrl.byteLength).toBe(okPng.byteLength);

    const maxBoundary = makePng(SIGN_SIGNATURE_PNG_MAX_WIDTH, SIGN_SIGNATURE_PNG_MAX_HEIGHT);
    expect(validateSignaturePngBase64(maxBoundary.toString('base64'))).toMatchObject({
      width: SIGN_SIGNATURE_PNG_MAX_WIDTH,
      height: SIGN_SIGNATURE_PNG_MAX_HEIGHT,
    });

    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    expect(() => validateSignaturePngBase64(svgBytes.toString('base64'))).toThrow();
    expect(() => validateSignaturePngBase64(`data:image/svg+xml;base64,${svgBytes.toString('base64')}`)).toThrow();
    expect(() => validateSignaturePngBase64(Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8').toString('base64'))).toThrow();
    expect(() => validateSignaturePngBase64(`data:IMAGE/PNG;base64,${okPng.toString('base64')}`)).toThrow();

    // Polyglot trailing bytes after IEND must fail.
    const polyglot = Buffer.concat([okPng, Buffer.from('<script>alert(1)</script>', 'utf8')]);
    expect(() => validateSignaturePngBase64(polyglot.toString('base64'))).toThrow();

    // Embedded SVG/script markers inside PNG tEXt, zTXt, and compressed iTXt chunks must fail.
    const textChunkScript = makePng(100, 40, [
      pngChunk('tEXt', Buffer.from('Comment\0<script>alert(1)</script>', 'utf8')),
    ]);
    expect(() => validateSignaturePngBase64(textChunkScript.toString('base64'))).toThrow();

    const ztxtChunkSvg = makePng(100, 40, [
      pngChunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'utf8'), deflateSync(Buffer.from('<svg onload=alert(1)>', 'utf8'))])),
    ]);
    expect(() => validateSignaturePngBase64(ztxtChunkSvg.toString('base64'))).toThrow();

    const itxtCompressedScript = makePng(100, 40, [
      pngChunk(
        'iTXt',
        Buffer.concat([
          Buffer.from('Comment\0\x01\x00en\0Comment\0', 'utf8'),
          deflateSync(Buffer.from('<script>alert(1)</script>', 'utf8')),
        ]),
      ),
    ]);
    expect(() => validateSignaturePngBase64(itxtCompressedScript.toString('base64'))).toThrow();

    // Benign compressed zTXt metadata still passes.
    const benignZtxt = makePng(100, 40, [
      pngChunk('zTXt', Buffer.concat([Buffer.from('Software\0\0', 'utf8'), deflateSync(Buffer.from('Ludy Sign 1.0', 'utf8'))])),
    ]);
    expect(validateSignaturePngBase64(benignZtxt.toString('base64')).byteLength).toBe(benignZtxt.byteLength);

    // Corrupted CRC32 inside chunk must fail.
    const badCrc = Buffer.from(okPng);
    badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 0xff;
    expect(() => validateSignaturePngBase64(badCrc.toString('base64'))).toThrow();

    // Non-ASCII chunk type bytes (e.g. 'I' | 0x80 = 0xc9) with recomputed valid CRC32 must still fail.
    const highBitIhdr = Buffer.from(okPng);
    const ihdrLength = highBitIhdr.readUInt32BE(8);
    highBitIhdr[12] = highBitIhdr[12]! | 0x80;
    highBitIhdr.writeUInt32BE(crc32(highBitIhdr.subarray(12, 16 + ihdrLength)), 16 + ihdrLength);
    expect(() => validateSignaturePngBase64(highBitIhdr.toString('base64'))).toThrow();

    // Non-canonical whitespace / bad base64 characters must fail.
    expect(() => validateSignaturePngBase64(`${okPng.toString('base64')} `)).toThrow();
    expect(() => validateSignaturePngBase64('not!valid!base64')).toThrow();

    // Dimensions out of bounds (zero or over max width/height).
    expect(() => validateSignaturePngBase64(makePng(0, 100).toString('base64'))).toThrow();
    expect(() => validateSignaturePngBase64(makePng(SIGN_SIGNATURE_PNG_MAX_WIDTH + 1, 100).toString('base64'))).toThrow();
    expect(() => validateSignaturePngBase64(makePng(100, SIGN_SIGNATURE_PNG_MAX_HEIGHT + 1).toString('base64'))).toThrow();

    // Oversized payload > SIGN_SIGNATURE_PNG_MAX_BYTES must fail.
    const fillerChunk = pngChunk('tEXt', Buffer.alloc(SIGN_SIGNATURE_PNG_MAX_BYTES + 128, 0x41));
    const oversized = makePng(10, 10, [fillerChunk]);
    expect(oversized.byteLength).toBeGreaterThan(SIGN_SIGNATURE_PNG_MAX_BYTES);
    expect(() => validateSignaturePngBase64(oversized.toString('base64'))).toThrow();

    // Corrupt non-zlib IDAT stream, invalid scanline filter byte, missing PLTE for indexed PNG, and truncated IDAT must fail.
    const corruptIdat = makePng(1, 1, [], Buffer.from([0x41]));
    expect(() => validateSignaturePngBase64(corruptIdat.toString('base64'))).toThrow();
    const truncatedIdat = makePng(100, 40, [], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(truncatedIdat.toString('base64'))).toThrow();
    const badFilterPng = makePng(1, 1, [], deflateSync(Buffer.from([5, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(badFilterPng.toString('base64'))).toThrow();
    const validPaethPng = makePng(1, 1, [], deflateSync(Buffer.from([4, 0, 0, 0, 255])));
    expect(validateSignaturePngBase64(validPaethPng.toString('base64'))).toMatchObject({ width: 1, height: 1 });

    // Adam7 3x3 RGBA passes: p0(1x1=5B) + p3(1x1=5B) + p4(2x1=9B) + p5(1x2=10B) + p6(3x1=13B) = 42 bytes.
    const ihdrAdam7 = Buffer.from([0, 0, 0, 3, 0, 0, 0, 3, 8, 6, 0, 0, 1]);
    const adam7Valid = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdrAdam7),
      pngChunk('IDAT', deflateSync(Buffer.alloc(42, 0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(validateSignaturePngBase64(adam7Valid.toString('base64'))).toMatchObject({ width: 3, height: 3 });
    const adam7BadScanlines = Buffer.alloc(42, 0);
    adam7BadScanlines[5] = 7;
    const adam7InvalidFilter = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdrAdam7),
      pngChunk('IDAT', deflateSync(adam7BadScanlines)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => validateSignaturePngBase64(adam7InvalidFilter.toString('base64'))).toThrow();

    // Indexed colorType=3 without PLTE chunk must fail; with valid PLTE must pass.
    const ihdrIndexed = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]);
    const indexedNoPlte = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdrIndexed),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 0]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => validateSignaturePngBase64(indexedNoPlte.toString('base64'))).toThrow();
    const indexedWithPlte = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdrIndexed),
      pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 1]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(validateSignaturePngBase64(indexedWithPlte.toString('base64'))).toMatchObject({ width: 1, height: 1 });

    // Indexed PNG with valid PLTE + tRNS + gAMA + sRGB + pHYs passes; malformed ancillary/critical chunks fail.
    const indexedRich = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdrIndexed),
      pngChunk('gAMA', Buffer.from([0x00, 0x00, 0xb1, 0x8f])),
      pngChunk('sRGB', Buffer.from([0])),
      pngChunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
      pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
      pngChunk('tRNS', Buffer.from([0])),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 1]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(validateSignaturePngBase64(indexedRich.toString('base64'))).toMatchObject({ width: 1, height: 1 });

    // hIST without PLTE (which crashes pdf-lib), unknown critical/ancillary chunks, and invalid tRNS/bKGD/non-contiguous IDAT fail.
    const histNoPlte = makePng(1, 1, [pngChunk('hIST', Buffer.from([0, 1]))], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(histNoPlte.toString('base64'))).toThrow(/unsupported chunk hIST/i);
    const trnsOnRgba = makePng(1, 1, [pngChunk('tRNS', Buffer.from([0, 0]))], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(trnsOnRgba.toString('base64'))).toThrow(/tRNS/i);
    const badBkgd = makePng(1, 1, [pngChunk('bKGD', Buffer.from([0]))], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(badBkgd.toString('base64'))).toThrow(/bKGD/i);
    const unknownAncillary = makePng(1, 1, [pngChunk('sPLT', Buffer.from('test\0\x08', 'utf8'))], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(unknownAncillary.toString('base64'))).toThrow(/unsupported chunk sPLT/i);
    const nonContiguousIdat = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
      pngChunk('tIME', Buffer.from([0x07, 0xeb, 11, 16, 12, 0, 0])),
      pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => validateSignaturePngBase64(nonContiguousIdat.toString('base64'))).toThrow(/non-contiguous IDAT/i);

    // Animated PNG (APNG with acTL / fcTL / fdAT) must be rejected before token consumption since pdf-lib cannot embed APNGs.
    const acTlData = Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]);
    const apng = makePng(1, 1, [pngChunk('acTL', acTlData)], deflateSync(Buffer.from([0, 0, 0, 0, 255])));
    expect(() => validateSignaturePngBase64(apng.toString('base64'))).toThrow(/animated \(APNG\)/i);

    // Public submit schema accepts up to SIGN_PUBLIC_FIELDS_MAX (500, matching sign.field.set) and rejects 501.
    const field201 = Array.from({ length: 201 }, () => ({ fieldId: ENVELOPE_ID, valueText: 'ok' }));
    const field501 = Array.from({ length: SIGN_PUBLIC_FIELDS_MAX + 1 }, () => ({ fieldId: ENVELOPE_ID, valueText: 'ok' }));
    const validTok = generateRawSigningToken();
    expect(
      zSignPublicSubmitInput.safeParse({ token: validTok, consentAccepted: true, signatureKind: 'type', signatureTypedText: 'Nguyen Van A', fields: field201 }).success,
    ).toBe(true);
    expect(
      zSignPublicSubmitInput.safeParse({ token: validTok, consentAccepted: true, signatureKind: 'type', signatureTypedText: 'Nguyen Van A', fields: field501 }).success,
    ).toBe(false);
  });

  it('renders XSS-safe ADR-0034 sign emails with fragment URLs and refuses raw secrets in queued payloads', () => {
    const rawToken = generateRawSigningToken();
    expect(SIGN_TOKEN_PATTERN.test(rawToken)).toBe(true);
    expect(hashSigningToken(rawToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(maskEmail('alice.nguyen@example.com')).not.toContain('alice.nguyen');
    expect(maskEmail('a@example.org')).toBe('a***@example.org');
    expect(generateCertificateCode(ENVELOPE_ID, '2027-01-05T00:00:00.000Z', SEALED_SHA256)).toMatch(
      /^CS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );

    // Queued DB payloads strictly omit rawToken and otpCode.
    expect(
      zSignInviteMailPayload.safeParse({
        lang: 'vi',
        orgName: 'Cong ty ABC',
        envelopeId: ENVELOPE_ID,
        signerId: SIGNER_ID,
        docTitle: 'NDA',
        roleLabel: 'Signer',
        expiresAt: null,
        rawToken,
      }).success,
    ).toBe(false);
    expect(
      zSignOtpMailPayload.safeParse({
        lang: 'vi',
        orgName: 'Cong ty ABC',
        signerId: SIGNER_ID,
        otpId: OTP_ID,
        docTitle: 'NDA',
        expiresAt: '2027-01-05T00:10:00.000Z',
        otpCode: '123456',
      }).success,
    ).toBe(false);
    expect(
      zSignCompletedMailPayload.safeParse({
        lang: 'vi',
        orgName: 'Cong ty ABC',
        envelopeId: ENVELOPE_ID,
        docTitle: 'NDA',
        certificateCode: 'CS-ABCD-EFGH-2345',
        sealedSha256: SEALED_SHA256,
        completedAtIso: '2027-01-05T00:00:00.000Z',
        signerCount: 2,
        rawToken,
      }).success,
    ).toBe(false);

    const invitePayload = {
      lang: 'vi' as const,
      orgName: 'Acme <script>alert(1)</script>',
      envelopeId: ENVELOPE_ID,
      signerId: SIGNER_ID,
      docTitle: 'Hop dong & "2027"',
      roleLabel: 'Giam doc',
      expiresAt: '2027-02-01T00:00:00.000Z',
    };
    expect(zSignInviteMailPayload.safeParse(invitePayload).success).toBe(true);

    const invite = renderSignInviteMail(invitePayload, {
      publicUrl: 'https://app.ludy.example/',
      token: rawToken,
      signerName: 'Nguyen & "An"',
      message: '<b>Sign here</b>',
    });
    expect(SIGN_INVITE_MAIL_TEMPLATE).toBe('sign.invite');
    expect(SIGN_REMIND_MAIL_TEMPLATE).toBe('sign.remind');
    expect(invite.html).toContain(`https://app.ludy.example${SIGN_PAGE_PATH}#${rawToken}`);
    expect(invite.text).toContain(`https://app.ludy.example${SIGN_PAGE_PATH}#${rawToken}`);
    expect(invite.html).not.toContain('?token=');
    expect(invite.html).not.toContain('<script>');
    expect(invite.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(invite.html).toContain('&amp; &quot;An&quot;');
    expect(invite.html).toContain('&lt;b&gt;Sign here&lt;/b&gt;');

    expect(() =>
      renderSignInviteMail(invitePayload, {
        publicUrl: 'javascript:alert(1)',
        token: rawToken,
      }),
    ).toThrow();
    expect(() =>
      renderSignInviteMail(invitePayload, {
        publicUrl: `https://app.ludy.example${SIGN_PAGE_PATH}`,
        token: 'short',
      }),
    ).toThrow();

    const otpCode = '482913';
    expect(SIGN_OTP_CODE_PATTERN.test(otpCode)).toBe(true);
    const otpPayload = {
      lang: 'vi' as const,
      orgName: 'Acme <img>',
      signerId: SIGNER_ID,
      otpId: OTP_ID,
      docTitle: 'Hop dong <tag>',
      expiresAt: '2027-01-05T00:10:00.000Z',
    };
    expect(zSignOtpMailPayload.safeParse(otpPayload).success).toBe(true);
    const otpMail = renderSignOtpMail(otpPayload, { code: otpCode, signerName: 'Alice' });
    expect(SIGN_OTP_MAIL_TEMPLATE).toBe('sign.otp');
    expect(otpMail.text).toContain(otpCode);
    expect(otpMail.html).toContain(otpCode);
    expect(otpMail.html).not.toContain('<img>');
    expect(otpMail.html).not.toContain('<tag>');
    expect(() => renderSignOtpMail(otpPayload, { code: '12345' })).toThrow();

    const completedPayload = {
      lang: 'vi' as const,
      orgName: 'Acme & Co',
      envelopeId: ENVELOPE_ID,
      docTitle: 'MSA <2027>',
      certificateCode: 'CS-1234-ABCD-5678',
      sealedSha256: SEALED_SHA256,
      completedAtIso: '2026-11-17T01:00:00+07:00',
      signerCount: 2,
    };
    expect(zSignCompletedMailPayload.safeParse(completedPayload).success).toBe(true);
    const completedMail = renderSignCompletedMail(completedPayload, {
      publicUrl: 'https://app.ludy.example/',
    });
    expect(SIGN_COMPLETED_MAIL_TEMPLATE).toBe('sign.completed');
    expect(completedMail.html).toContain('CS-1234-ABCD-5678');
    expect(completedMail.html).toContain(SEALED_SHA256);
    expect(completedMail.html).toContain('Acme &amp; Co');
    expect(completedMail.html).toContain('MSA &lt;2027&gt;');
    expect(completedMail.text).toContain('01:00 17/11/2026');
    expect(completedMail.html).toContain('01:00 17/11/2026');
    expect(completedMail.text).not.toContain('16/11/2026');
    expect(completedMail.text).toContain('CS-1234-ABCD-5678');
    expect(completedMail.text).toContain(SEALED_SHA256);
    expect(completedMail.html).not.toContain('<2027>');

    // Invite expiry timestamps format exact HH:mm dd/MM/yyyy in Asia/Ho_Chi_Minh in both text and HTML.
    const earlyMorningInvite = renderSignInviteMail(
      { ...invitePayload, expiresAt: '2027-02-01T00:30:00+07:00' },
      { publicUrl: 'https://app.ludy.example/', token: rawToken },
    );
    expect(earlyMorningInvite.text).toContain('00:30 01/02/2027');
    expect(earlyMorningInvite.html).toContain('00:30 01/02/2027');
    expect(earlyMorningInvite.text).not.toContain('31/01/2027');
    expect(earlyMorningInvite.text).not.toContain('den het ngay');
    expect(earlyMorningInvite.html).not.toContain('den het ngay');

    const middayInvite = renderSignInviteMail(
      { ...invitePayload, expiresAt: '2026-11-17T02:00:00.000Z' },
      { publicUrl: 'https://app.ludy.example/', token: rawToken },
    );
    expect(middayInvite.text).toContain('09:00 17/11/2026');
    expect(middayInvite.html).toContain('09:00 17/11/2026');
    expect(middayInvite.text).not.toContain('den het ngay');
    expect(middayInvite.html).not.toContain('den het ngay');
  });
});
