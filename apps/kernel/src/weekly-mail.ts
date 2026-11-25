// SPDX-License-Identifier: AGPL-3.0-only
// The weekly mail of the week's meetings (#4967, template meetings.weekly): a fixed few lines with the four numbers of the "this week" card and the link that opens it, nothing else. No title, name or word of a
// decision is in the merge data (meetings.weekly.notice stores none), so none can be in the mail, and none is left to erase; the merge data is parsed strictly, so a stored extra key is refused rather than
// rendered. A number that a limit cut is written "at least". A fifth line (#5019) says how often the org's tracked words came up, only when some did: a number, never a word.
import { WEEKLY_TRACKED_MAX, zWeeklyMail, type WeeklyMail } from '@ludy/kernel-contract';
import type { MailTemplate } from './mail-queue.ts';

const COPY = {
  vi: {
    lead: 'Tổng kết các cuộc họp trong 7 ngày qua của bạn:',
    meetings: (n: number, cut: boolean) => `${cut ? 'Ít nhất ' : ''}${n} cuộc họp có kết quả đã công bố`,
    decisions: (n: number, cut: boolean) => `${cut ? 'Ít nhất ' : ''}${n} quyết định đã công bố`,
    open: (n: number, od: number, cut: boolean) => `${cut ? 'Ít nhất ' : ''}${n} việc còn mở${od > 0 ? `, ${od} việc đã quá hạn` : ''}`,
    tracked: (n: number) => `Từ khóa theo dõi của tổ chức xuất hiện ${n}${n >= WEEKLY_TRACKED_MAX ? '+' : ''} lần`,
    open_link: 'Xem tuần này',
    footer: (brand: string, org: string) => `Thư này do ${brand} gửi theo lựa chọn của bạn ở ${org}. Tắt thông báo này trong phần thông báo của Cài đặt.`,
  },
  en: {
    lead: 'The last 7 days of your meetings:',
    meetings: (n: number, cut: boolean) => `${cut ? 'At least ' : ''}${n} ${n === 1 ? 'meeting' : 'meetings'} with a published result`,
    decisions: (n: number, cut: boolean) => `${cut ? 'At least ' : ''}${n} ${n === 1 ? 'decision' : 'decisions'} published`,
    open: (n: number, od: number, cut: boolean) => `${cut ? 'At least ' : ''}${n} open action ${n === 1 ? 'item' : 'items'}${od > 0 ? `, ${od} overdue` : ''}`,
    tracked: (n: number) => `The organization's tracked words came up ${n}${n >= WEEKLY_TRACKED_MAX ? '+' : ''} ${n === 1 ? 'time' : 'times'}`,
    open_link: 'See this week',
    footer: (brand: string, org: string) => `${brand} sent this because you asked for it in ${org}. Turn this notice off in the notification settings.`,
  },
} as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

// The lines of the body, in order (pure: the tests compare them to the numbers the card shows).
export function weeklyLines(mail: WeeklyMail): string[] {
  const t = COPY[mail.lang];
  const lines = [t.meetings(mail.meetings, mail.cut), t.decisions(mail.decisions, mail.cut), t.open(mail.open, mail.overdue, mail.cut)];
  // The tracked-word line only when the org keeps tracked words and some came up (#5019): a number, never a word.
  return mail.tracked === undefined ? lines : [...lines, t.tracked(mail.tracked)];
}

export const weeklyMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not exactly the template's throws; the queue records TEMPLATE_DATA.
    const mail = zWeeklyMail.parse(input.payload);
    const t = COPY[mail.lang];
    const url = `${input.publicUrl.replace(/\/+$/, '')}${mail.path}`;
    const lines = weeklyLines(mail);
    const text = [t.lead, ...lines.map((l) => `- ${l}`), '', `${t.open_link}: ${url}`, '', t.footer(input.brand, mail.org)].join('\n');
    const html = `<!doctype html>
<html lang="${mail.lang}"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>${escapeHtml(t.lead)}</p>
<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p><a href="${escapeHtml(url)}">${escapeHtml(t.open_link)}</a></p>
<p style="font-size:13px;color:#57606a">${escapeHtml(t.footer(input.brand, mail.org))}</p>
</body></html>`;
    return { subject: input.subject, text, html };
  },
};
