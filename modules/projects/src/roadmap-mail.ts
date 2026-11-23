// SPDX-License-Identifier: AGPL-3.0-only
// Outbound 6-digit OTP email renderer + ephemeral in-memory AES-256-GCM transport wrapper for Projects Public Roadmap (#4399, ADR-0034, ADR-0057).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { zRoadmapOtpMailPayload, zRoadmapShippedMailPayload } from '@ludy/kernel-contract';

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

function markdownToPlainAndHtmlBlocks(markdown: string): { plain: string; html: string } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const plainLines: string[] = [];
  const htmlBlocks: string[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    htmlBlocks.push(`<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.6;color:#1e293b">${listItems.join('')}</ul>`);
    listItems = [];
  };

  const stripControls = (text: string): string => {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code > 0x1f && code !== 0x7f) out += text[i];
    }
    return out.trim();
  };

  const renderInline = (text: string): { plain: string; html: string } => {
    const cleaned = stripControls(text);
    // Strip markdown links to plain text label (+ safe https URL in HTML only when valid) so raw HTML tags are never interpreted.
    const plain = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/[*_`]/g, '');
    const tokens = cleaned.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g);
    const html = tokens
      .map((part) => {
        const linkMatch = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(part);
        if (linkMatch) {
          return `<a href="${escapeHtml(linkMatch[2]!)}" style="color:#0f766e;text-decoration:underline">${escapeHtml(linkMatch[1]!)}</a>`;
        }
        const boldMatch = /^\*\*([^*]+)\*\*$/.exec(part);
        if (boldMatch) {
          return `<strong>${escapeHtml(boldMatch[1]!)}</strong>`;
        }
        const codeMatch = /^`([^`]+)`$/.exec(part);
        if (codeMatch) {
          return `<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px">${escapeHtml(codeMatch[1]!)}</code>`;
        }
        return escapeHtml(part);
      })
      .join('');
    return { plain, html };
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      plainLines.push('');
      continue;
    }
    const headingMatch = /^#{1,3}\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushList();
      const inline = renderInline(headingMatch[1]!);
      plainLines.push(inline.plain);
      htmlBlocks.push(`<h2 style="margin:16px 0 8px;font-size:16px;font-weight:700;color:#0f172a">${inline.html}</h2>`);
      continue;
    }
    const bulletMatch = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const inline = renderInline(bulletMatch[1]!);
      plainLines.push(`- ${inline.plain}`);
      listItems.push(`<li style="margin:0 0 6px">${inline.html}</li>`);
      continue;
    }
    flushList();
    const inline = renderInline(line);
    plainLines.push(inline.plain);
    htmlBlocks.push(`<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1e293b">${inline.html}</p>`);
  }
  flushList();

  return {
    plain: plainLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    html: htmlBlocks.join('\n'),
  };
}

function buildPublicBaseUrl(publicUrl: string): string {
  let trimmed = publicUrl.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed || 'https://ludy.invalid';
}

export function renderRoadmapShippedMail(
  raw: unknown,
  context: {
    brand?: string;
    publicUrl: string;
    announcementTitle: string;
    bodyMd: string;
    linkedItems: readonly { id: string; publicTitle: string }[];
    unsubToken: string;
  },
): { subject: string; text: string; html: string } {
  const mail = zRoadmapShippedMailPayload.parse(raw);
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const boardTitle = oneLine(mail.boardTitle, 120);
  const title = oneLine(context.announcementTitle, 200);
  const baseUrl = buildPublicBaseUrl(context.publicUrl);
  const boardPath = `/-/roadmap/${encodeURIComponent(mail.orgSlug)}/${encodeURIComponent(mail.boardSlug)}`;
  const changelogUrl = `${baseUrl}${boardPath}?tab=changelog`;
  const unsubscribeUrl = `${baseUrl}${boardPath}#unsubscribe=${encodeURIComponent(context.unsubToken)}`;
  const renderedBody = markdownToPlainAndHtmlBlocks(context.bodyMd);
  const items = context.linkedItems.slice(0, 20);
  const isEn = mail.lang === 'en';

  const itemsPlain =
    items.length > 0
      ? [isEn ? 'Shipped ideas included:' : 'Các tính năng đã phát hành:', ...items.map((item) => `- ${oneLine(item.publicTitle, 200)}`)].join('\n')
      : '';
  const itemsHtml =
    items.length > 0
      ? `<div style="margin:16px 0;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#166534">${escapeHtml(isEn ? 'Shipped ideas included' : 'Tính năng đã hoàn thành')}</p>
      <ul style="margin:0;padding-left:18px;font-size:14px;color:#14532d">${items.map((item) => `<li style="margin:0 0 4px">${escapeHtml(oneLine(item.publicTitle, 200))}</li>`).join('')}</ul>
    </div>`
      : '';

  if (isEn) {
    const subject = `[${boardTitle}] ${title}`;
    const text = [
      `${boardTitle} (${orgName}) - New release update`,
      '',
      title,
      '',
      renderedBody.plain,
      itemsPlain ? `\n${itemsPlain}` : '',
      '',
      `View changelog: ${changelogUrl}`,
      `Unsubscribe from shipped updates: ${unsubscribeUrl}`,
      '',
      brand,
    ]
      .filter((s, idx, arr) => s !== '' || (idx > 0 && arr[idx - 1] !== ''))
      .join('\n');

    const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)} · ${escapeHtml(orgName)}</p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${escapeHtml(title)}</h1>
    ${renderedBody.html}
    ${itemsHtml}
    <p style="margin:18px 0 0"><a href="${escapeHtml(changelogUrl)}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">View public changelog</a></p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0" />
    <p style="margin:0;font-size:12px;color:#64748b">You received this update because you opted in on ${escapeHtml(boardTitle)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#475569">Unsubscribe</a>.</p>
  </div>
</body></html>`;
    return { subject, text, html };
  }

  const subject = `[${boardTitle}] ${title}`;
  const text = [
    `${boardTitle} (${orgName}) - Cập nhật tính năng mới`,
    '',
    title,
    '',
    renderedBody.plain,
    itemsPlain ? `\n${itemsPlain}` : '',
    '',
    `Xem nhật ký cập nhật: ${changelogUrl}`,
    `Hủy nhận email khi có tính năng mới: ${unsubscribeUrl}`,
    '',
    brand,
  ]
    .filter((s, idx, arr) => s !== '' || (idx > 0 && arr[idx - 1] !== ''))
    .join('\n');

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)} · ${escapeHtml(orgName)}</p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${escapeHtml(title)}</h1>
    ${renderedBody.html}
    ${itemsHtml}
    <p style="margin:18px 0 0"><a href="${escapeHtml(changelogUrl)}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Xem nhật ký cập nhật công khai</a></p>
    <hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0" />
    <p style="margin:0;font-size:12px;color:#64748b">Bạn nhận được email này vì đã đăng ký nhận thông báo tại ${escapeHtml(boardTitle)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#475569">Hủy đăng ký</a>.</p>
  </div>
</body></html>`;
  return { subject, text, html };
}
