// SPDX-License-Identifier: AGPL-3.0-only
// The mail of an issued sales e-invoice non-core error notice (#3697, follow-up of #2504, template finance.einvoice_notice):
// finance.einvoice.notice_send stored the facts as the mail's merge data; the worker renders them here with code-built
// Vietnamese text (`renderEInvoiceNoticeMail`, never a model). Reply-To uses the org's conversation address so buyer
// replies reach the Inbox conversation thread rather than the document intake address.
import { EINVOICE_NOTICE_MAIL_TEMPLATE, renderEInvoiceNoticeMail } from '@ludy/mod-finance';
import type { MailTemplate } from './mail-queue.ts';

export { EINVOICE_NOTICE_MAIL_TEMPLATE };

export const einvoiceNoticeMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const body = renderEInvoiceNoticeMail(input.payload, { replyTo: input.conversationAddress ?? null, brand: input.brand });
    return { subject: input.subject, ...body };
  },
};
