// SPDX-License-Identifier: AGPL-3.0-only
// The "minutes draft ready" mail to the recorder (#3730, template meetings.summary_ready): a fixed line and the link that opens the meeting, nothing else. No title, sentence, decision or
// item of the draft is in the merge data (meetings.summary.ready_notice stores none), so none can be in the mail, and none is left to erase; the merge data is parsed strictly, so a
// stored extra key is refused rather than rendered.
import { zSummaryReadyMail } from '@ludy/kernel-contract';
import type { MailTemplate } from './mail-queue.ts';

const COPY = {
  vi: {
    lead: 'Bản nháp biên bản do đồng nghiệp AI soạn đã sẵn sàng để bạn xem và chỉnh.',
    open: 'Mở cuộc họp',
    footer: (brand: string, org: string) => `Thư này do ${brand} gửi cho người ghi cuộc họp của ${org}. Tắt thông báo này trong phần thông báo của Cài đặt.`,
  },
  en: {
    lead: 'The minutes draft written by the AI coworker is ready for you to review and edit.',
    open: 'Open the meeting',
    footer: (brand: string, org: string) => `${brand} sent this to the person who recorded a meeting of ${org}. Turn this notice off in the notification settings.`,
  },
} as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const summaryReadyMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not exactly the template's throws; the queue records TEMPLATE_DATA.
    const mail = zSummaryReadyMail.parse(input.payload);
    const t = COPY[mail.lang];
    const url = `${input.publicUrl.replace(/\/+$/, '')}${mail.path}`;
    const text = [t.lead, '', `${t.open}: ${url}`, '', t.footer(input.brand, mail.org)].join('\n');
    const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(t.lead)}</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(t.open)}</a></p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(input.brand, mail.org))}</p>
</body></html>`;
    return { subject: input.subject, text, html };
  },
};
