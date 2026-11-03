// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a customer's overdue invoices (#2488, template finance.payment_reminder): finance.payment_reminder.send stored the facts and
// the words a person approved as the mail's merge data; the worker renders them here. The Reply-To is the org's inbound address when the
// deployment receives mail, so the customer's answer reaches the Inbox like any other mail.
import { PAYMENT_REMINDER_TEMPLATE, renderPaymentReminderMail } from '@crove/mod-finance';
import type { MailTemplate } from './mail-queue.ts';

export { PAYMENT_REMINDER_TEMPLATE };

export const paymentReminderMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const body = renderPaymentReminderMail(input.payload, { replyTo: input.inboundAddress, brand: input.brand });
    return { subject: input.subject, ...body };
  },
};
