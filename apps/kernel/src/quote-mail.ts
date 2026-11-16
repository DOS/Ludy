// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a sent quote (#2694, template crm.quote): crm.quote.send stored the facts as the mail's merge data; the worker renders them here. The Reply-To is the org's
// conversation address (#2439) when the deployment receives mail and the org has one, so the customer's answer reaches the Inbox as a conversation. Never the document
// intake address (inbound_token), which is another pipeline (a reply there would be read as a document); with no conversation address the mail has no Reply-To (#2827).
// The mail carries the quote's PDF (#3418, Q3's exit): the bytes are made here as the mail is sent, from the quote exactly as it was sent, and kept nowhere. If they cannot be made
// the mail still goes out with the link only, and the failure is logged as a short code.
import type { MailAttachment } from '@crove/mail';
import { QUOTE_MAIL_TEMPLATE, readLogoImage, renderQuoteMail, renderQuotePdf, zQuoteMail, type QuoteDocumentData } from '@crove/mod-crm';
import { BlobIntegrityError } from '@crove/kernel-runtime';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';
import { opsAlert } from './ops-alert.ts';
import { readLogoFile } from './quote-link.ts';

export { QUOTE_MAIL_TEMPLATE };

// The file name of the attachment: the org's own quote number, reduced to what a file name can safely hold (as the download route does).
export function quotePdfFilename(number: string | null, revision: number): string {
  const named = (number ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `bao-gia-${named || 'bao-gia'}${revision > 1 ? `-R${revision}` : ''}.pdf`;
}

// The PDF of a sent quote for its mail: the document is read in the org's system context (`crm.quote.mail_document`), the letterhead's logo from the
// store (left out when it cannot be read, as the download does), and the bytes by the same pure writer as the download route. 'gone' means the quote is no longer the current sent one (a revision was sent between the link and the document):
// the mail is not sent, as for a replaced quote. Any other failure gives null and the mail goes with the link alone; nothing here throws.
async function quotePdfAttachment(input: MailTemplateInput, quoteId: string): Promise<MailAttachment | null | 'gone'> {
  try {
    const data = await input.execute<QuoteDocumentData | null>('crm.quote.mail_document', { quoteId });
    if (!data) return 'gone';
    const { logoFile, ...document } = data;
    let logo = null;
    if (logoFile && input.store) {
      try {
        const file = await readLogoFile(input.store, logoFile);
        logo = file ? readLogoImage(file.bytes, file.contentType) : null;
      } catch (error) {
        // A logo that cannot be read leaves the letterhead without it and the PDF is still made; a file that does not match its recorded hash is an alert, as in the download route.
        if (error instanceof BlobIntegrityError) opsAlert('[quote-mail] ALERT evidence integrity: a stored file does not match its recorded sha256', error);
      }
    }
    const content = renderQuotePdf({ ...document, logo });
    return { filename: quotePdfFilename(document.quote.number, document.quote.revision), contentType: 'application/pdf', content };
  } catch {
    // A code only: no price, name or line of the quote reaches a log.
    console.warn('[quote-mail] QUOTE_PDF_UNAVAILABLE: the mail goes with the link only');
    return null;
  }
}

export const quoteMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const parsed = zQuoteMail.parse(input.payload);
    // The link is made now, as the mail is sent, and kept nowhere but in the mail. A quote that was replaced meanwhile has none: the mail is not sent (TEMPLATE_DATA).
    const { token } = await input.execute<{ token: string | null }>('crm.quote.mail_data', { quoteId: parsed.quoteId });
    if (!token) return null;
    const pdf = await quotePdfAttachment(input, parsed.quoteId);
    if (pdf === 'gone') return null;
    const body = renderQuoteMail(parsed, { publicUrl: input.publicUrl, replyTo: input.conversationAddress ?? null, brand: input.brand, token, pdfAttached: pdf !== null });
    return { subject: input.subject, ...body, ...(pdf ? { attachments: [pdf] } : {}) };
  },
};
