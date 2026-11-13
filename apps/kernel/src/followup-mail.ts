// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up mail of a meeting (L3, #2590, template meetings.followup): meetings.followup.send stored the cleaned words and the facts (the published summary, decisions
// and action items as they were at the send) as the mail's merge data; the worker renders them here. Every text is escaped (a person typed the words and the summary), and
// the mail holds no link and no token. The Reply-To is the org's conversation address (#2439) when the deployment receives mail and the org has one, so an answer reaches the
// Inbox; with none the mail has no Reply-To.
import { FOLLOWUP_MAIL_TEMPLATE, followupClean, zFollowupMail, type FollowupMail } from '@crove/kernel-contract';
import type { MailTemplate } from './mail-queue.ts';

export { FOLLOWUP_MAIL_TEMPLATE };

const LABELS = {
  vi: {
    summary: 'Tóm tắt',
    decisions: 'Các quyết định',
    items: 'Việc cần làm',
    owner: 'Người phụ trách',
    due: 'Hạn',
    signoff: 'Trân trọng,',
    footer: (brand: string) => `Thư này được gửi qua ${brand} bởi người tổ chức cuộc họp. Bạn có thể trả lời thư này.`,
  },
  en: {
    summary: 'Summary',
    decisions: 'Decisions',
    items: 'Action items',
    owner: 'Owner',
    due: 'Due',
    signoff: 'Kind regards,',
    footer: (brand: string) => `This message was sent through ${brand} by the person who recorded the meeting. You can reply to it.`,
  },
} as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
// A paragraph of the summary as HTML: escaped, a line break kept.
const paragraphs = (value: string): string =>
  value
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

const itemLine = (item: FollowupMail['facts']['items'][number], lang: 'vi' | 'en'): string => {
  const t = LABELS[lang];
  const parts = [followupClean(item.title, true)];
  if (item.who) parts.push(`${t.owner}: ${followupClean(item.who, true)}`);
  if (item.when) parts.push(`${t.due}: ${followupClean(item.when, true)}`);
  return parts.join(', ');
};

export function renderFollowupMail(raw: unknown, context: { replyTo: string | null; brand?: string }): { text: string; html: string; replyTo?: string } {
  const mail = zFollowupMail.parse(raw);
  const t = LABELS[mail.lang];
  const brand = context.brand ?? 'Ludy';
  // The facts are the recorder's published text: cleaned here as the items are (no bidi or zero-width characters), then escaped.
  const facts = { summary: followupClean(mail.facts.summary, false), decisions: mail.facts.decisions.map((d) => followupClean(d, true)).filter((d) => d !== ''), items: mail.facts.items };
  const items = facts.items.map((i) => itemLine(i, mail.lang));
  const text = [
    mail.greeting,
    '',
    mail.lead,
    ...(facts.summary ? ['', `${t.summary}:`, facts.summary] : []),
    ...(facts.decisions.length > 0 ? ['', `${t.decisions}:`, ...facts.decisions.map((d) => `- ${d}`)] : []),
    ...(items.length > 0 ? ['', `${t.items}:`, ...items.map((i) => `- ${i}`)] : []),
    '',
    mail.closing,
    '',
    t.signoff,
    mail.org,
    '',
    t.footer(brand),
  ].join('\n');
  const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(mail.greeting)}</p>
${paragraphs(mail.lead)}
${facts.summary ? `<h3 style="font-size:15px;margin:16px 0 4px">${escapeHtml(t.summary)}</h3>\n${paragraphs(facts.summary)}` : ''}
${facts.decisions.length > 0 ? `<h3 style="font-size:15px;margin:16px 0 4px">${escapeHtml(t.decisions)}</h3>\n<ul>${facts.decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
${items.length > 0 ? `<h3 style="font-size:15px;margin:16px 0 4px">${escapeHtml(t.items)}</h3>\n<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
${paragraphs(mail.closing)}
<p>${escapeHtml(t.signoff)}<br>${escapeHtml(mail.org)}</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(brand))}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}

export const followupMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const body = renderFollowupMail(input.payload, { replyTo: input.conversationAddress ?? null, brand: input.brand });
    return { subject: input.subject, ...body };
  },
};
