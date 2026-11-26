// SPDX-License-Identifier: AGPL-3.0-only
// The reminder mail of a customer's overdue invoices (#2488, template finance.payment_reminder), rendered by the worker from the merge
// data finance.payment_reminder.send stored on the mail's row. The words around the table (greeting, lead, closing) are the person's
// approved text; the table, the total and the bank account are built here from the stored facts, which the command read from the books
// at the moment of the send. The Reply-To is the org's inbound address when the deployment receives mail, so the customer's answer
// reaches the Inbox.
import { z } from 'zod';
import { PAYMENT_REMINDER_TEXT_MAX, zId } from '@ludy/kernel-contract';
import { formatAmount, formatDate, escapeHtml, oneLine, type RenderedMail } from './missing-invoices.ts';

export const PAYMENT_REMINDER_TEMPLATE = 'finance.payment_reminder';
// The mail's `source` is this plus the notice level and `.e<entityHex>`: both the level and the legal entity sit on the
// immutable `source` column so reminder history and 3-day repeat checks remain scoped per entity even after 30-day payload retention purge.
export const PAYMENT_REMINDER_SOURCE = 'finance.payment_reminder.notice';
// Invoices listed in one mail; the mail says how many more there are. The total always covers all of them.
export const PAYMENT_REMINDER_INVOICES_MAX = 60;

export function paymentReminderSource(level: 1 | 2 | 3, legalEntityId: string): string {
  return `${PAYMENT_REMINDER_SOURCE}${level}.e${legalEntityId.replace(/-/g, '').toLowerCase()}`;
}

export function paymentReminderSourceLevel(source: string): 1 | 2 | 3 | null {
  const match = /^finance\.payment_reminder\.notice([123])(?:\.e[0-9a-f]{32})?$/.exec(source);
  if (!match) return null;
  return Number(match[1]) as 1 | 2 | 3;
}

export const zPaymentReminderInvoice = z.object({
  series: z.string().max(50),
  number: z.string().max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysOverdue: z.number().int().min(1).max(36500),
  amountDue: z.string().max(40),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // Foreign currency metadata when the invoice is not in the book currency (#2491).
  invoiceCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  foreignTotal: z.string().max(40).nullable().optional(),
  foreignAmountDue: z.string().max(40).nullable().optional(),
});
const zPaymentReminderForeignTotal = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountDue: z.string().max(40),
});
export const zPaymentReminderPayTo = z.object({ bank: z.string().max(200), number: z.string().max(40), holder: z.string().max(200) });

// The merge data of the mail, as stored on its row (mail_message.payload).
export const zPaymentReminderMail = z.object({
  // The legal entity whose invoices the mail is about: the reminder history is read per entity.
  legalEntityId: zId.optional(),
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
  foreignTotals: z.array(zPaymentReminderForeignTotal).max(100).optional(),
  payTo: zPaymentReminderPayTo.nullable(),
});
export type PaymentReminderMail = z.infer<typeof zPaymentReminderMail>;
export type PaymentReminderInvoice = z.infer<typeof zPaymentReminderInvoice>;

const LABELS = {
  vi: {
    columns: ['Hóa đơn', 'Ngày', 'Hạn thanh toán', 'Quá hạn', 'Còn phải thu'],
    days: (n: number) => `${n} ngày`,
    invoice: (symbol: string, number: string) => `số ${number}, ký hiệu ${symbol}`,
    total: 'Tổng cộng',
    totalBooked: 'Tổng cộng (ghi sổ)',
    booked: (bookAmount: string) => `ghi sổ: ${bookAmount}`,
    bookedOnlyNote: (invCurrency: string) => `ghi sổ; hóa đơn ${invCurrency}`,
    partialOfInvoice: (invTotal: string, bookAmount: string) => `hóa đơn ${invTotal}; ghi sổ: ${bookAmount}`,
    includesForeign: (foreignText: string) => `gồm ${foreignText}`,
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
    totalBooked: 'Total (booked)',
    booked: (bookAmount: string) => `booked: ${bookAmount}`,
    bookedOnlyNote: (invCurrency: string) => `booked; ${invCurrency} invoice`,
    partialOfInvoice: (invTotal: string, bookAmount: string) => `invoice ${invTotal}; booked: ${bookAmount}`,
    includesForeign: (foreignText: string) => `includes ${foreignText}`,
    more: (n: number) => `And ${n} more overdue invoice${n === 1 ? '' : 's'}, already counted in the total above.`,
    payTo: 'Payment details',
    bank: 'Bank',
    number: 'Account number',
    holder: 'Account holder',
    signoff: 'Kind regards,',
    footer: (brand: string) => `This message was sent through ${brand}. You can reply to it.`,
  },
} as const;

// An invoice's series and number come from an e-invoice file: one line each, whatever they hold.
function invoiceName(invoice: PaymentReminderInvoice, lang: 'vi' | 'en'): string {
  const symbol = oneLine(invoice.series, 50) || '-';
  return LABELS[lang].invoice(symbol, oneLine(invoice.number, 50));
}

// The amount as the books hold it. In an English mail the book currency is named by its code, not as "đồng".
function amount(value: string, currency: string, lang: 'vi' | 'en'): string {
  const text = formatAmount(value, currency);
  return lang === 'en' && currency === 'VND' ? text.replace(/ đồng$/, ' VND') : text;
}

function invoiceAmountDisplay(
  invoice: PaymentReminderInvoice,
  bookCurrency: string,
  lang: 'vi' | 'en',
): { primary: string; note: string | null } {
  const t = LABELS[lang];
  const book = bookCurrency.toUpperCase();
  const invCurrency = (invoice.invoiceCurrency ?? invoice.currency).toUpperCase();
  const bookedText = amount(invoice.amountDue, book, lang);
  if (invCurrency === book) return { primary: bookedText, note: null };
  if (invoice.foreignAmountDue) {
    const foreignText = amount(invoice.foreignAmountDue, invCurrency, lang);
    if (invoice.foreignTotal && invoice.foreignTotal !== invoice.foreignAmountDue) {
      return { primary: foreignText, note: t.partialOfInvoice(amount(invoice.foreignTotal, invCurrency, lang), bookedText) };
    }
    return { primary: foreignText, note: t.booked(bookedText) };
  }
  return { primary: bookedText, note: t.bookedOnlyNote(invCurrency) };
}

// The mail from its stored merge data. replyTo: the org's inbound address when the deployment receives mail. brand: the product name users
// see (BRAND_NAME, #1040).
export function renderPaymentReminderMail(raw: unknown, context: { replyTo: string | null; brand?: string }): RenderedMail {
  const mail = zPaymentReminderMail.parse(raw);
  const t = LABELS[mail.lang];
  const brand = context.brand ?? 'Ludy';
  const org = oneLine(mail.org);
  const more = mail.count - mail.invoices.length;
  const book = mail.currency.toUpperCase();
  const amounts = mail.invoices.map((i) => invoiceAmountDisplay(i, book, mail.lang));
  const rows = mail.invoices.map((i, idx) => {
    const disp = amounts[idx]!;
    return [
      invoiceName(i, mail.lang),
      formatDate(i.date),
      formatDate(i.dueDate),
      t.days(i.daysOverdue),
      disp.note ? `${disp.primary} (${disp.note})` : disp.primary,
    ];
  });
  const totalText = amount(mail.total, mail.currency, mail.lang);
  const anyForeign = mail.invoices.some((i) => (i.invoiceCurrency ?? i.currency).toUpperCase() !== book) || (mail.foreignTotals?.length ?? 0) > 0;
  const allShownForeignWithAmount = mail.invoices.every((i) => (i.invoiceCurrency ?? i.currency).toUpperCase() !== book && Boolean(i.foreignAmountDue));
  const foreignSummary = (mail.foreignTotals ?? []).map((ft) => amount(ft.amountDue, ft.currency, mail.lang)).join(' + ');
  const totalLine = !anyForeign
    ? `${t.total}: ${totalText}`
    : mail.lang === 'en' && allShownForeignWithAmount && foreignSummary
      ? `${t.total}: ${foreignSummary} (${t.booked(totalText)})`
      : foreignSummary
        ? `${t.totalBooked}: ${totalText} (${t.includesForeign(foreignSummary)})`
        : `${t.totalBooked}: ${totalText}`;
  const payLines = mail.payTo ? [`${t.bank}: ${oneLine(mail.payTo.bank)}`, `${t.number}: ${oneLine(mail.payTo.number, 40)}`, `${t.holder}: ${oneLine(mail.payTo.holder)}`] : [];

  const text = [
    mail.greeting,
    '',
    mail.lead,
    '',
    ...rows.map((r, i) => `${i + 1}. ${r[0]}, ${t.columns[1]?.toLowerCase()} ${r[1]}, ${t.columns[2]?.toLowerCase()} ${r[2]}, ${t.columns[3]?.toLowerCase()} ${r[3]}: ${r[4]}`),
    ...(more > 0 ? ['', t.more(more)] : []),
    '',
    totalLine,
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
    .map((r, idx) => {
      const disp = amounts[idx]!;
      return `<tr>${r
        .map((c, i) => {
          if (i !== 4) return `<td style="${cell};white-space:nowrap">${escapeHtml(c)}</td>`;
          const htmlAmount = disp.note
            ? `${escapeHtml(disp.primary)}<br><span style="color:#57606a;font-size:12px">(${escapeHtml(disp.note)})</span>`
            : escapeHtml(disp.primary);
          return `<td style="${cell};text-align:right;white-space:nowrap">${htmlAmount}</td>`;
        })
        .join('')}</tr>`;
    })
    .join('');
  const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(mail.greeting)}</p>
<p>${escapeHtml(mail.lead)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${more > 0 ? `<p>${escapeHtml(t.more(more))}</p>` : ''}
<p><strong>${escapeHtml(totalLine)}</strong></p>
${payLines.length > 0 ? `<p>${escapeHtml(t.payTo)}:<br>${payLines.map(escapeHtml).join('<br>')}</p>` : ''}
<p>${escapeHtml(mail.closing)}</p>
<p>${escapeHtml(t.signoff)}<br>${escapeHtml(org)}</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(brand))}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}
