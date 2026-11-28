// SPDX-License-Identifier: AGPL-3.0-only
// The mail of an issued sales e-invoice non-core error notice (#3697, follow-up of #2504, template finance.einvoice_notice):
// finance.einvoice.notice_send queues the facts as the mail's merge data; the worker renders them here with code-built
// Vietnamese text (`einvoiceNoticeText`, never a model). Reply-To uses the org's conversation address when available.
import { z } from 'zod';
import { EINVOICE_NOTICE_FIELDS, einvoiceNoticeText, zId } from '@ludy/kernel-contract';
import { escapeHtml, oneLine, type RenderedMail } from './missing-invoices.ts';

export const EINVOICE_NOTICE_MAIL_TEMPLATE = 'finance.einvoice_notice';
export const EINVOICE_NOTICE_MAIL_SOURCE = 'finance.einvoice.notice_send';

export const zEInvoiceNoticeMail = z.object({
  legalEntityId: zId.optional(),
  org: z.string().trim().min(1).max(200),
  buyerName: z.string().max(400).nullable(),
  number: z.string().trim().min(1).max(50),
  templateNo: z.string().max(50).nullable(),
  symbol: z.string().max(50).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  field: z.enum(EINVOICE_NOTICE_FIELDS),
  correctText: z.string().trim().min(1).max(500),
});
export type EInvoiceNoticeMail = z.infer<typeof zEInvoiceNoticeMail>;

// Renders the code-built buyer notice email from stored merge data. replyTo: org conversation address when present.
export function renderEInvoiceNoticeMail(raw: unknown, context: { replyTo: string | null; brand?: string }): RenderedMail {
  const mail = zEInvoiceNoticeMail.parse(raw);
  const brand = oneLine(context.brand ?? 'Ludy', 80) || 'Ludy';
  const org = oneLine(mail.org, 200);
  const coreText = einvoiceNoticeText({
    buyerName: mail.buyerName,
    number: mail.number,
    templateNo: mail.templateNo,
    symbol: mail.symbol,
    date: mail.date,
    field: mail.field,
    correctText: mail.correctText,
  });
  const footer = context.replyTo
    ? `Thư này được gửi thay mặt ${org} qua ${brand}. Quý khách có thể trả lời thư này.`
    : `Thư này được gửi thay mặt ${org} qua ${brand}.`;
  const text = [coreText, org, '', footer].join('\n');
  const paragraphs = coreText
    .split('\n\n')
    .map((block) => `<p>${block.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('\n');
  const html = `<!doctype html>
<html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
${paragraphs}
<p>${escapeHtml(org)}</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(footer)}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}
