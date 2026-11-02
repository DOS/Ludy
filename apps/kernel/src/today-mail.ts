// SPDX-License-Identifier: AGPL-3.0-only
// The daily "Hôm nay cần bạn" mail (issue #2406, template kernel.today_mail): what needs the member today, as counts and links
// only, with the plain brief built from the same counts (templateBrief of @crove/agent: no model call, so the AI budget never
// touches the mail). The command that queues it (kernel.today_mail.send) wrote the merge data for one opted-in member; this
// only checks its shape and lays it out. No amount, name, title or message text is in the payload, so none can reach the mail;
// every link is an app path of the org, checked here before the public URL is put in front of it, and nothing secret is in it.
import { z } from 'zod';
import { templateBrief, type BriefFacts } from '@crove/agent';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

const SLUG = '[a-z0-9][a-z0-9-]{0,62}';
const zCount = z.number().int().min(0).max(1_000_000);

export const zTodayMail = z.object({
  org: z.string().max(400),
  language: z.enum(['vi', 'en']),
  // The Vietnam day the mail is for (YYYY-MM-DD).
  day: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  // What the Home list holds for the member, by kind; an item that groups several counts as that many.
  // The kernel's own counts (proposals, work notifications, messages) are what the send command writes; the others stay 0 until a line
  // of another app has a count the worker may read for a member.
  counts: z.object({ flags: zCount.default(0), blocking: zCount.default(0), proposals: zCount, notifications: zCount.default(0), messages: zCount, deadlines: zCount.default(0) }),
  // Home, and the member's notification settings with the one-click turn-off (a plain visit changes nothing).
  home: z.string().regex(new RegExp(`^/o/${SLUG}/overview$`)),
  settings: z.string().regex(new RegExp(`^/o/${SLUG}/notifications\\?todayMail=off$`)),
});

// The texts, with {brand} for the product name and {org} for the org's name.
const TEXT = {
  vi: {
    title: 'Hôm nay cần bạn ở {org}',
    subject: 'Hôm nay có {n} việc cần bạn trên {brand}',
    subjectNone: 'Hôm nay chưa có việc nào cần bạn trên {brand}',
    intro: 'Tóm tắt những việc cần bạn trên {brand} hôm nay. Mở {brand} để xem từng việc và xử lý.',
    flags: 'Cảnh báo: {n}',
    proposals: 'Chờ bạn duyệt: {n}',
    notifications: 'Thông báo công việc chưa đọc: {n}',
    messages: 'Tin nhắn chưa trả lời: {n}',
    deadlines: 'Hạn sắp đến: {n}',
    open: 'Mở {brand}',
    footer: 'Thư này gửi từ {brand} cho {org}, mỗi sáng, vì bạn đã bật nhận tóm tắt hằng ngày. Thư chỉ có số lượng và liên kết, không có số tiền hay nội dung.',
    settings: 'Tắt thư này trong Cài đặt thông báo',
  },
  en: {
    title: 'Needs you today at {org}',
    subject: '{n} items need you today on {brand}',
    subjectNone: 'Nothing needs you today on {brand}',
    intro: 'A summary of what needs you on {brand} today. Open {brand} to see each item and act on it.',
    flags: 'Warnings: {n}',
    proposals: 'Waiting for your approval: {n}',
    notifications: 'Unread work notifications: {n}',
    messages: 'Unanswered messages: {n}',
    deadlines: 'Coming up: {n}',
    open: 'Open {brand}',
    footer: 'This mail is sent by {brand} for {org} every morning because you turned on the daily summary. It holds counts and links only, no amounts or content.',
    settings: 'Turn this mail off in Notification settings',
  },
} as const;

const fill = (text: string, values: Readonly<Record<string, string>>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

export async function renderTodayMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const parsed = zTodayMail.safeParse(input.payload);
  if (!parsed.success) return null;
  const d = parsed.data;
  const strings = TEXT[d.language];
  const format = new Intl.NumberFormat(d.language === 'vi' ? 'vi-VN' : 'en-US');
  const root = input.publicUrl.replace(/\/+$/, '');
  const url = (path: string) => `${root}${path}`;
  const org = oneLine(d.org);
  const t = (key: keyof typeof strings, values: Readonly<Record<string, string>> = {}) => fill(strings[key], { brand: input.brand, org, ...values });
  const c = d.counts;
  const total = c.flags + c.proposals + c.notifications + c.messages + c.deadlines;

  // The brief the Home card falls back to, from the same counts: no amounts and no dates, so only counts.
  const facts: BriefFacts = { language: d.language, today: d.day, dueDates: [], flags: c.flags, blocking: c.blocking, proposals: c.proposals, messages: c.messages, deadlines: c.deadlines, proposalAmounts: [] };
  // The brief has no sentence for work notifications, so with some the list below says the counts and the brief is left out.
  const brief = c.notifications > 0 ? [] : templateBrief(facts);
  const lines = [
    ...(c.flags > 0 ? [t('flags', { n: format.format(c.flags) })] : []),
    ...(c.proposals > 0 ? [t('proposals', { n: format.format(c.proposals) })] : []),
    ...(c.notifications > 0 ? [t('notifications', { n: format.format(c.notifications) })] : []),
    ...(c.messages > 0 ? [t('messages', { n: format.format(c.messages) })] : []),
    ...(c.deadlines > 0 ? [t('deadlines', { n: format.format(c.deadlines) })] : []),
  ];
  const subject = total > 0 ? t('subject', { n: format.format(total) }) : t('subjectNone');

  const text = [t('title'), '', t('intro'), ...(brief.length > 0 ? ['', ...brief] : []), ...(lines.length > 0 ? ['', ...lines.map((l) => `- ${l}`)] : []), '', `${t('open')}: ${url(d.home)}`, '', t('footer'), `${t('settings')}: ${url(d.settings)}`].join('\n');
  const html = `<!doctype html><html lang="${d.language}"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(t('title'))}</h1>
<p style="margin:0 0 16px">${escapeHtml(t('intro'))}</p>
${brief.length > 0 ? `<p style="margin:0 0 12px">${brief.map(escapeHtml).join(' ')}</p>` : ''}
${lines.length > 0 ? `<ul style="margin:0;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
<p style="margin:20px 0"><a href="${escapeHtml(url(d.home))}" style="color:#b91c1c">${escapeHtml(t('open'))}</a></p>
<p style="font-size:12px;color:#71717a">${escapeHtml(t('footer'))} <a href="${escapeHtml(url(d.settings))}" style="color:#71717a">${escapeHtml(t('settings'))}</a></p>
</body></html>`;
  return { subject: [...oneLine(subject)].slice(0, 200).join(''), text, html };
}

export const todayMailTemplate: MailTemplate = { render: renderTodayMail };
