// SPDX-License-Identifier: AGPL-3.0-only
// Outbound 6-digit OTP email renderer + ephemeral in-memory AES-256-GCM transport wrapper for Projects Public Roadmap (#4399, ADR-0034, ADR-0057).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { zRoadmapOtpMailPayload } from '@ludy/kernel-contract';

const WRAP_KEY_BYTES = 32;
const WRAP_ALPHABET = 'abcdefghijklmnop';
const SEALED_OTP_SHAPE = /^gcm1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

function oneLine(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeWrapKey(wrapKey: string): Buffer {
  if (!/^[a-p]{64}$/.test(wrapKey)) {
    throw new Error('Invalid ephemeral OTP wrap key');
  }
  const out = Buffer.allocUnsafe(WRAP_KEY_BYTES);
  for (let i = 0; i < WRAP_KEY_BYTES; i += 1) {
    const hi = wrapKey.charCodeAt(i * 2) - 97;
    const lo = wrapKey.charCodeAt(i * 2 + 1) - 97;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Generates a 256-bit throwaway symmetric key encoded strictly as [a-p]{64} (zero digits, compatible with CommandDef.sealedInput). */
export function generateEphemeralOtpWrapKey(): string {
  const bytes = randomBytes(WRAP_KEY_BYTES);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    out += WRAP_ALPHABET[b >> 4]! + WRAP_ALPHABET[b & 0x0f]!;
  }
  bytes.fill(0);
  return out;
}

/** Seals a 6-digit OTP code under an ephemeral worker-RAM key so plaintext OTPs never cross Runtime command outputs. */
export function sealEphemeralOtpCode(code: string, wrapKey: string, aad: string): string {
  const key = decodeWrapKey(wrapKey);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `gcm1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  } finally {
    key.fill(0);
  }
}

/** Opens an ephemerally sealed 6-digit OTP code in worker RAM using the same throwaway key and AAD. */
export function openEphemeralOtpCode(sealed: string, wrapKey: string, aad: string): string {
  const match = SEALED_OTP_SHAPE.exec(sealed);
  if (!match) {
    throw new Error('Malformed ephemeral OTP envelope');
  }
  const key = decodeWrapKey(wrapKey);
  try {
    const iv = Buffer.from(match[1]!, 'base64url');
    const ct = Buffer.from(match[2]!, 'base64url');
    const tag = Buffer.from(match[3]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } finally {
    key.fill(0);
  }
}

export function renderRoadmapOtpMail(
  raw: unknown,
  context: {
    brand?: string;
    code: string;
  },
): { text: string; html: string } {
  const mail = zRoadmapOtpMailPayload.parse(raw);
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const boardTitle = oneLine(mail.boardTitle, 120);
  const code = oneLine(context.code, 12);
  const isEn = mail.lang === 'en';

  if (isEn) {
    const text = [
      `Your verification code for ${boardTitle} (${orgName})`,
      '',
      `Verification code: ${code}`,
      '',
      'This code expires in 10 minutes. Enter it on the public roadmap page to vote or submit an idea.',
      'If you did not request this code, you can safely ignore this email.',
      '',
      brand,
    ].join('\n');

    const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">Verification code</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Enter this 6-digit code on <strong>${escapeHtml(boardTitle)}</strong> (${escapeHtml(orgName)}) to vote or submit an idea:</p>
    <div style="margin:0 0 18px;padding:16px;background:#f1f5f9;border-radius:8px;text-align:center;font-size:28px;font-weight:700;letter-spacing:6px;color:#0f172a">${escapeHtml(code)}</div>
    <p style="margin:0;font-size:12px;color:#64748b">The code expires in 10 minutes. If you did not request this code, please ignore this email.</p>
  </div>
</body></html>`;
    return { text, html };
  }

  const text = [
    `Ma xac thuc cho bang lo trinh ${boardTitle} (${orgName})`,
    '',
    `Ma xac thuc 6 so: ${code}`,
    '',
    'Ma co hieu luc trong 10 phut. Hay nhap ma nay de binh chon hoac gui y tuong moi.',
    'Neu ban khong yeu cau ma nay, vui long bo qua email.',
    '',
    brand,
  ].join('\n');

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">Ma xac thuc email</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Nhap ma 6 chu so ben duoi tai <strong>${escapeHtml(boardTitle)}</strong> (${escapeHtml(orgName)}) de binh chon hoac gui y tuong:</p>
    <div style="margin:0 0 18px;padding:16px;background:#f1f5f9;border-radius:8px;text-align:center;font-size:28px;font-weight:700;letter-spacing:6px;color:#0f172a">${escapeHtml(code)}</div>
    <p style="margin:0;font-size:12px;color:#64748b">Ma co hieu luc trong 10 phut. Neu ban khong thuc hien thao tac nay, co the bo qua email.</p>
  </div>
</body></html>`;
  return { text, html };
}
