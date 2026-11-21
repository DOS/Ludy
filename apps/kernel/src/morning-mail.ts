// SPDX-License-Identifier: AGPL-3.0-only
// The morning mail of the day's meetings (#3955, template meetings.morning): a fixed line with the number of meetings and the link that opens the meetings page, nothing else. No title, name, time or
// word of a brief is in the merge data (meetings.morning.notice stores none), so none can be in the mail, and none is left to erase; the merge data is parsed strictly, so a stored extra key is
// refused rather than rendered.
import { zMorningMail } from '@ludy/kernel-contract';
import type { MailTemplate } from './mail-queue.ts';

const COPY = {
  vi: {
    lead: (count: number) => `Hôm nay bạn có ${count} cuộc họp.`,
    open: 'Xem các cuộc họp hôm nay',
    footer: (brand: string, org: string) => `Thư này do ${brand} gửi theo lựa chọn của bạn ở ${org}. Tắt thông báo này trong phần thông báo của Cài đặt.`,
  },
  en: {
    lead: (count: number) => (count === 1 ? 'You have 1 meeting today.' : `You have ${count} meetings today.`),
    open: "See today's meetings",
    footer: (brand: string, org: string) => `${brand} sent this because you asked for it in ${org}. Turn this notice off in the notification settings.`,
  },
} as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const morningMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not exactly the template's throws; the queue records TEMPLATE_DATA.
    const mail = zMorningMail.parse(input.payload);
    const t = COPY[mail.lang];
    const url = `${input.publicUrl.replace(/\/+$/, '')}${mail.path}`;
    const text = [t.lead(mail.count), '', `${t.open}: ${url}`, '', t.footer(input.brand, mail.org)].join('\n');
    const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(t.lead(mail.count))}</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(t.open)}</a></p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(input.brand, mail.org))}</p>
</body></html>`;
    return { subject: input.subject, text, html };
  },
};
