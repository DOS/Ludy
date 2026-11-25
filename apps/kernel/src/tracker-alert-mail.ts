// SPDX-License-Identifier: AGPL-3.0-only
// The "a tracked word is in the transcript of a new meeting" mail (#4873, template meetings.tracker_alert): a fixed line, how many tracked words came up and the link that opens the meeting, nothing else. No
// word (it can be a competitor's name), title or sentence is in the merge data (meetings.tracker.alert_notice stores none), so none can be in the mail, and none is left to erase; the merge data is parsed
// strictly, so a stored extra key is refused rather than rendered.
import { zTrackerAlertMail } from '@ludy/kernel-contract';
import type { MailTemplate } from './mail-queue.ts';

const COPY = {
  vi: {
    lead: (words: number) => `Có ${words} từ khóa bạn theo dõi trong bản ghi vừa được chia sẻ của một cuộc họp.`,
    open: 'Mở cuộc họp',
    footer: (brand: string, org: string) => `Thư này do ${brand} gửi cho thành viên đã bật báo từ khóa theo dõi của ${org}. Tắt thông báo này trong phần thông báo của Cài đặt.`,
  },
  en: {
    lead: (words: number) => `${words === 1 ? '1 word' : `${words} words`} you track came up in the transcript just shared for a meeting.`,
    open: 'Open the meeting',
    footer: (brand: string, org: string) => `${brand} sent this to a member of ${org} who turned on tracked-word alerts. Turn this notice off in the notification settings.`,
  },
} as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const trackerAlertMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not exactly the template's throws; the queue records TEMPLATE_DATA.
    const mail = zTrackerAlertMail.parse(input.payload);
    const t = COPY[mail.lang];
    const url = `${input.publicUrl.replace(/\/+$/, '')}${mail.path}`;
    const lead = t.lead(mail.words);
    const text = [lead, '', `${t.open}: ${url}`, '', t.footer(input.brand, mail.org)].join('\n');
    const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(t.open)}</a></p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(input.brand, mail.org))}</p>
</body></html>`;
    return { subject: input.subject, text, html };
  },
};
