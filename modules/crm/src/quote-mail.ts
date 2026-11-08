// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a sent quote (#2694, template crm.quote): crm.quote.send stored the facts as the mail's merge data and the worker renders them here, with the link to the
// quote's page. The merge data names the quote and holds no token: the template asks crm.quote.mail_data for a new link when it sends the mail (the booking mails'
// pattern), so the queue and its retention never hold a secret; the link opens only the one quote and expires with it.
// The words are Vietnamese (the quote itself is; a second language is a translation of these strings, not a rebuild).
import { z } from 'zod';
import { QUOTE_PAGE_PATH, QUOTE_TOKEN_PATTERN } from '@crove/kernel-contract';

export const QUOTE_MAIL_TEMPLATE = 'crm.quote';
export const QUOTE_MAIL_SOURCE = 'crm.quote.send';

// The merge data of the mail, as stored on its row (mail_message.payload).
export const zQuoteMail = z.strictObject({
  lang: z.literal('vi'),
  org: z.string().min(1).max(200),
  number: z.string().min(1).max(30),
  revision: z.number().int().min(1),
  total: z.string().regex(/^\d{1,18}(\.\d{1,4})?$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quoteId: z.uuid(),
});

export interface RenderedQuoteMail {
  text: string;
  html: string;
  replyTo?: string;
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

// One line, no control or format characters, bounded: the org's name comes from a person.
function oneLine(value: string, max = 200): string {
  const flat = value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// 1980000 -> "1.980.000 đồng"; the quote is in VND only.
function dong(value: string): string {
  const whole = value.split('.')[0] ?? '0';
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đồng`;
}

function dateVi(value: string): string {
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

// The mail from its stored merge data. publicUrl: where the app is served (no trailing slash needed). replyTo: the org's conversation address when the deployment receives
// mail and the org has one (never the document intake address). brand: the product name users see (BRAND_NAME). token: the link's token, made when the mail is sent.
export function renderQuoteMail(raw: unknown, context: { publicUrl: string; replyTo: string | null; brand?: string; token: string }): RenderedQuoteMail {
  const mail = zQuoteMail.parse(raw);
  if (!QUOTE_TOKEN_PATTERN.test(context.token)) throw new Error('quote mail: the link token is malformed');
  const brand = context.brand ?? 'Ludy';
  const org = oneLine(mail.org);
  let base = context.publicUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = `${base}${QUOTE_PAGE_PATH}#${context.token}`;
  const label = mail.revision > 1 ? `${mail.number}-R${mail.revision}` : mail.number;
  const lead = `${org} gửi Quý khách báo giá số ${label}, tổng cộng ${dong(mail.total)}, có hiệu lực đến ngày ${dateVi(mail.validUntil)}.`;
  const text = [
    'Kính gửi Quý khách,',
    '',
    lead,
    '',
    'Xem báo giá đầy đủ (có thể in hoặc lưu thành PDF):',
    url,
    '',
    'Trân trọng,',
    org,
    '',
    `Thư này được gửi qua ${brand}. Quý khách có thể trả lời thư này.`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>Kính gửi Quý khách,</p>
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Xem báo giá ${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#57606a">Nếu nút không mở được, hãy dán địa chỉ này vào trình duyệt:<br>${escapeHtml(url)}</p>
<p>Trân trọng,<br>${escapeHtml(org)}</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(`Thư này được gửi qua ${brand}. Quý khách có thể trả lời thư này.`)}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}
