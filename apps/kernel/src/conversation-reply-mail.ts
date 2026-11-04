// SPDX-License-Identifier: AGPL-3.0-only
// The mail a member's reply to an email conversation becomes (#2439, template kernel.conversation_reply): the member's text as written,
// sent under the org's own name with the headers that thread it (In-Reply-To names the customer's last mail, References the chain), and
// Reply-To set to the org's own conversation address (never the document address) when this deployment receives mail, so the customer's answer lands in the same thread.
// The text is the member's own, never the customer's: nothing from the thread is quoted into it here.
import { z } from 'zod';
import { EMAIL_REFS_MAX } from '@crove/kernel-contract';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
// A Message-ID as a mail header carries it: "<local@domain>", no space and no second bracket.
const zMessageId = z.string().regex(/^<[^<>\s]{1,300}>$/);

const zConversationReplyMail = z.object({
  org: z.string().max(400),
  text: z.string().min(1).max(20_000),
  inReplyTo: zMessageId.nullable(),
  references: z.array(zMessageId).max(EMAIL_REFS_MAX),
});

async function renderConversationReply(input: MailTemplateInput): Promise<{
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: readonly string[];
  fromName: string;
} | null> {
  const parsed = zConversationReplyMail.safeParse(input.payload);
  if (!parsed.success || input.subject === null) return null;
  const d = parsed.data;
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5"><div style="white-space:pre-wrap">${escapeHtml(d.text)}</div></body></html>`;
  return {
    subject: input.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 300),
    text: d.text,
    html,
    ...(input.conversationAddress ? { replyTo: input.conversationAddress } : {}),
    ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
    ...(d.references.length > 0 ? { references: d.references } : {}),
    fromName: d.org,
  };
}

export const conversationReplyMailTemplate: MailTemplate = { render: renderConversationReply };
