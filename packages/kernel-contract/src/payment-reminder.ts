// SPDX-License-Identifier: AGPL-3.0-only
// Customer payment reminders (#2488, "nhắc thu nợ"): the overdue list, one customer's draft and the send. The finance module decides
// every rule (which invoices are overdue, for how much, the notice level, the facts of the mail); the screen shows the answer, lets a
// person edit the words around the facts and sends. Amounts are decimal strings in the org's book currency.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The words a person edits stay this short; a reminder is not a letter.
export const PAYMENT_REMINDER_TEXT_MAX = 1000;
export const PAYMENT_REMINDER_SUBJECT_MAX = 200;
// The most customers one list shows, the longest overdue first.
export const PAYMENT_REMINDER_CUSTOMERS_MAX = 200;

export const zNoticeLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const zReminderLang = z.enum(['vi', 'en']);

// The last reminder sent to the customer, and the notice level it was at.
export const zLastReminder = z.object({ at: z.string(), level: zNoticeLevel });

export const zPaymentReminderCustomer = z.object({
  partyId: zId,
  name: z.string(),
  // The customer's email as its party record has it; null means a reminder cannot be sent until one is added.
  email: z.string().nullable(),
  level: zNoticeLevel,
  lang: zReminderLang,
  invoiceCount: z.number().int(),
  // The most days any of the overdue invoices is late.
  daysOverdue: z.number().int(),
  // What the overdue invoices still owe, and the balance on 131 no invoice covers (shown, never worded into a reminder).
  total: z.string(),
  other: z.string(),
  lastReminder: zLastReminder.nullable(),
});
export type PaymentReminderCustomer = z.infer<typeof zPaymentReminderCustomer>;

export const zPaymentReminderList = z.object({
  currency: z.string(),
  customers: z.array(zPaymentReminderCustomer),
  // The list stopped at PAYMENT_REMINDER_CUSTOMERS_MAX.
  more: z.boolean(),
});
export type PaymentReminderList = z.infer<typeof zPaymentReminderList>;

export const zReminderInvoiceView = z.object({
  id: zId,
  series: z.string(),
  number: z.string(),
  date: z.string(),
  dueDate: z.string(),
  daysOverdue: z.number().int(),
  amountDue: z.string(),
});
// A bank account of the org with a number recorded (#2183) the reminder can ask to be paid into, with the holder's name.
export const zReminderPayTo = z.object({ id: zId, bank: z.string(), number: z.string(), holder: z.string() });

export const zPaymentReminderWords = z.object({
  subject: z.string(),
  greeting: z.string(),
  lead: z.string(),
  closing: z.string(),
});
export type PaymentReminderWords = z.infer<typeof zPaymentReminderWords>;

export const zPaymentReminderDraft = z.object({
  partyId: zId,
  name: z.string(),
  email: z.string().nullable(),
  currency: z.string(),
  // The legal entity the invoices are in: the sender the mail speaks for.
  org: z.string(),
  level: zNoticeLevel,
  lang: zReminderLang,
  invoices: z.array(zReminderInvoiceView),
  total: z.string(),
  other: z.string(),
  lastReminder: zLastReminder.nullable(),
  // The fixed template words for this level and language; a drafted text replaces them only when it passes the same checks.
  words: zPaymentReminderWords,
  // The org's bank accounts with a recorded number in this entity, the first is the one a reminder asks for unless another is chosen.
  payTo: z.array(zReminderPayTo),
});
export type PaymentReminderDraft = z.infer<typeof zPaymentReminderDraft>;

export const zPaymentReminderSend = z.object({
  partyId: zId,
  legalEntityId: zId.optional(),
  // What the person reviewed: the notice level, the total owed and the invoices. When the books moved since (a payment, a day past a level), the send
  // is refused with STALE_REMINDER and the screen reads the draft again.
  level: zNoticeLevel,
  total: z.string().max(40),
  // The invoices of the draft (their ids); a send for a different set is stale too.
  invoiceIds: z.array(zId).min(1).max(1000),
  subject: z.string().trim().min(1).max(PAYMENT_REMINDER_SUBJECT_MAX),
  greeting: z.string().trim().min(1).max(PAYMENT_REMINDER_TEXT_MAX),
  lead: z.string().trim().min(1).max(PAYMENT_REMINDER_TEXT_MAX),
  closing: z.string().trim().min(1).max(PAYMENT_REMINDER_TEXT_MAX),
  // The bank account number to ask to be paid into; null for none.
  payToId: zId.nullable(),
  // Sent anyway although a reminder of this level went out within the last days.
  confirm: z.boolean().optional(),
});
export type PaymentReminderSend = z.infer<typeof zPaymentReminderSend>;

export const zPaymentReminderSent = z.object({ messageId: zId, status: z.enum(['queued', 'suppressed']), level: zNoticeLevel });
export type PaymentReminderSent = z.infer<typeof zPaymentReminderSent>;

// The hint a person may type to steer the tone of the coworker's wording (one line).
export const PAYMENT_REMINDER_HINT_MAX = 200;
export const zPaymentReminderWordingAsk = z.object({ partyId: zId, legalEntityId: zId.optional(), hint: z.string().trim().max(PAYMENT_REMINDER_HINT_MAX).optional() });
// ai: used (words came back), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent), failed
// (the call failed or its text was refused). Without words the screen keeps the fixed template words.
export const zPaymentReminderWording = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed']),
  words: z.object({ lead: z.string(), closing: z.string() }).nullable(),
});
export type PaymentReminderWording = z.infer<typeof zPaymentReminderWording>;
