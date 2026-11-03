// SPDX-License-Identifier: AGPL-3.0-only
// The rules of customer payment reminders (#2488), as pure functions: which sales invoices are overdue and for how much, the
// notice level a customer is at, and the fixed words of a reminder. Nothing here reads the database or calls a model.
//
// The books keep no due date on a sale and no link between an invoice and the receipt that paid it; a receipt posts to 131 for the
// customer. So both are derived, the same way every time:
// - the due date is the invoice date plus the payment terms (30 days until the org can set its own);
// - what is still owed is the customer's balance on 131 (reversals counted, as the customers list does), laid over the customer's
//   invoices newest first: the oldest invoices are taken as paid first. Whatever balance no invoice covers (an opening balance, a
//   manual journal) is `other`: shown to the person, never worded into a reminder.
import { Decimal } from '@crove/l10n-vn';

export const PAYMENT_TERMS_DAYS = 30;
// A customer's notice level by the days its oldest overdue invoice is late: first from the first day, second from the 15th, final from the 30th.
export const NOTICE_LEVEL_FROM_DAYS = { 1: 1, 2: 15, 3: 30 } as const;
export type NoticeLevel = 1 | 2 | 3;
export type ReminderLang = 'vi' | 'en';
// Two reminders of one notice level within this many days ask for a confirmation before the second goes out.
export const REMINDER_REPEAT_DAYS = 3;

export interface SaleInvoice {
  id: string;
  series: string;
  number: string;
  // YYYY-MM-DD
  date: string;
  // The invoice total in the book currency, a decimal string.
  total: string;
  currency: string;
}

export interface OpenInvoice extends SaleInvoice {
  // What is still owed on this invoice, a decimal string, at most its total.
  amountDue: string;
  dueDate: string;
  // Whole days past the due date as of today (0 or less: not yet due).
  daysOverdue: number;
}

export interface Receivable {
  // Invoices with an amount left, oldest first, overdue or not.
  open: OpenInvoice[];
  // The balance on 131 that no invoice covers (positive), a decimal string.
  other: string;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDay(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(date: string, days: number): string {
  return new Date(utcDay(date) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from `from` to `to`; negative when `to` is earlier.
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

// The newest invoice first: later date, then the larger number (a numeric series compares as a number), then the id, so the order never
// depends on how the rows came out of the database.
function newestFirst(a: SaleInvoice, b: SaleInvoice): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const byNumber = b.number.localeCompare(a.number, 'en', { numeric: true });
  if (byNumber !== 0) return byNumber;
  const bySeries = b.series.localeCompare(a.series, 'en', { numeric: true });
  return bySeries !== 0 ? bySeries : b.id.localeCompare(a.id);
}

// Lays the customer's 131 balance over its invoices, newest first, and dates each against today. A balance at or below zero (a credit,
// or nothing owed) leaves no invoice open.
export function allocateReceivable(invoices: readonly SaleInvoice[], balance: string, today: string, termsDays: number = PAYMENT_TERMS_DAYS): Receivable {
  let left = Decimal.max(new Decimal(balance), 0);
  const open: OpenInvoice[] = [];
  for (const invoice of [...invoices].sort(newestFirst)) {
    if (left.lessThanOrEqualTo(0)) break;
    const total = new Decimal(invoice.total);
    if (total.lessThanOrEqualTo(0)) continue;
    const due = Decimal.min(total, left);
    left = left.minus(due);
    const dueDate = addDays(invoice.date, termsDays);
    open.push({ ...invoice, amountDue: due.toFixed(), dueDate, daysOverdue: daysBetween(dueDate, today) });
  }
  return { open: open.reverse(), other: left.toFixed() };
}

export function overdueOf(receivable: Receivable): OpenInvoice[] {
  return receivable.open.filter((i) => i.daysOverdue >= 1);
}

export function totalOf(invoices: readonly { amountDue: string }[]): string {
  return invoices.reduce((sum, i) => sum.plus(i.amountDue), new Decimal(0)).toFixed();
}

// The notice level of a customer: by the oldest of its overdue invoices. Null when none is overdue.
export function noticeLevel(overdue: readonly { daysOverdue: number }[]): NoticeLevel | null {
  if (overdue.length === 0) return null;
  const oldest = Math.max(...overdue.map((i) => i.daysOverdue));
  if (oldest >= NOTICE_LEVEL_FROM_DAYS[3]) return 3;
  return oldest >= NOTICE_LEVEL_FROM_DAYS[2] ? 2 : 1;
}

// The language of a reminder: English for a customer whose invoices are in a foreign currency, Vietnamese otherwise.
export function reminderLang(invoices: readonly { currency: string }[]): ReminderLang {
  return invoices.length > 0 && invoices.every((i) => i.currency !== 'VND') ? 'en' : 'vi';
}

// The words around the facts. Fixed text with no digit in it: the amounts, dates and numbers of a reminder come from the facts block
// the code builds, and the same rule (no digit, no link) is what a drafted text must meet to replace this one.
export interface ReminderWords {
  subject: string;
  greeting: string;
  lead: string;
  closing: string;
}

export function templateWords(input: { level: NoticeLevel; lang: ReminderLang; customer: string; org: string }): ReminderWords {
  const { level, lang, customer, org } = input;
  if (lang === 'en') {
    const lead = {
      1: `Thank you for your business. Our records show that the invoices below have reached their due date. If you have already paid them, please disregard this message.`,
      2: `This is our second reminder. Our records still show the invoices below as unpaid past their due date. If you have already paid them, please reply with the date of payment.`,
      3: `This is our final notice before we need to look at next steps together. The invoices below are well past their due date. Please arrange payment as soon as you can, or get in touch so we can agree on a plan.`,
    }[level];
    return {
      subject: { 1: `Payment reminder from ${org}`, 2: `Second reminder: overdue invoices from ${org}`, 3: `Final notice: overdue invoices from ${org}` }[level],
      greeting: `Dear ${customer},`,
      lead,
      closing: 'If anything above looks wrong, please reply to this message and we will check it with you. Thank you for your prompt attention.',
    };
  }
  const lead = {
    1: `Cảm ơn Quý khách đã đồng hành cùng ${org}. Theo ghi nhận của chúng tôi, các hóa đơn dưới đây đã đến hạn thanh toán. Nếu Quý khách đã thanh toán, xin vui lòng bỏ qua thư này.`,
    2: `Đây là thư nhắc lần thứ hai. Theo ghi nhận của chúng tôi, các hóa đơn dưới đây vẫn chưa được thanh toán và đã quá hạn. Nếu Quý khách đã thanh toán, xin vui lòng phản hồi thư này kèm ngày thanh toán.`,
    3: `Đây là thông báo cuối cùng của chúng tôi trước khi hai bên cần bàn phương án tiếp theo. Các hóa đơn dưới đây đã quá hạn thanh toán từ lâu. Kính mong Quý khách sắp xếp thanh toán sớm nhất, hoặc liên hệ để chúng ta thống nhất lịch thanh toán.`,
  }[level];
  return {
    subject: { 1: `Nhắc thanh toán hóa đơn đến hạn, ${org}`, 2: `Nhắc lần hai: hóa đơn quá hạn thanh toán, ${org}`, 3: `Thông báo cuối: hóa đơn quá hạn thanh toán, ${org}` }[level],
    greeting: `Kính gửi Quý khách ${customer},`,
    lead,
    closing: 'Nếu có điểm nào chưa khớp, Quý khách vui lòng phản hồi thư này để chúng tôi cùng kiểm tra. Trân trọng cảm ơn Quý khách.',
  };
}
