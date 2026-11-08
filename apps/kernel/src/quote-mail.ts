// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a sent quote (#2694, template crm.quote): crm.quote.send stored the facts as the mail's merge data; the worker renders them here. The Reply-To is the org's
// conversation address (#2439) when the deployment receives mail and the org has one, so the customer's answer reaches the Inbox as a conversation. Never the document
// intake address (inbound_token), which is another pipeline (a reply there would be read as a document); with no conversation address the mail has no Reply-To (#2827).
import { QUOTE_MAIL_TEMPLATE, renderQuoteMail, zQuoteMail } from '@crove/mod-crm';
import type { MailTemplate } from './mail-queue.ts';

export { QUOTE_MAIL_TEMPLATE };

export const quoteMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const parsed = zQuoteMail.parse(input.payload);
    // The link is made now, as the mail is sent, and kept nowhere but in the mail. A quote that was replaced meanwhile has none: the mail is not sent (TEMPLATE_DATA).
    const { token } = await input.execute<{ token: string | null }>('crm.quote.mail_data', { quoteId: parsed.quoteId });
    if (!token) return null;
    const body = renderQuoteMail(parsed, { publicUrl: input.publicUrl, replyTo: input.conversationAddress ?? null, brand: input.brand, token });
    return { subject: input.subject, ...body };
  },
};
