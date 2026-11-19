// SPDX-License-Identifier: AGPL-3.0-only
// Renders the manual weekly status email for a project (#2609) into escaped plain text and HTML.
import { zProjectWeeklyStatusMailPayload, type ProjectWeeklyStatusMailPayload } from '@ludy/kernel-contract';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function formatDay(day: string, language: 'vi' | 'en'): string {
  const [y, m, d] = day.split('-');
  if (!y || !m || !d) return day;
  return language === 'vi' ? `${d}/${m}/${y}` : day;
}

function renderParagraphs(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

interface Copy {
  heading: string;
  thisWeek: string;
  nextWeek: string;
  toWord: string;
  countsHeading: string;
  doneThisWeek: string;
  overdue: string;
  waiting: string;
  dueNextWeek: string;
  summaryHeading: string;
  aiNotice: string;
  openProject: string;
}

const COPY: Record<'vi' | 'en', Copy> = {
  vi: {
    heading: 'Báo cáo tuần dự án',
    thisWeek: 'Tuần này',
    nextWeek: 'Tuần tới',
    toWord: 'đến',
    countsHeading: 'Số liệu công việc',
    doneThisWeek: 'Hoàn thành tuần này',
    overdue: 'Quá hạn',
    waiting: 'Đang chờ',
    dueNextWeek: 'Sắp đến hạn tuần tới',
    summaryHeading: 'Tóm tắt',
    aiNotice: 'Lưu ý: Phần tóm tắt trên được đồng nghiệp AI soạn trước và gửi theo nguyên văn chưa chỉnh sửa.',
    openProject: 'Mở dự án',
  },
  en: {
    heading: 'Project weekly status',
    thisWeek: 'This week',
    nextWeek: 'Next week',
    toWord: 'to',
    countsHeading: 'Task counts',
    doneThisWeek: 'Completed this week',
    overdue: 'Overdue',
    waiting: 'Waiting',
    dueNextWeek: 'Due next week',
    summaryHeading: 'Summary',
    aiNotice: 'Note: The summary above was drafted by the AI coworker and sent without edits.',
    openProject: 'Open project',
  },
};

export function renderProjectWeeklyStatusMail(input: MailTemplateInput): { subject: string; text: string; html: string } {
  const subject = typeof input.subject === 'string' ? input.subject.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (!subject || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(subject)) {
    throw new Error('TEMPLATE_DATA: missing or invalid project weekly status subject');
  }
  const data: ProjectWeeklyStatusMailPayload = zProjectWeeklyStatusMailPayload.parse(input.payload);
  const t = COPY[data.language];
  const root = input.publicUrl.replace(/\/$/, '');
  const projectUrl = `${root}${data.projectPath}`;
  const thisWeekRange = `${formatDay(data.from, data.language)} ${t.toWord} ${formatDay(data.to, data.language)}`;
  const nextWeekRange = `${formatDay(data.nextFrom, data.language)} ${t.toWord} ${formatDay(data.nextTo, data.language)}`;

  const countLines = [
    `${t.doneThisWeek}: ${data.counts.doneThisWeek}`,
    `${t.overdue}: ${data.counts.overdue}`,
    `${t.waiting}: ${data.counts.waiting}`,
    `${t.dueNextWeek}: ${data.counts.dueNextWeek}`,
  ];

  const textParts = [
    `${t.heading}: ${data.projectName}`,
    `${t.thisWeek}: ${thisWeekRange}`,
    `${t.nextWeek}: ${nextWeekRange}`,
    '',
    `${t.countsHeading}:`,
    ...countLines.map((line) => `- ${line}`),
    '',
    `${t.summaryHeading}:`,
    data.summary.trim(),
  ];
  if (data.aiGenerated) {
    textParts.push('', t.aiNotice);
  }
  textParts.push('', `${t.openProject}: ${projectUrl}`, '', `${data.orgName} - ${input.brand}`);

  const html = `<!doctype html>
<html>
<body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111827;margin:0;padding:16px">
<div style="max-width:600px">
<p style="font-size:12px;color:#57606a;margin:0 0 4px">${escapeHtml(t.heading)}</p>
<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(data.projectName)}</h1>
<p style="font-size:13px;color:#57606a;margin:0 0 16px">${escapeHtml(t.thisWeek)}: ${escapeHtml(thisWeekRange)}<br>${escapeHtml(t.nextWeek)}: ${escapeHtml(nextWeekRange)}</p>
<h2 style="font-size:15px;margin:16px 0 6px">${escapeHtml(t.countsHeading)}</h2>
<ul style="margin:0 0 16px;padding-left:20px">
${countLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('\n')}
</ul>
<h2 style="font-size:15px;margin:16px 0 6px">${escapeHtml(t.summaryHeading)}</h2>
${renderParagraphs(data.summary)}
${data.aiGenerated ? `<p style="font-size:12px;color:#57606a;margin:12px 0">${escapeHtml(t.aiNotice)}</p>` : ''}
<p style="margin:20px 0"><a href="${escapeHtml(projectUrl)}" style="color:#b91c1c">${escapeHtml(t.openProject)}</a></p>
<p style="font-size:12px;color:#71717a;margin:20px 0 0">${escapeHtml(data.orgName)} - ${escapeHtml(input.brand)}</p>
</div>
</body>
</html>`;

  return {
    subject,
    text: textParts.join('\n'),
    html,
  };
}

export const projectWeeklyStatusMailTemplate: MailTemplate = {
  async render(input) {
    return renderProjectWeeklyStatusMail(input);
  },
};
