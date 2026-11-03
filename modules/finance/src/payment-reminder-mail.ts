// SPDX-License-Identifier: AGPL-3.0-only
// The reminder mail of a customer's overdue invoices (#2488, template finance.payment_reminder), rendered by the worker from the merge
// data finance.payment_reminder.send stored on the mail's row. The words around the table (greeting, lead, closing) are the person's
// approved text; the table, the total and the bank account are built here from the stored facts, which the command read from the books
// at the moment of the send. The Reply-To is the org's inbound address when the deployment receives mail, so the customer's answer
// reaches the Inbox.
import { z } from 'zod';
import { PAYMENT_REMINDER_TEXT_MAX } from '@crove/kernel-contract';
import { formatAmount, formatDate, escapeHtml, oneLine, type RenderedMail } from './missing-invoices.ts';

export const PAYMENT_REMINDER_TEMPLATE = 'finance.payment_reminder';
// The mail's `source` is this plus the notice level: the level a customer was last reminded at is read back from it, and from the
// row's own date, so the reminder history needs no table of its own.
export const PAYMENT_REMINDER_SOURCE = 'finance.payment_reminder.notice';
// Invoices listed in one mail; the mail says how many more there are. The total always covers all of them.
export const PAYMENT_REMINDER_INVOICES_MAX = 60;

export const zPaymentReminderInvoice = z.object({
  series: z.string().max(50),
  number: z.string().max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysOverdue: z.number().int().min(1).max(36500),
  amountDue: z.string().max(40),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const zPaymentReminderPayTo = z.object({ bank: z.string().max(200), number: z.string().max(40), holder: z.string().max(200) });

// The merge data of the mail, as stored on its row (mail_message.payload).
export const zPaymentReminderMail = z.object({
  lang: z.enum(['vi', 'en']),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  org: z.string().max(200),
  greeting: z.string().max(PAYMENT_REMINDER_TEXT_MAX),
  lead: z.string().max(PAYMENT_REMINDER_TEXT_MAX),
  closing: z.string().max(PAYMENT_REMINDER_TEXT_MAX),
  invoices: z.array(zPaymentReminderInvoice).min(1).max(PAYMENT_REMINDER_INVOICES_MAX),
  // How many overdue invoices the customer has in all (more than `invoices` when the list was cut) and what they come to.
  count: z.number().int().min(1),
  total: z.string().max(40),
  currency: z.string().regex(/^[A-Z]{3}$/),
  payTo: zPaymentReminderPayTo.nullable(),
});
export type PaymentReminderMail = z.infer<typeof zPaymentReminderMail>;
export type PaymentReminderInvoice = z.infer<typeof zPaymentReminderInvoice>;
export type PaymentReminderPayTo = z.infer<typeof zPaymentReminderPayTo>;

const LABELS = {
  vi: {
    columns: ['Hóa đơn', 'Ngày', 'Hạn thanh toán', 'Quá hạn', 'Còn phải thu'],
    days: (n: number) => `${n} ngày`,
    invoice: (symbol: string, number: string) => `số ${number}, ký hiệu ${symbol}`,
    total: 'Tổng cộng',
    more: (n: number) => `Và ${n} hóa đơn quá hạn khác, đã nằm trong tổng cộng trên.`,
    payTo: 'Thông tin chuyển khoản',
    bank: 'Ngân hàng',
    number: 'Số tài khoản',
    holder: 'Chủ tài khoản',
    signoff: 'Trân trọng,',
    footer: (brand: string) => `Thư này được gửi qua ${brand}. Quý khách có thể trả lời thư này.`,
  },
  en: {
    columns: ['Invoice', 'Date', 'Due date', 'Overdue', 'Amount due'],
    days: (n: number) => `${n} day${n === 1 ? '' : 's'}`,
    invoice: (symbol: string, number: string) => `no. ${number}, series ${symbol}`,
    total: 'Total',
    more: (n: number) => `And ${n} more overdue invoice${n === 1 ? '' : 's'}, already counted in the total above.`,
    payTo: 'Payment details',
    bank: 'Bank',
    number: 'Account number',
    holder: 'Account holder',
    signoff: 'Kind regards,',
    footer: (brand: string) => `This message was sent through ${brand}. You can reply to it.`,
  },
} as const;

function invoiceName(invoice: PaymentReminderInvoice, lang: 'vi' | 'en'): string {
  const symbol = invoice.series || '-';
  return LABELS[lang].invoice(symbol, invoice.number);
}

// The mail from its stored merge data. replyTo: the org's inbound address when the deployment receives mail. brand: the product name users
// see (BRAND_NAME, #1040).
export function renderPaymentReminderMail(raw: unknown, context: { replyTo: string | null; brand?: string }): RenderedMail {
  const mail = zPaymentReminderMail.parse(raw);
  const t = LABELS[mail.lang];
  const brand = context.brand ?? 'Ludy';
  const org = oneLine(mail.org);
  const more = mail.count - mail.invoices.length;
  const rows = mail.invoices.map((i) => [
    invoiceName(i, mail.lang),
    formatDate(i.date),
    formatDate(i.dueDate),
    t.days(i.daysOverdue),
    formatAmount(i.amountDue, i.currency),
  ]);
  const totalText = formatAmount(mail.total, mail.currency);
  const payLines = mail.payTo ? [`${t.bank}: ${oneLine(mail.payTo.bank)}`, `${t.number}: ${oneLine(mail.payTo.number, 40)}`, `${t.holder}: ${oneLine(mail.payTo.holder)}`] : [];

  const text = [
    mail.greeting,
    '',
    mail.lead,
    '',
    ...rows.map((r, i) => `${i + 1}. ${r[0]}, ${t.columns[1]?.toLowerCase()} ${r[1]}, ${t.columns[2]?.toLowerCase()} ${r[2]}, ${t.columns[3]?.toLowerCase()} ${r[3]}: ${r[4]}`),
    ...(more > 0 ? ['', t.more(more)] : []),
    '',
    `${t.total}: ${totalText}`,
    ...(payLines.length > 0 ? ['', `${t.payTo}:`, ...payLines] : []),
    '',
    mail.closing,
    '',
    t.signoff,
    org,
    '',
    t.footer(brand),
  ].join('\n');

  const cell = 'padding:6px 8px;border-bottom:1px solid #d0d7de';
  const head = t.columns.map((h, i) => `<th style="padding:6px 8px;border-bottom:2px solid #d0d7de;text-align:${i === 4 ? 'right' : 'left'}">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td style="${cell};${i === 4 ? 'text-align:right;' : ''}white-space:nowrap">${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(mail.greeting)}</p>
<p>${escapeHtml(mail.lead)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${more > 0 ? `<p>${escapeHtml(t.more(more))}</p>` : ''}
<p><strong>${escapeHtml(t.total)}: ${escapeHtml(totalText)}</strong></p>
${payLines.length > 0 ? `<p>${escapeHtml(t.payTo)}:<br>${payLines.map(escapeHtml).join('<br>')}</p>` : ''}
<p>${escapeHtml(mail.closing)}</p>
<p>${escapeHtml(t.signoff)}<br>${escapeHtml(org)}</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(brand))}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}
