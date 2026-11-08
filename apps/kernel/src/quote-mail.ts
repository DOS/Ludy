// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a sent quote (#2694, template crm.quote): crm.quote.send stored the facts as the mail's merge data; the worker renders them here. The Reply-To is the org's
// inbound address when the deployment receives mail, so the customer's answer reaches the Inbox.
import { QUOTE_MAIL_TEMPLATE, renderQuoteMail } from '@crove/mod-crm';
import type { MailTemplate } from './mail-queue.ts';

export { QUOTE_MAIL_TEMPLATE };

export const quoteMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const body = renderQuoteMail(input.payload, { publicUrl: input.publicUrl, replyTo: input.inboundAddress, brand: input.brand });
    return { subject: input.subject, ...body };
  },
};
