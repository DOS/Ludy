// SPDX-License-Identifier: AGPL-3.0-only
// The morning mail and daily briefing of the day's meetings (#3955, #5080, template meetings.morning):
// - v1 count-only payloads (`{ lang, org, count, path }`) hold only the count and meetings link, nothing sensitive.
// - v2 full briefing payloads (`{ lang, org, path, day }`) store metadata only in `mail_message.payload`; `morningMailTemplate.render`
//   fails closed until Slice A wires `meetings.morning.mail_content`, and `renderMorningBriefingMail` strictly validates both the stored
//   payload and the render-time briefing content (with matching `day`), uses a fixed non-sensitive subject, strips invisible/control
//   characters with post-NFKC caps, canonicalizes `publicUrl` and validates same-org internal paths, formats decimal-string money via
//   `@ludy/l10n-vn`, keeps attributes free of titles/names, keeps HTML under Gmail's 102 KB clip boundary so the opt-out footer stays
//   visible, and escapes every dynamic field in HTML.
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

const ORG_NAME_MAX = 200;
const BRAND_NAME_MAX = 200;
// Keep rendered HTML safely under Gmail's ~102 KB clipping boundary so the footer and opt-out link are never clipped off.
const BRIEFING_HTML_MAX_BYTES = 96 * 1024;

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
    subject: 'Lịch họp trong ngày',
    title: (day: string, org: string) => `Lịch họp ngày ${day} tại ${org}`,
    leadNone: (day: string) => `Ngày ${day} bạn không có cuộc họp nào trong lịch.`,
    leadCount: (day: string, total: number) => `Ngày ${day} bạn có ${total} cuộc họp.`,
    truncated: (shown: number, total: number, day: string) =>
      shown === 0
        ? `Mở trang Cuộc họp để xem chi tiết ${total} cuộc họp ngày ${day}.`
        : `Đang hiển thị ${shown} cuộc họp đầu tiên trong tổng số ${total} cuộc họp ngày ${day}.`,
    openMeetings: 'Mở trang Cuộc họp',
    meetingLabel: (index: number) => `Cuộc họp ${index}`,
    timeLabel: 'Thời gian',
    untitled: 'Cuộc họp không tiêu đề',
    openMeeting: 'Mở cuộc họp',
    openRecord: 'Mở trang ghi cuộc họp',
    meetingAria: (label: string, index: number) => `${label} (cuộc họp ${index})`,
    attendeesLabel: 'Thành phần',
    inviteesLabel: 'Khách mời',
    invitees: (count: number) => `${count} khách mời`,
    readersHeading: 'Người đọc trong tổ chức',
    moreReaders: (count: number) => `+${count} khác`,
    decisionsHeading: 'Quyết định từ cuộc họp trước',
    openItemsHeading: 'Việc cần làm còn mở',
    overdue: 'Quá hạn',
    mine: 'Việc của bạn',
    dueOn: (day: string) => `Hạn ${day}`,
    dealsHeading: 'Cơ hội CRM đang mở',
    dealStageLabel: 'Giai đoạn',
    dealAmountLabel: 'Giá trị',
    dealExpectedCloseLabel: 'Dự kiến chốt',
    expectedClose: (day: string) => `Dự kiến chốt ${day}`,
    openDeals: 'Xem danh sách cơ hội',
    dealsAria: (index: number) => `Xem danh sách cơ hội (cuộc họp ${index})`,
    vyHeading: 'Gợi ý chuẩn bị của Vy',
    footer: (brand: string, org: string) =>
      `Thư này chứa nội dung các cuộc họp của bạn và do ${brand} gửi theo lựa chọn của bạn ở ${org}.`,
    settingsLink: 'Tắt thông báo này trong Cài đặt thông báo',
  },
  en: {
    subject: 'Daily meeting briefing',
    title: (day: string, org: string) => `Meetings for ${day} at ${org}`,
    leadNone: (day: string) => `You have no meetings scheduled for ${day}.`,
    leadCount: (day: string, total: number) =>
      total === 1 ? `You have 1 meeting scheduled for ${day}.` : `You have ${total} meetings scheduled for ${day}.`,
    truncated: (shown: number, total: number, day: string) =>
      shown === 0
        ? `Open Meetings to see all ${total} meetings for ${day}.`
        : `Showing the first ${shown} of ${total} meetings for ${day}.`,
    openMeetings: 'Open Meetings',
    meetingLabel: (index: number) => `Meeting ${index}`,
    timeLabel: 'Time',
    untitled: 'Untitled meeting',
    openMeeting: 'Open meeting',
    openRecord: 'Open meeting recorder',
    meetingAria: (label: string, index: number) => `${label} (meeting ${index})`,
    attendeesLabel: 'Attendees',
    inviteesLabel: 'Invitees',
    invitees: (count: number) => (count === 1 ? '1 invitee' : `${count} invitees`),
    readersHeading: 'Org readers',
    moreReaders: (count: number) => `+${count} more`,
    decisionsHeading: 'Decisions from previous meeting',
    openItemsHeading: 'Open action items',
    overdue: 'Overdue',
    mine: 'Yours',
    dueOn: (day: string) => `Due ${day}`,
    dealsHeading: 'Open CRM deals',
    dealStageLabel: 'Stage',
    dealAmountLabel: 'Amount',
    dealExpectedCloseLabel: 'Expected close',
    expectedClose: (day: string) => `Expected close ${day}`,
    openDeals: 'Open deals list',
    dealsAria: (index: number) => `Open deals list (meeting ${index})`,
    vyHeading: 'Vy prep lines',
    footer: (brand: string, org: string) =>
      `This email contains your meeting content and was sent by ${brand} because you asked for it in ${org}.`,
    settingsLink: 'Turn this notice off in Notification settings',
  },
} as const;

type BriefingLang = keyof typeof BRIEFING_COPY;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function oneLine(value: string, max?: number): string {
  const cleaned = followupClean(value, true);
  if (max === undefined) return cleaned;
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : cleaned;
}

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
  if (startParts.offset !== endParts.offset) {
    const startClock = `${startParts.hour}:${startParts.minute} (${startParts.offset})`;
    const endClock = `${endParts.hour}:${endParts.minute} (${endParts.offset})`;
    if (startDay === endDay) {
      return startDay === contentDay
        ? `${startClock} - ${endClock} (${zone})`
        : `${formatDay(startDay, lang)} ${startClock} - ${endClock} (${zone})`;
    }
    return `${formatDay(startDay, lang)} ${startClock} - ${formatDay(endDay, lang)} ${endClock} (${zone})`;
  }
  const startClock = `${startParts.hour}:${startParts.minute}`;
  const endClock = `${endParts.hour}:${endParts.minute}`;
  const zoneLabel = `${zone}, ${startParts.offset}`;
  if (startDay === endDay) {
    return startDay === contentDay
      ? `${startClock} - ${endClock} (${zoneLabel})`
      : `${formatDay(startDay, lang)} ${startClock} - ${endClock} (${zoneLabel})`;
  }
  return `${formatDay(startDay, lang)} ${startClock} - ${formatDay(endDay, lang)} ${endClock} (${zoneLabel})`;
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
  const trimmed = publicUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl protocol');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
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
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error('TEMPLATE_DATA: invalid morning briefing publicUrl credentials or suffix');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function meetingLinkLabel(path: string | undefined, orgPrefix: string, lang: BriefingLang): string {
  const t = BRIEFING_COPY[lang];
  if (!path || path === `${orgPrefix}/meetings`) return t.openMeetings;
  if (path === `${orgPrefix}/meetings/record`) return t.openRecord;
  return t.openMeeting;
}

function buildAttendees(
  meeting: MorningBriefingMeeting,
  lang: BriefingLang,
): { textLines: string[]; htmlLine: string } {
  const t = BRIEFING_COPY[lang];
  const readers = meeting.readerNames
    .map((name) => oneLine(name, MORNING_BRIEFING_CAPS.nameMax))
    .filter((name) => name !== '');
  const hasReaders = readers.length > 0 || meeting.extraReadersCount > 0;
  const inviteesText = t.invitees(meeting.inviteeCount);

  const textLines: string[] = [`${t.attendeesLabel}:`, `  ${t.inviteesLabel}: ${inviteesText}`];
  const htmlParts: string[] = [inviteesText];

  if (hasReaders) {
    const extra = meeting.extraReadersCount > 0 ? t.moreReaders(meeting.extraReadersCount) : '';
    textLines.push(`  ${t.readersHeading}:`);
    for (const reader of readers) {
      textLines.push(`  - ${reader}`);
    }
    if (extra !== '') {
      textLines.push(`  - ${extra}`);
    }
    const readerSummary =
      readers.length > 0 && extra !== ''
        ? `${readers.join(', ')} (${extra})`
        : readers.length > 0
          ? readers.join(', ')
          : extra;
    htmlParts.push(`${t.readersHeading}: ${readerSummary}`);
  }

  return { textLines, htmlLine: `${t.attendeesLabel}: ${htmlParts.join('; ')}` };
}

function formatOpenItemText(
  item: MorningBriefingOpenItem,
  lang: BriefingLang,
): { text: string; markers: string[]; dueText: string | null } | null {
  const cleaned = oneLine(item.text, MORNING_BRIEFING_CAPS.actionItemTextMax);
  if (cleaned === '') return null;
  const t = BRIEFING_COPY[lang];
  const markers: string[] = [];
  if (item.mine) markers.push(t.mine);
  if (item.overdue) markers.push(t.overdue);
  const dueText = item.dueOn ? t.dueOn(formatDay(item.dueOn, lang)) : null;
  if (dueText) markers.push(dueText);
  return { text: cleaned, markers, dueText };
}

function formatDealSummary(
  deal: MorningBriefingDeal,
  lang: BriefingLang,
): { title: string; labeledLines: string[]; htmlDetails: string[] } | null {
  const title = oneLine(deal.title, MORNING_BRIEFING_CAPS.dealTitleMax);
  if (title === '') return null;
  const t = BRIEFING_COPY[lang];
  const labeledLines: string[] = [];
  const htmlDetails: string[] = [];
  const stage = oneLine(deal.stage, MORNING_BRIEFING_CAPS.dealStageMax);
  if (stage !== '') {
    labeledLines.push(`${t.dealStageLabel}: ${stage}`);
    htmlDetails.push(stage);
  }
  if (deal.amount != null) {
    const formattedAmount = formatDealAmount(deal.amount, lang);
    labeledLines.push(`${t.dealAmountLabel}: ${formattedAmount}`);
    htmlDetails.push(formattedAmount);
  }
  if (deal.expectedClose) {
    const formattedClose = formatDay(deal.expectedClose, lang);
    labeledLines.push(`${t.dealExpectedCloseLabel}: ${formattedClose}`);
    htmlDetails.push(t.expectedClose(formattedClose));
  }
  return { title, labeledLines, htmlDetails };
}

function renderMeetingBlock(
  meeting: MorningBriefingMeeting,
  meetingIndex: number,
  contentDay: string,
  lang: BriefingLang,
  orgPrefix: string,
  fallbackPath: string,
  dealsUrl: string,
  safeUrl: (path: string) => string,
): { textLines: string[]; html: string } {
  const t = BRIEFING_COPY[lang];
  const timeWindow = formatTimeWindow(meeting.startAt, meeting.endAt, meeting.timeZone, contentDay, lang);
  const title = oneLine(meeting.title, MORNING_BRIEFING_CAPS.titleMax) || t.untitled;
  if (
    meeting.path !== undefined &&
    meeting.path !== `${orgPrefix}/meetings` &&
    !meeting.path.startsWith(`${orgPrefix}/meetings/`)
  ) {
    throw new Error('TEMPLATE_DATA: invalid meeting briefing path');
  }
  const meetingUrl = safeUrl(meeting.path ?? fallbackPath);
  const openLabel = meetingLinkLabel(meeting.path, orgPrefix, lang);
  const attendees = buildAttendees(meeting, lang);
  const decisions = meeting.previousDecisions
    .map((d) => oneLine(d, MORNING_BRIEFING_CAPS.decisionTextMax))
    .filter((d) => d !== '');
  const items = meeting.openItems
    .map((item) => {
      const formatted = formatOpenItemText(item, lang);
      return formatted ? { raw: item, ...formatted } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const deals = meeting.deals
    .map((deal) => formatDealSummary(deal, lang))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const vyLines = (meeting.vyLines ?? [])
    .map((line) => oneLine(line, MORNING_BRIEFING_CAPS.vyLineTextMax))
    .filter((line) => line !== '');

  const textLines: string[] = [
    `${t.meetingLabel(meetingIndex)}: ${title}`,
    `${t.timeLabel}: ${timeWindow}`,
    `${openLabel}: ${meetingUrl}`,
    ...attendees.textLines,
  ];
  if (decisions.length > 0) {
    textLines.push(`${t.decisionsHeading}:`, ...decisions.map((d) => `  - ${d}`));
  }
  if (items.length > 0) {
    textLines.push(`${t.openItemsHeading}:`);
    for (const item of items) {
      textLines.push(`  - ${item.text}`);
      for (const marker of item.markers) {
        textLines.push(`    ${marker}`);
      }
    }
  }
  if (deals.length > 0) {
    textLines.push(`${t.dealsHeading}:`);
    for (const deal of deals) {
      textLines.push(`  - ${deal.title}`);
      for (const line of deal.labeledLines) {
        textLines.push(`    ${line}`);
      }
    }
    textLines.push(`  ${t.openDeals}: ${dealsUrl}`);
  }
  if (vyLines.length > 0) {
    textLines.push(`${t.vyHeading}:`, ...vyLines.map((line) => `  - ${line}`));
  }

  const htmlParts: string[] = [
    '<section style="margin:0 0 18px;padding:14px 16px;border:1px solid #d0d7de;border-radius:8px;background:#ffffff;overflow-wrap:anywhere;word-break:break-word">',
    `<p style="margin:0 0 4px;font-size:13px;color:#57606a">${escapeHtml(timeWindow)}</p>`,
    `<h2 style="margin:0 0 8px;font-size:16px;line-height:1.4;color:#1f2328;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(title)}</h2>`,
    `<p style="margin:0 0 8px;font-size:14px;color:#57606a">${escapeHtml(attendees.htmlLine)}</p>`,
  ];
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
          `<li style="margin:4px 0">${escapeHtml(deal.title)}${deal.htmlDetails.length > 0 ? ` <span style="font-size:13px;color:#57606a">(${escapeHtml(deal.htmlDetails.join(' | '))})</span>` : ''}</li>`,
      )
      .join('');
    htmlParts.push(
      `<h3 style="margin:10px 0 4px;font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(t.dealsHeading)}</h3>`,
      `<ul style="margin:0 0 8px;padding-left:18px">${dealLis}</ul>`,
      `<p style="margin:6px 0 8px"><a href="${escapeHtml(dealsUrl)}" aria-label="${escapeHtml(t.dealsAria(meetingIndex))}" style="display:inline-block;padding:10px 14px;min-height:44px;line-height:22px;box-sizing:border-box;border:1px solid #d0d7de;border-radius:6px;color:#b91c1c;text-decoration:underline;font-weight:600">${escapeHtml(t.openDeals)}</a></p>`,
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
    `<p style="margin:12px 0 0"><a href="${escapeHtml(meetingUrl)}" aria-label="${escapeHtml(t.meetingAria(openLabel, meetingIndex))}" style="display:inline-block;padding:10px 14px;min-height:44px;line-height:22px;box-sizing:border-box;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;text-decoration:underline;font-weight:600">${escapeHtml(openLabel)}</a></p>`,
    '</section>',
  );
  return { textLines, html: htmlParts.join('\n') };
}

/**
 * Renders the full v2 daily briefing email (`vi` and `en`, plain text and escaped HTML).
 * Returns `null` when `context.subject` is missing or blank after cleaning; always emits a fixed
 * language-specific subject (never echoing caller-supplied titles/names); throws when `rawMail`,
 * `rawContent`, `context.publicUrl`, or internal paths violate the strict briefing contract or when
 * `content.day !== mail.day`.
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
  if (!oneLine(context.subject ?? '')) return null;

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
  const brand = oneLine(context.brand ?? '', BRAND_NAME_MAX) || 'Ludy';
  const org = oneLine(mail.org, ORG_NAME_MAX) || brand;
  const formattedDay = formatDay(content.day, mail.lang);
  const heading = t.title(formattedDay, org);
  const lead = content.totalMeetings === 0 ? t.leadNone(formattedDay) : t.leadCount(formattedDay, content.totalMeetings);

  const meetingsUrl = safeUrl(mail.path);
  const dealsUrl = safeUrl(`${orgPrefix}/deals`);
  const settingsUrl = safeUrl(`${orgPrefix}/settings/notifications`);

  const renderedMeetings = content.meetings.map((meeting, idx) =>
    renderMeetingBlock(meeting, idx + 1, content.day, mail.lang, orgPrefix, mail.path, dealsUrl, safeUrl),
  );

  const buildHtml = (blocks: ReadonlyArray<{ html: string }>, note: string | null): string => `<!doctype html>
<html lang="${mail.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;background:#ffffff;margin:0;padding:16px">
<div style="max-width:640px;width:100%;overflow-wrap:anywhere;word-break:break-word">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
<p style="margin:0 0 8px">${escapeHtml(lead)}</p>
${note ? `<p style="margin:0 0 12px;font-size:14px;color:#57606a">${escapeHtml(note)}</p>` : ''}
<p style="margin:12px 0 20px"><a href="${escapeHtml(meetingsUrl)}" style="display:inline-block;padding:10px 16px;min-height:44px;line-height:24px;box-sizing:border-box;background:#b91c1c;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(t.openMeetings)}</a></p>
${blocks.map((block) => block.html).join('\n')}
<p style="margin:20px 0 4px;font-size:13px;color:#57606a">${escapeHtml(t.footer(brand, org))}</p>
<p style="margin:0"><a href="${escapeHtml(settingsUrl)}" style="display:inline-block;padding:10px 0;min-height:44px;line-height:24px;box-sizing:border-box;font-size:13px;color:#57606a;text-decoration:underline">${escapeHtml(t.settingsLink)}</a></p>
</div>
</body></html>`;

  const keptMeetings: Array<{ textLines: string[]; html: string }> = [];
  for (const block of renderedMeetings) {
    const candidate = [...keptMeetings, block];
    const candidateNote =
      content.totalMeetings > candidate.length ? t.truncated(candidate.length, content.totalMeetings, formattedDay) : null;
    if (Buffer.byteLength(buildHtml(candidate, candidateNote), 'utf8') > BRIEFING_HTML_MAX_BYTES) {
      break;
    }
    keptMeetings.push(block);
  }

  const truncatedNote =
    content.totalMeetings > keptMeetings.length ? t.truncated(keptMeetings.length, content.totalMeetings, formattedDay) : null;

  const textParts: string[] = [heading, '', lead];
  if (truncatedNote) textParts.push(truncatedNote);
  textParts.push('', `${t.openMeetings}: ${meetingsUrl}`);
  for (const block of keptMeetings) {
    textParts.push('', ...block.textLines);
  }
  textParts.push('', t.footer(brand, org), `${t.settingsLink}: ${settingsUrl}`);

  return { subject: t.subject, text: textParts.join('\n'), html: buildHtml(keptMeetings, truncatedNote) };
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
