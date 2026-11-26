// SPDX-License-Identifier: AGPL-3.0-only
// The morning mail and daily briefing of the day's meetings (#3955, #5080, template meetings.morning):
// - v1 count-only payloads (`{ lang, org, count, path }`) hold only the count and meetings link, nothing sensitive.
// - v2 full briefing payloads (`{ lang, org, path, day }`) store metadata only in `mail_message.payload`; `morningMailTemplate.render`
//   fails closed until Slice A wires `meetings.morning.mail_content`, and `renderMorningBriefingMail` strictly validates both the stored
//   payload and the render-time briefing content (with matching `day`), strips invisible/control characters, validates same-org internal
//   paths, formats decimal-string money via `@ludy/l10n-vn`, and escapes every dynamic field in HTML.
import {
  MORNING_BRIEFING_CAPS,
  followupClean,
  zMorningBriefingContent,
  zMorningBriefingMail,
  zMorningMail,
  type MorningBriefingDeal,
  type MorningBriefingMeeting,
  type MorningBriefingOpenItem,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
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

const BRIEFING_COPY = {
  vi: {
    title: (day: string, org: string) => `Lịch họp ngày ${day} tại ${org}`,
    leadNone: 'Hôm nay bạn không có cuộc họp nào trong lịch.',
    leadCount: (total: number) => `Hôm nay bạn có ${total} cuộc họp.`,
    truncated: (shown: number, total: number) =>
      shown === 0
        ? `Mở trang Cuộc họp để xem chi tiết ${total} cuộc họp hôm nay.`
        : `Đang hiển thị ${shown} cuộc họp đầu tiên trong tổng số ${total} cuộc họp.`,
    openMeetings: 'Mở trang Cuộc họp',
    untitled: 'Cuộc họp không tiêu đề',
    openMeeting: 'Mở cuộc họp',
    openRecord: 'Mở trang ghi cuộc họp',
    attendeesLabel: 'Thành phần',
    invitees: (count: number) => `${count} khách mời`,
    readersPrefix: 'Người đọc trong tổ chức: ',
    moreReaders: (count: number) => `+${count} khác`,
    decisionsHeading: 'Quyết định từ cuộc họp trước',
    openItemsHeading: 'Việc cần làm còn mở',
    overdue: 'Quá hạn',
    mine: 'Việc của bạn',
    dueOn: (day: string) => `Hạn ${day}`,
    dealsHeading: 'Cơ hội CRM đang mở',
    openDeals: 'Xem danh sách cơ hội',
    expectedClose: (day: string) => `Dự kiến chốt ${day}`,
    vyHeading: 'Gợi ý chuẩn bị của Vy',
    footer: (brand: string, org: string) =>
      `Thư này chứa nội dung các cuộc họp của bạn và do ${brand} gửi theo lựa chọn của bạn ở ${org}.`,
    settingsLink: 'Tắt thông báo này trong Cài đặt thông báo',
  },
  en: {
    title: (day: string, org: string) => `Meetings for ${day} at ${org}`,
    leadNone: 'You have no meetings scheduled today.',
    leadCount: (total: number) => (total === 1 ? 'You have 1 meeting today.' : `You have ${total} meetings today.`),
    truncated: (shown: number, total: number) =>
      shown === 0
        ? `Open Meetings to see all ${total} meetings today.`
        : `Showing the first ${shown} of ${total} meetings.`,
    openMeetings: 'Open Meetings',
    untitled: 'Untitled meeting',
    openMeeting: 'Open meeting',
    openRecord: 'Open meeting recorder',
    attendeesLabel: 'Attendees',
    invitees: (count: number) => (count === 1 ? '1 invitee' : `${count} invitees`),
    readersPrefix: 'Org readers: ',
    moreReaders: (count: number) => `+${count} more`,
    decisionsHeading: 'Decisions from previous meeting',
    openItemsHeading: 'Open action items',
    overdue: 'Overdue',
    mine: 'Yours',
    dueOn: (day: string) => `Due ${day}`,
    dealsHeading: 'Open CRM deals',
    openDeals: 'Open deals list',
    expectedClose: (day: string) => `Expected close ${day}`,
    vyHeading: 'Vy prep lines',
    footer: (brand: string, org: string) =>
      `This email contains your meeting content and was sent by ${brand} because you asked for it in ${org}.`,
    settingsLink: 'Turn this notice off in Notification settings',
  },
} as const;

type BriefingLang = keyof typeof BRIEFING_COPY;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const oneLine = (value: string): string => followupClean(value, true);

function formatDay(day: string, lang: BriefingLang): string {
  const [y, m, d] = day.split('-');
  if (!y || !m || !d) return day;
  return lang === 'vi' ? `${d}/${m}/${y}` : day;
}

function normalizeUtcOffset(raw: string | undefined): string {
  const cleaned = (raw ?? 'GMT+00:00').replace('\u2212', '-');
  if (cleaned === 'GMT' || cleaned === 'UTC') return 'UTC+00:00';
  return cleaned.startsWith('GMT') ? `UTC${cleaned.slice(3)}` : cleaned;
}

function formatZonedParts(
  ms: number,
  timeZone: string,
): { year: string; month: string; day: string; hour: string; minute: string; offset: string } | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    const parts: Record<string, string> = {};
    for (const part of fmt.formatToParts(new Date(ms))) {
      parts[part.type] = part.value;
    }
    if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) return null;
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour === '24' ? '00' : parts.hour,
      minute: parts.minute,
      offset: normalizeUtcOffset(parts.timeZoneName),
    };
  } catch {
    return null;
  }
}

function formatTimeWindow(startAt: string, endAt: string, timeZone: string, contentDay: string, lang: BriefingLang): string {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return `${oneLine(startAt)} - ${oneLine(endAt)} (${oneLine(timeZone)})`;
  }
  let zone = timeZone;
  let startParts = formatZonedParts(startMs, zone);
  let endParts = startParts ? formatZonedParts(endMs, zone) : null;
  if (!startParts || !endParts) {
    zone = 'UTC';
    startParts = formatZonedParts(startMs, zone);
    endParts = formatZonedParts(endMs, zone);
  }
  if (!startParts || !endParts) {
    return `${oneLine(startAt)} - ${oneLine(endAt)} (${oneLine(zone)})`;
  }
  const startDay = `${startParts.year}-${startParts.month}-${startParts.day}`;
  const endDay = `${endParts.year}-${endParts.month}-${endParts.day}`;
  const showOffsets = startParts.offset !== endParts.offset;
  const startTime = `${startParts.hour}:${startParts.minute}${showOffsets ? ` (${startParts.offset})` : ''}`;
  const endTime = `${endParts.hour}:${endParts.minute}${showOffsets ? ` (${endParts.offset})` : ''}`;
  if (startDay === endDay) {
    return startDay === contentDay
      ? `${startTime} - ${endTime} (${zone})`
      : `${formatDay(startDay, lang)} ${startTime} - ${endTime} (${zone})`;
  }
  return `${formatDay(startDay, lang)} ${startTime} - ${formatDay(endDay, lang)} ${endTime} (${zone})`;
}

// Decimal-string money formatting via decimal.js (`money`), avoiding JS float conversion.
function formatDealAmount(value: string, lang: BriefingLang): string {
  const fixed = money(value).toFixed();
  const negative = fixed.startsWith('-');
  const [whole = '0', fraction] = (negative ? fixed.slice(1) : fixed).split('.');
  const groupSep = lang === 'vi' ? '.' : ',';
  const decimalSep = lang === 'vi' ? ',' : '.';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const amount = `${negative ? '-' : ''}${grouped}${fraction ? `${decimalSep}${fraction}` : ''}`;
  return lang === 'vi' ? `${amount} đồng` : `${amount} VND`;
}

function normalizePublicRoot(publicUrl: string): string {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(publicUrl)) {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl');
  }
  const root = publicUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(root);
  } catch {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl protocol');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    root.includes('?') ||
    root.includes('#')
  ) {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl credentials or suffix');
  }
  return root;
}

function meetingLinkLabel(path: string | undefined, orgPrefix: string, lang: BriefingLang): string {
  const t = BRIEFING_COPY[lang];
  if (!path || path === `${orgPrefix}/meetings`) return t.openMeetings;
  if (path === `${orgPrefix}/meetings/record`) return t.openRecord;
  return t.openMeeting;
}

function buildAttendeesLine(meeting: MorningBriefingMeeting, lang: BriefingLang): string | null {
  const t = BRIEFING_COPY[lang];
  const parts: string[] = [];
  if (meeting.inviteeCount > 0) {
    parts.push(t.invitees(meeting.inviteeCount));
  }
  const readers = meeting.readerNames.map(oneLine).filter((name) => name !== '');
  if (readers.length > 0 || meeting.extraReadersCount > 0) {
    const extra = meeting.extraReadersCount > 0 ? t.moreReaders(meeting.extraReadersCount) : '';
    const readerSummary =
      readers.length > 0 && extra !== ''
        ? `${readers.join(', ')} (${extra})`
        : readers.length > 0
          ? readers.join(', ')
          : extra;
    parts.push(`${t.readersPrefix}${readerSummary}`);
  }
  return parts.length > 0 ? `${t.attendeesLabel}: ${parts.join('; ')}` : null;
}

function formatOpenItemText(item: MorningBriefingOpenItem, lang: BriefingLang): { text: string; tags: string[]; dueText: string | null } | null {
  const cleaned = oneLine(item.text);
  if (cleaned === '') return null;
  const t = BRIEFING_COPY[lang];
  const tags: string[] = [];
  if (item.mine) tags.push(t.mine);
  if (item.overdue) tags.push(t.overdue);
  const dueText = item.dueOn ? t.dueOn(formatDay(item.dueOn, lang)) : null;
  if (dueText) tags.push(dueText);
  return { text: cleaned, tags, dueText };
}

function formatDealSummary(deal: MorningBriefingDeal, lang: BriefingLang): { title: string; details: string[] } | null {
  const title = oneLine(deal.title);
  if (title === '') return null;
  const t = BRIEFING_COPY[lang];
  const details: string[] = [];
  const stage = oneLine(deal.stage);
  if (stage !== '') details.push(stage);
  if (deal.amount != null) details.push(formatDealAmount(deal.amount, lang));
  if (deal.expectedClose) details.push(t.expectedClose(formatDay(deal.expectedClose, lang)));
  return { title, details };
}

function renderMeetingBlock(
  meeting: MorningBriefingMeeting,
  contentDay: string,
  lang: BriefingLang,
  orgPrefix: string,
  fallbackPath: string,
  dealsUrl: string,
  safeUrl: (path: string) => string,
): { textLines: string[]; html: string } {
  const t = BRIEFING_COPY[lang];
  const timeWindow = formatTimeWindow(meeting.startAt, meeting.endAt, meeting.timeZone, contentDay, lang);
  const title = oneLine(meeting.title) || t.untitled;
  if (
    meeting.path !== undefined &&
    meeting.path !== `${orgPrefix}/meetings` &&
    !meeting.path.startsWith(`${orgPrefix}/meetings/`)
  ) {
    throw new Error('TEMPLATE_DATA: invalid meeting briefing path');
  }
  const meetingUrl = safeUrl(meeting.path ?? fallbackPath);
  const openLabel = meetingLinkLabel(meeting.path, orgPrefix, lang);
  const attendees = buildAttendeesLine(meeting, lang);
  const decisions = meeting.previousDecisions.map(oneLine).filter((d) => d !== '');
  const items = meeting.openItems
    .map((item) => {
      const formatted = formatOpenItemText(item, lang);
      return formatted ? { raw: item, ...formatted } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const deals = meeting.deals
    .map((deal) => formatDealSummary(deal, lang))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const vyLines = (meeting.vyLines ?? []).map(oneLine).filter((line) => line !== '');

  const textLines: string[] = [`${timeWindow} | ${title}`, `${openLabel}: ${meetingUrl}`];
  if (attendees) textLines.push(attendees);
  if (decisions.length > 0) {
    textLines.push(`${t.decisionsHeading}:`, ...decisions.map((d) => `  - ${d}`));
  }
  if (items.length > 0) {
    textLines.push(
      `${t.openItemsHeading}:`,
      ...items.map((item) => `  - ${item.text}${item.tags.length > 0 ? ` (${item.tags.join(', ')})` : ''}`),
    );
  }
  if (deals.length > 0) {
    textLines.push(
      `${t.dealsHeading}:`,
      ...deals.map((deal) => `  - ${deal.title}${deal.details.length > 0 ? ` (${deal.details.join(' | ')})` : ''}`),
      `  ${t.openDeals}: ${dealsUrl}`,
    );
  }
  if (vyLines.length > 0) {
    textLines.push(`${t.vyHeading}:`, ...vyLines.map((line) => `  - ${line}`));
  }

  const htmlParts: string[] = [
    '<section style="margin:0 0 18px;padding:14px 16px;border:1px solid #d0d7de;border-radius:8px;background:#ffffff">',
    `<p style="margin:0 0 4px;font-size:13px;color:#57606a">${escapeHtml(timeWindow)}</p>`,
    `<h2 style="margin:0 0 8px;font-size:16px;line-height:1.4;color:#1f2328">${escapeHtml(title)}</h2>`,
  ];
  if (attendees) {
    htmlParts.push(`<p style="margin:0 0 8px;font-size:14px;color:#57606a">${escapeHtml(attendees)}</p>`);
  }
  if (decisions.length > 0) {
    htmlParts.push(
      `<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(t.decisionsHeading)}</h3>`,
      `<ul style="margin:0 0 8px;padding-left:18px">${decisions.map((d) => `<li style="margin:2px 0">${escapeHtml(d)}</li>`).join('')}</ul>`,
    );
  }
  if (items.length > 0) {
    const itemLis = items
      .map((item) => {
        const badges = [
          ...(item.raw.mine
            ? [
                `<span style="display:inline-block;padding:1px 6px;margin-right:6px;border-radius:4px;font-size:12px;font-weight:600;background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe">${escapeHtml(t.mine)}</span>`,
              ]
            : []),
          ...(item.raw.overdue
            ? [
                `<span style="display:inline-block;padding:1px 6px;margin-right:6px;border-radius:4px;font-size:12px;font-weight:600;background:#fef2f2;color:#991b1b;border:1px solid #fecaca">${escapeHtml(t.overdue)}</span>`,
              ]
            : []),
        ].join('');
        const dueHtml = item.dueText ? ` <span style="font-size:13px;color:#57606a">(${escapeHtml(item.dueText)})</span>` : '';
        return `<li style="margin:4px 0">${badges}${escapeHtml(item.text)}${dueHtml}</li>`;
      })
      .join('');
    htmlParts.push(
      `<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(t.openItemsHeading)}</h3>`,
      `<ul style="margin:0 0 8px;padding-left:18px">${itemLis}</ul>`,
    );
  }
  if (deals.length > 0) {
    const dealLis = deals
      .map(
        (deal) =>
          `<li style="margin:4px 0">${escapeHtml(deal.title)}${deal.details.length > 0 ? ` <span style="font-size:13px;color:#57606a">(${escapeHtml(deal.details.join(' | '))})</span>` : ''}</li>`,
      )
      .join('');
    htmlParts.push(
      `<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(t.dealsHeading)}</h3>`,
      `<ul style="margin:0 0 8px;padding-left:18px">${dealLis}</ul>`,
      `<p style="margin:6px 0 8px"><a href="${escapeHtml(dealsUrl)}" aria-label="${escapeHtml(`${t.openDeals}: ${title}`)}" style="display:inline-block;padding:10px 14px;min-height:44px;line-height:22px;box-sizing:border-box;border:1px solid #d0d7de;border-radius:6px;color:#b91c1c;text-decoration:underline;font-weight:600">${escapeHtml(t.openDeals)}</a></p>`,
    );
  }
  if (vyLines.length > 0) {
    htmlParts.push(
      '<div style="margin:10px 0 0;padding:10px 12px;background:#f6f8fa;border-left:3px solid #57606a;border-radius:4px">',
      `<h3 style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(t.vyHeading)}</h3>`,
      `<ul style="margin:0;padding-left:18px">${vyLines.map((line) => `<li style="margin:2px 0">${escapeHtml(line)}</li>`).join('')}</ul>`,
      '</div>',
    );
  }
  htmlParts.push(
    `<p style="margin:12px 0 0"><a href="${escapeHtml(meetingUrl)}" aria-label="${escapeHtml(`${openLabel}: ${title}`)}" style="display:inline-block;padding:10px 14px;min-height:44px;line-height:22px;box-sizing:border-box;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;text-decoration:underline;font-weight:600">${escapeHtml(openLabel)}</a></p>`,
    '</section>',
  );
  return { textLines, html: htmlParts.join('\n') };
}

/**
 * Renders the full v2 daily briefing email (`vi` and `en`, plain text and escaped HTML).
 * Returns `null` when `context.subject` is missing or blank after cleaning; throws when
 * `rawMail`, `rawContent`, `context.publicUrl`, or internal paths violate the strict briefing
 * contract or when `content.day !== mail.day`.
 */
export function renderMorningBriefingMail(
  rawMail: unknown,
  rawContent: unknown,
  context: {
    subject: string | null | undefined;
    publicUrl: string;
    brand?: string | undefined;
  },
): { subject: string; text: string; html: string } | null {
  const subject = oneLine(context.subject ?? '');
  if (!subject) return null;

  const mail = zMorningBriefingMail.parse(rawMail);
  const content = zMorningBriefingContent.parse(rawContent);
  if (content.day !== mail.day) {
    throw new Error('TEMPLATE_DATA: morning briefing day mismatch');
  }

  const root = normalizePublicRoot(context.publicUrl);
  const orgPrefix = mail.path.slice(0, -'/meetings'.length);
  const safeUrl = (path: string): string => {
    if (!MORNING_BRIEFING_CAPS.pathRegex.test(path) || !path.startsWith(`${orgPrefix}/`)) {
      throw new Error('TEMPLATE_DATA: invalid morning briefing path');
    }
    return `${root}${path}`;
  };

  const t = BRIEFING_COPY[mail.lang];
  const brand = oneLine(context.brand ?? '') || 'Ludy';
  const org = oneLine(mail.org) || brand;
  const formattedDay = formatDay(content.day, mail.lang);
  const heading = t.title(formattedDay, org);
  const lead = content.totalMeetings === 0 ? t.leadNone : t.leadCount(content.totalMeetings);
  const truncatedNote =
    content.totalMeetings > content.meetings.length ? t.truncated(content.meetings.length, content.totalMeetings) : null;

  const meetingsUrl = safeUrl(mail.path);
  const dealsUrl = safeUrl(`${orgPrefix}/deals`);
  const settingsUrl = safeUrl(`${orgPrefix}/settings/notifications`);

  const renderedMeetings = content.meetings.map((meeting) =>
    renderMeetingBlock(meeting, content.day, mail.lang, orgPrefix, mail.path, dealsUrl, safeUrl),
  );

  const textParts: string[] = [heading, '', lead];
  if (truncatedNote) textParts.push(truncatedNote);
  textParts.push('', `${t.openMeetings}: ${meetingsUrl}`);
  for (const block of renderedMeetings) {
    textParts.push('', ...block.textLines);
  }
  textParts.push('', t.footer(brand, org), `${t.settingsLink}: ${settingsUrl}`);

  const html = `<!doctype html>
<html lang="${mail.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;background:#ffffff;margin:0;padding:16px">
<div style="max-width:640px">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
<p style="margin:0 0 8px">${escapeHtml(lead)}</p>
${truncatedNote ? `<p style="margin:0 0 12px;font-size:14px;color:#57606a">${escapeHtml(truncatedNote)}</p>` : ''}
<p style="margin:12px 0 20px"><a href="${escapeHtml(meetingsUrl)}" style="display:inline-block;padding:10px 16px;min-height:44px;line-height:24px;box-sizing:border-box;background:#b91c1c;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(t.openMeetings)}</a></p>
${renderedMeetings.map((block) => block.html).join('\n')}
<p style="margin:20px 0 4px;font-size:13px;color:#57606a">${escapeHtml(t.footer(brand, org))}</p>
<p style="margin:0"><a href="${escapeHtml(settingsUrl)}" style="display:inline-block;padding:10px 0;min-height:44px;line-height:24px;box-sizing:border-box;font-size:13px;color:#57606a;text-decoration:underline">${escapeHtml(t.settingsLink)}</a></p>
</div>
</body></html>`;

  return { subject, text: textParts.join('\n'), html };
}

export const morningMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not exactly the template's throws; the queue records TEMPLATE_DATA.
    const mail = zMorningMail.parse(input.payload);
    // Fail closed until Slice C implements render-time full briefing lookup and templates.
    if (!('count' in mail)) return null;
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
