// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0034 outbound mail merge schemas, payload renderers, and queueing helpers for eSign Slice 1b (#3324).
// Raw signing tokens and 6-digit OTP codes NEVER persist in crove_kernel.mail_message.payload:
// tokens and OTP codes are generated/minted in memory at send time via system mail_data commands.
import { z } from 'zod';
import { createMailMessage } from '@ludy/kernel';
import { SIGN_OTP_CODE_PATTERN, SIGN_PAGE_PATH, SIGN_TOKEN_PATTERN, zId } from '@ludy/kernel-contract';
import type { CommandContext } from '@ludy/kernel-runtime';

export const SIGN_INVITE_MAIL_TEMPLATE = 'sign.invite';
export const SIGN_OTP_MAIL_TEMPLATE = 'sign.otp';
export const SIGN_DIRECT_OTP_MAIL_TEMPLATE = 'sign.direct_otp';
export const SIGN_COMPLETED_MAIL_TEMPLATE = 'sign.completed';
export const SIGN_REMIND_MAIL_TEMPLATE = 'sign.remind';

export const SIGN_INVITE_MAIL_SOURCE = 'sign.envelope.send';
export const SIGN_OTP_MAIL_SOURCE = 'sign.public.request_otp';
export const SIGN_DIRECT_OTP_MAIL_SOURCE = 'sign.direct.request_otp';
export const SIGN_COMPLETED_MAIL_SOURCE = 'sign.envelope.seal_complete';
export const SIGN_REMIND_MAIL_SOURCE = 'sign.envelope.remind';

export const zSignInviteMailPayload = z.strictObject({
  lang: z.literal('vi'),
  orgName: z.string().min(1).max(200),
  envelopeId: zId,
  signerId: zId,
  docTitle: z.string().min(1).max(300),
  roleLabel: z.string().min(1).max(120),
  signerRole: z.enum(['signer', 'approver']).optional(),
  expiresAt: z.string().min(1).max(64).nullable(),
});

export const zSignOtpMailPayload = z.strictObject({
  lang: z.literal('vi'),
  orgName: z.string().min(1).max(200),
  signerId: zId,
  otpId: zId,
  docTitle: z.string().min(1).max(300),
  expiresAt: z.string().min(1).max(64),
});

export const zSignDirectOtpMailPayload = z.strictObject({
  lang: z.literal('vi'),
  orgName: z.string().min(1).max(200),
  directLinkId: zId,
  otpId: zId,
  docTitle: z.string().min(1).max(300),
  expiresAt: z.string().min(1).max(64),
});

export const zSignCompletedMailPayload = z.strictObject({
  lang: z.literal('vi'),
  orgName: z.string().min(1).max(200),
  envelopeId: zId,
  docTitle: z.string().min(1).max(300),
  certificateCode: z.string().min(1).max(64),
  sealedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  completedAtIso: z.string().min(1).max(64),
  signerCount: z.number().int().min(1).max(200),
});

export interface RenderedSignMail {
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function oneLine(value: string, max = 200): string {
  const flat = value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function cleanBaseUrl(publicUrl: string): string {
  let base = publicUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!/^https?:\/\/[^/\s]+/i.test(base)) {
    throw new Error('sign mail: invalid publicUrl protocol');
  }
  return base;
}

const VN_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatViTime(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = VN_TIME_FORMATTER.formatToParts(parsed);
  const dd = parts.find((p) => p.type === 'day')?.value;
  const mm = parts.find((p) => p.type === 'month')?.value;
  const yyyy = parts.find((p) => p.type === 'year')?.value;
  const hh = parts.find((p) => p.type === 'hour')?.value;
  const min = parts.find((p) => p.type === 'minute')?.value;
  return dd && mm && yyyy && hh && min ? `${hh}:${min} ${dd}/${mm}/${yyyy}` : null;
}

export function renderSignInviteMail(
  raw: unknown,
  context: {
    publicUrl: string;
    brand?: string;
    token: string;
    signerName?: string;
    signerRole?: 'signer' | 'approver';
    message?: string | null;
    isReminder?: boolean;
  },
): RenderedSignMail {
  const mail = zSignInviteMailPayload.parse(raw);
  if (!SIGN_TOKEN_PATTERN.test(context.token)) {
    throw new Error('sign mail: malformed signing token');
  }
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const title = oneLine(mail.docTitle, 300);
  const roleLabel = oneLine(mail.roleLabel, 120);
  const isApprover = (context.signerRole ?? mail.signerRole) === 'approver';
  const signerName = context.signerName ? oneLine(context.signerName, 200) : null;
  const note = context.message ? oneLine(context.message, 1000) : null;
  const expiryTime = formatViTime(mail.expiresAt);
  const url = `${cleanBaseUrl(context.publicUrl)}${SIGN_PAGE_PATH}#${context.token}`;
  const heading = isApprover
    ? context.isReminder
      ? `${orgName} nhac ban phe duyet tai lieu`
      : `${orgName} gui ban tai lieu can phe duyet`
    : context.isReminder
      ? `${orgName} nhac ban ky tai lieu`
      : `${orgName} gui ban tai lieu can ky`;
  const greeting = signerName ? `Xin chao ${signerName},` : 'Xin chao,';
  const actionLine = isApprover
    ? `${orgName} moi ban xem va phe duyet tai lieu "${title}" (vai tro: ${roleLabel}).`
    : `${orgName} moi ban xem va ky tai lieu "${title}" (vai tro: ${roleLabel}).`;
  const htmlActionLine = isApprover
    ? `<strong>${escapeHtml(orgName)}</strong> gui ban xem va phe duyet tai lieu <strong>${escapeHtml(title)}</strong> (vai tro: ${escapeHtml(roleLabel)}).`
    : `<strong>${escapeHtml(orgName)}</strong> gui ban xem va ky tai lieu <strong>${escapeHtml(title)}</strong> (vai tro: ${escapeHtml(roleLabel)}).`;
  const expiryLabel = isApprover ? 'Han phe duyet den' : 'Han ky den';
  const openLine = isApprover ? `Mo tai lieu de xem va phe duyet: ${url}` : `Mo tai lieu de ky: ${url}`;
  const ctaLabel = isApprover ? 'Xem va phe duyet tai lieu' : 'Xem va ky tai lieu';
  const securityFooter = isApprover
    ? 'Lien ket mo trang phe duyet chi dung mot lan va duoc truyen an toan qua doan ma hoa URL.'
    : 'Lien ket mo trang ky chi dung mot lan va duoc truyen an toan qua doan ma hoa URL.';

  const textLines = [
    heading,
    '',
    greeting,
    actionLine,
    ...(note ? ['', `Loi nhan: ${note}`] : []),
    ...(expiryTime ? [`${expiryLabel}: ${expiryTime} (gio Viet Nam)`] : []),
    '',
    openLine,
    '',
    `Email tu ${brand}. Lien ket chi dung mot lan.`,
  ];

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;color:#0f172a">${escapeHtml(heading)}</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${htmlActionLine}</p>
    ${note ? `<div style="margin:0 0 16px;padding:12px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;font-size:14px;color:#334155">${escapeHtml(note)}</div>` : ''}
    ${expiryTime ? `<p style="margin:0 0 20px;font-size:13px;color:#475569">${escapeHtml(expiryLabel)}: <strong>${escapeHtml(expiryTime)} (gio Viet Nam)</strong></p>` : ''}
    <p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">${ctaLabel}</a></p>
    <p style="margin:0;font-size:12px;color:#64748b">${securityFooter}</p>
  </div>
</body></html>`;

  return { text: textLines.join('\n'), html };
}

export function renderSignOtpMail(
  raw: unknown,
  context: { brand?: string; code: string; signerName?: string },
): RenderedSignMail {
  const mail = zSignOtpMailPayload.parse(raw);
  if (!SIGN_OTP_CODE_PATTERN.test(context.code)) {
    throw new Error('sign otp mail: invalid 6-digit OTP code');
  }
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const title = oneLine(mail.docTitle, 300);
  const signerName = context.signerName ? oneLine(context.signerName, 200) : null;
  const greeting = signerName ? `Xin chao ${signerName},` : 'Xin chao,';

  const text = [
    `Ma xac thuc OTP ky tai lieu - ${orgName}`,
    '',
    greeting,
    `Ma OTP cua ban de mo va ky tai lieu "${title}" la: ${context.code}`,
    '',
    'Ma co hieu luc trong 10 phut va se bi khoa sau 5 lan nhap sai.',
    'Khong chia se ma nay voi bat ky ai.',
    '',
    brand,
  ].join('\n');

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 14px;font-size:19px;color:#0f172a">Ma xac thuc ky tai lieu</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6">Su dung ma sau de xac thuc email khi xem va ky tai lieu <strong>${escapeHtml(title)}</strong> tu <strong>${escapeHtml(orgName)}</strong>:</p>
    <div style="margin:0 0 20px;padding:16px;background:#f1f5f9;border-radius:8px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:.28em;color:#0f172a">${escapeHtml(context.code)}</div>
    <p style="margin:0;font-size:13px;color:#475569">Ma co hieu luc trong 10 phut (toi da 5 lan nhap sai). Khong chia se ma nay voi nguoi khac.</p>
  </div>
</body></html>`;

  return { text, html };
}

export function renderSignDirectOtpMail(
  raw: unknown,
  context: { brand?: string; code: string },
): RenderedSignMail {
  const mail = zSignDirectOtpMailPayload.parse(raw);
  if (!SIGN_OTP_CODE_PATTERN.test(context.code)) {
    throw new Error('sign direct otp mail: invalid 6-digit OTP code');
  }
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const title = oneLine(mail.docTitle, 300);

  const text = [
    `Ma xac thuc OTP ky tai lieu - ${orgName}`,
    '',
    'Xin chao,',
    `Ma OTP cua ban de mo va ky tai lieu "${title}" la: ${context.code}`,
    '',
    'Ma co hieu luc trong 10 phut va se bi khoa sau 5 lan nhap sai.',
    'Khong chia se ma nay voi bat ky ai.',
    '',
    brand,
  ].join('\n');

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 14px;font-size:19px;color:#0f172a">Ma xac thuc ky tai lieu</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Xin chao,</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6">Su dung ma sau de xac thuc email khi xem va ky tai lieu <strong>${escapeHtml(title)}</strong> tu <strong>${escapeHtml(orgName)}</strong>:</p>
    <div style="margin:0 0 20px;padding:16px;background:#f1f5f9;border-radius:8px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:.28em;color:#0f172a">${escapeHtml(context.code)}</div>
    <p style="margin:0;font-size:13px;color:#475569">Ma co hieu luc trong 10 phut (toi da 5 lan nhap sai). Khong chia se ma nay voi nguoi khac.</p>
  </div>
</body></html>`;

  return { text, html };
}

export function renderSignCompletedMail(
  raw: unknown,
  context: { publicUrl: string; brand?: string; pdfAttached?: boolean; certAttached?: boolean },
): RenderedSignMail {
  const mail = zSignCompletedMailPayload.parse(raw);
  const brand = oneLine(context.brand ?? 'Ludy', 80);
  const orgName = oneLine(mail.orgName, 200);
  const title = oneLine(mail.docTitle, 300);
  const formattedCompleted = formatViTime(mail.completedAtIso);
  const completedLabel = formattedCompleted ? `${formattedCompleted} (gio Viet Nam)` : mail.completedAtIso;
  const verifyUrl = `${cleanBaseUrl(context.publicUrl)}${SIGN_PAGE_PATH}`;
  const attachmentText =
    context.pdfAttached === true
      ? context.certAttached === false
        ? 'Ban PDF da niem phong duoc dinh kem trong email nay. Tep chung thu kiem toan dang JSON khong the dinh kem; vui long doi chieu ma chung thu va ma SHA-256 ben duoi.'
        : 'Ban PDF da niem phong va chung thu kiem toan dang JSON duoc dinh kem trong email nay.'
      : context.pdfAttached === false
        ? context.certAttached === true
          ? 'Ban PDF da niem phong khong the dinh kem trong email nay, chi dinh kem tep chung thu kiem toan dang JSON. Vui long lien he nguoi gui hoac to chuc gui tai lieu de nhan ban PDF va doi chieu ma SHA-256 ben duoi.'
          : 'Ban PDF da niem phong khong the dinh kem trong email nay. Vui long lien he nguoi gui hoac to chuc gui tai lieu de nhan ban PDF va doi chieu ma SHA-256 ben duoi.'
        : null;
  const attachmentHtml = attachmentText
    ? `\n    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155">${escapeHtml(attachmentText)}</p>`
    : '';

  const text = [
    `Hoan tat ky tai lieu "${title}"`,
    '',
    `Tai lieu "${title}" cua ${orgName} da duoc tat ca ${mail.signerCount} ben ky hoan tat vao ${completedLabel}.`,
    ...(attachmentText ? [attachmentText] : []),
    `Ma chung thu xac thuc: ${mail.certificateCode}`,
    `Ma SHA-256 ban da niem phong: ${mail.sealedSha256}`,
    '',
    `Trang kiem tra tinh toan ven tai lieu: ${verifyUrl}`,
    '',
    brand,
  ].join('\n');

  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase">${escapeHtml(brand)}</p>
    <h1 style="margin:0 0 14px;font-size:20px;color:#0f172a">Tai lieu da duoc ky hoan tat</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Tai lieu <strong>${escapeHtml(title)}</strong> tu <strong>${escapeHtml(orgName)}</strong> da duoc ${mail.signerCount} ben hoan tat ky va niem phong (${escapeHtml(completedLabel)}).</p>${attachmentHtml}
    <div style="margin:0 0 18px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;line-height:1.6;color:#334155">
      <div><strong>Ma chung thu:</strong> ${escapeHtml(mail.certificateCode)}</div>
      <div style="word-break:break-all"><strong>SHA-256 PDF:</strong> <code>${escapeHtml(mail.sealedSha256)}</code></div>
    </div>
    <p style="margin:0;font-size:12px;color:#64748b">Ban co the doi chieu ma chung thu va ham bam SHA-256 tai trang xac thuc cua ${escapeHtml(brand)}.</p>
  </div>
</body></html>`;

  return { text, html };
}

export async function queueSignInviteEmail(
  ctx: CommandContext,
  input: {
    source: string;
    templateKey: typeof SIGN_INVITE_MAIL_TEMPLATE | typeof SIGN_REMIND_MAIL_TEMPLATE;
    orgName: string;
    envelopeId: string;
    signerId: string;
    signerRole?: 'signer' | 'approver';
    to: string;
    docTitle: string;
    roleLabel: string;
    expiresAt: string | null;
  },
): Promise<{ id: string; status: 'sending' | 'queued' | 'suppressed' }> {
  const payload = zSignInviteMailPayload.parse({
    lang: 'vi',
    orgName: oneLine(input.orgName, 200) || 'Ludy',
    envelopeId: input.envelopeId,
    signerId: input.signerId,
    ...(input.signerRole ? { signerRole: input.signerRole } : {}),
    docTitle: oneLine(input.docTitle, 300) || 'Tai lieu',
    roleLabel: oneLine(input.roleLabel, 120) || (input.signerRole === 'approver' ? 'Nguoi duyet' : 'Nguoi ky'),
    expiresAt: input.expiresAt,
  });
  const prefix =
    input.signerRole === 'approver'
      ? input.templateKey === SIGN_REMIND_MAIL_TEMPLATE
        ? 'Nhac duyet'
        : 'Moi duyet'
      : input.templateKey === SIGN_REMIND_MAIL_TEMPLATE
        ? 'Nhac ky'
        : 'Moi ky';
  const mail = await createMailMessage(ctx, {
    stream: 'transactional',
    source: input.source,
    sourceId: input.signerId,
    templateKey: input.templateKey,
    to: input.to,
    subject: `${prefix}: ${payload.docTitle}`.slice(0, 300),
    payload,
    status: 'queued',
  });
  return { id: mail.id, status: mail.status };
}

export async function queueSignCompletedEmail(
  ctx: CommandContext,
  input: {
    orgName: string;
    envelopeId: string;
    to: string;
    docTitle: string;
    certificateCode: string;
    sealedSha256: string;
    completedAtIso: string;
    signerCount: number;
  },
): Promise<{ id: string; status: 'sending' | 'queued' | 'suppressed' }> {
  const payload = zSignCompletedMailPayload.parse({
    lang: 'vi',
    orgName: oneLine(input.orgName, 200) || 'Ludy',
    envelopeId: input.envelopeId,
    docTitle: oneLine(input.docTitle, 300) || 'Tai lieu',
    certificateCode: input.certificateCode,
    sealedSha256: input.sealedSha256,
    completedAtIso: input.completedAtIso,
    signerCount: input.signerCount,
  });
  const mail = await createMailMessage(ctx, {
    stream: 'transactional',
    source: SIGN_COMPLETED_MAIL_SOURCE,
    sourceId: input.envelopeId,
    templateKey: SIGN_COMPLETED_MAIL_TEMPLATE,
    to: input.to,
    subject: `Hoan tat ky: ${payload.docTitle}`.slice(0, 300),
    payload,
    status: 'queued',
  });
  return { id: mail.id, status: mail.status };
}
