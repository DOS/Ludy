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

// A customer whose reminders are paused: when its pause ends (the last day with no reminder), the terms it set for itself (null: the org's), and what it owes.
export const zPausedCustomer = z.object({
  partyId: zId,
  name: z.string(),
  pausedUntil: z.string(),
  ownTermsDays: z.number().int().nullable(),
  invoiceCount: z.number().int(),
  total: z.string(),
});

export type PausedCustomer = z.infer<typeof zPausedCustomer>;

export const zPaymentReminderList = z.object({
  currency: z.string(),
  customers: z.array(zPaymentReminderCustomer),
  // The list stopped at PAYMENT_REMINDER_CUSTOMERS_MAX.
  more: z.boolean(),
  // The org's payment terms in days (what the due dates of customers with no terms of their own use).
  termsDays: z.number().int(),
  // Customers with an overdue invoice whose reminders are paused: not in `customers`, no draft, no send.
  paused: z.array(zPausedCustomer),
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
  // The payment terms that dated its invoices, and the terms it set for itself (null: the org's).
  termsDays: z.number().int(),
  // The org's terms, which the customer's own replace.
  orgTermsDays: z.number().int(),
  ownTermsDays: z.number().int().nullable(),
  // A digest of the invoices of this draft: the send must name it, so it is held to the set the person reviewed.
  invoiceKey: z.string().regex(/^[0-9a-f]{64}$/),
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
  // The digest of the invoices of the draft; a send for a different set is stale too.
  invoiceKey: z.string().regex(/^[0-9a-f]{64}$/),
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
// The org's settings for its reminders and a customer's own (#2488, slice 3). Terms are whole days, 1 to 365; a pause is the last day with no reminder.
export const zTermsDays = z.number().int().min(1).max(365);
export const zCollectionSetting = z.object({ termsDays: zTermsDays, weeklyItem: z.boolean() });
export type CollectionSetting = z.infer<typeof zCollectionSetting>;
export const zCustomerCollection = z.object({
  partyId: zId,
  termsDays: zTermsDays.nullable(),
  effectiveTermsDays: zTermsDays,
  pausedUntil: z.string().nullable(),
});
export type CustomerCollection = z.infer<typeof zCustomerCollection>;
// Only what is named changes: leaving a field out keeps it (lifting a pause keeps the customer's own terms).
export const zCustomerCollectionSet = z.object({ partyId: zId, termsDays: zTermsDays.nullable().optional(), pausedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });
