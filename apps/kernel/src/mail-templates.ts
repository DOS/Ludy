// The templates queued mail is rendered from (#548), by template_key. A module that queues mail adds its template
// here; a queued mail whose template is missing fails with TEMPLATE_UNKNOWN rather than going out empty.
import type { MailTemplates } from './mail-queue.ts';
import { bookingMailTemplate } from './booking-mail.ts';
import { conversationReplyMailTemplate } from './conversation-reply-mail.ts';
import { digestMailTemplate } from './digest-mail.ts';
import { FOLLOWUP_MAIL_TEMPLATE, followupMailTemplate } from './followup-mail.ts';
import { MISSING_INVOICE_TEMPLATE, missingInvoiceMailTemplate } from './missing-invoice-mail.ts';
import { notificationMailTemplate } from './notification-mail.ts';
import { PAYMENT_REMINDER_TEMPLATE, paymentReminderMailTemplate } from './payment-reminder-mail.ts';
import { ROADMAP_OTP_MAIL_TEMPLATE, ROADMAP_SHIPPED_MAIL_TEMPLATE } from '@ludy/kernel-contract';
import { projectWeeklyStatusMailTemplate } from './project-weekly-status-mail.ts';
import { roadmapOtpMailTemplate } from './roadmap-otp-mail.ts';
import { roadmapShippedMailTemplate } from './roadmap-shipped-mail.ts';
import { proposalReminderMailTemplate } from './proposal-reminder-mail.ts';
import { QUOTE_MAIL_TEMPLATE, quoteMailTemplate } from './quote-mail.ts';
import { reportMailTemplate } from './report-mail.ts';
import { signMailTemplates } from './sign-mail.ts';
import { morningMailTemplate } from './morning-mail.ts';
import { weeklyMailTemplate } from './weekly-mail.ts';
import { summaryReadyMailTemplate } from './summary-ready-mail.ts';
import { todayMailTemplate } from './today-mail.ts';
import { usageDeferredMailTemplate } from './usage-deferred-mail.ts';

export const MAIL_TEMPLATES: MailTemplates = {
  // The scheduled client report (#704).
  'social.report': reportMailTemplate,
  // Social notifications someone must act on (#579).
  'social.notification': notificationMailTemplate,
  // The weekly digest for the team (#1104).
  'social.digest': digestMailTemplate,
  // Proposals waiting for approval past the days the org set (#676).
  'kernel.proposal.reminder': proposalReminderMailTemplate,
  // Finance's request to a client company for its missing purchase invoices, and the monthly reminder (#669).
  [MISSING_INVOICE_TEMPLATE]: missingInvoiceMailTemplate,
  // Finance's reminder to a customer of its overdue invoices, sent by a person's click (#2488).
  [PAYMENT_REMINDER_TEMPLATE]: paymentReminderMailTemplate,
  // An org over a daily abuse limit (#675).
  'kernel.usage.deferred': usageDeferredMailTemplate,
  // The daily "Hôm nay cần bạn" mail of a member who opted in, counts and links only (#2406).
  'kernel.today_mail': todayMailTemplate,
  // A member's reply to an email conversation of the Inbox (#2439).
  'kernel.conversation_reply': conversationReplyMailTemplate,
  // A booking of the public booking page confirmed, moved or cancelled, and its reminders (#1319).
  'crm.booking': bookingMailTemplate,
  // A sent quote's mail with the link to its page (#2694).
  [QUOTE_MAIL_TEMPLATE]: quoteMailTemplate,
  // The follow-up of a meeting, sent by the recorder's click with the published summary (L3, #2590).
  [FOLLOWUP_MAIL_TEMPLATE]: followupMailTemplate,
  // The recorder's "minutes draft ready" mail: a fixed line and the link, no title and no text of the draft (#3730).
  'meetings.summary_ready': summaryReadyMailTemplate,
  // The member's opt-in morning mail of the day's meetings: a fixed line with the count and the link to the meetings page, no title (#3955).
  'meetings.morning': morningMailTemplate,
  // The member's opt-in Monday mail of the week's meetings: a fixed line with four counts and the link to the "this week" card, no title (#4967).
  'meetings.weekly': weeklyMailTemplate,
  // A project's weekly status shared by email to project members (#2609).
  'projects.weekly_status': projectWeeklyStatusMailTemplate,
  // Public roadmap 6-digit email OTP verification (#4399, ADR-0057).
  [ROADMAP_OTP_MAIL_TEMPLATE]: roadmapOtpMailTemplate,
  // Public roadmap opt-in shipped changelog alerts (#4400, ADR-0057).
  [ROADMAP_SHIPPED_MAIL_TEMPLATE]: roadmapShippedMailTemplate,
  // Public eSign invitation, reminder, OTP verification, and completed document notifications (#3324).
  ...signMailTemplates,
};
