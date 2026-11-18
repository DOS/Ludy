// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vietnamese (with or without diacritics) and English Quick Add parser for personal to-dos (#3556).
// Zero AI calls, zero async I/O, synchronous pure TypeScript using @crove/l10n-vn Gregorian & time-zone helpers.

import { daysInCalendarMonth, parseIsoCalendarDate } from './labor-contracts.ts';
import { assertValidTimeZone, formatZonedIsoOffset, zonedDateString, zonedInstant } from './time-zone.ts';

export type TodoQuickAddTokenKind = 'date' | 'time' | 'recurrence' | 'priority' | 'tag' | 'list';

export interface TodoQuickAddToken {
  kind: TodoQuickAddTokenKind;
  raw: string;
  start: number;
  end: number;
}

export type TodoQuickAddRecurrence =
  | {
      freq: 'daily';
      interval: number;
    }
  | {
      freq: 'weekly';
      interval: number;
      /** 0 = Sunday .. 6 = Saturday. */
      byWeekday?: number | undefined;
    }
  | {
      freq: 'monthly';
      interval: number;
      /** 1..31 or -1 for the last day of the month. */
      byMonthDay?: number | undefined;
    };

export interface TodoQuickAddOptions {
  now: Date;
  timeZone: string;
  defaultRemindBeforeMinutes?: number | undefined;
  dismissedTokens?: readonly Pick<TodoQuickAddToken, 'kind' | 'raw' | 'start' | 'end'>[] | undefined;
}

export interface TodoQuickAddResult {
  title: string;
  dueOn: string | null;
  dueTime: string | null;
  dueAt: string | null;
  remindAt: string | null;
  timeZone: string;
  recurrence: TodoQuickAddRecurrence | null;
  priority: 1 | 2 | 3 | 4 | null;
  tags: string[];
  listName: string | null;
  tokens: TodoQuickAddToken[];
}

interface Span {
  start: number;
  end: number;
}

interface WordToken {
  raw: string;
  nfcLower: string;
  isAscii: boolean;
  folded: string;
  start: number;
  end: number;
}

type DayPeriod = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

interface ParsedTimeInfo {
  hour: number;
  minute: number;
  explicitClock: boolean;
  hasAmPm?: boolean | undefined;
  period?: DayPeriod | undefined;
}

const DEFAULT_REMIND_BEFORE_MINUTES = 30;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_INTERVAL = 365;
const MINUTE_MS = 60_000;

const PERIOD_DEFAULT_HOUR: Record<DayPeriod, number> = {
  morning: 9,
  noon: 12,
  afternoon: 14,
  evening: 19,
  night: 21,
};

const ORDINAL_GUARD_WORDS = ['lần', 'bước', 'câu', 'người', 'phần', 'hạng', 'mục', 'loại', 'đợt', 'vòng', 'kỳ', 'tập'] as const;
const MAI_BEFORE_GUARDS = [
  'khuyến',
  'khuyên',
  'hoa',
  'mỉa',
  'anh',
  'chị',
  'em',
  'bạn',
  'cô',
  'chú',
  'bác',
  'ông',
  'bà',
  'sếp',
  'thầy',
  'cho',
  'với',
  'của',
  'nhờ',
  'cùng',
  'giúp',
  'giùm',
  'thay',
  'gặp',
  'mời',
  'đón',
  'tìm',
  'kêu',
  'theo',
  'về',
  'hỏi',
  'nhắc',
  'gửi',
  'bảo',
  'nhắn',
  'đưa',
  'giao',
] as const;
const MAI_AFTER_GUARDS = ['mối', 'sau', 'một', 'phục'] as const;
const HANG_CARGO_FOLDED_MODIFIERS = new Set([
  'boc',
  'check',
  'chot',
  'chuyen',
  'dat',
  'don',
  'dong',
  'giao',
  'gom',
  'gui',
  'hoan',
  'huy',
  'khach',
  'kho',
  'khui',
  'kiem',
  'lay',
  'mua',
  'ngan',
  'nguon',
  'nhan',
  'nhap',
  'ship',
  'soan',
  'xuat',
  'xuong',
]);
const HANG_CARGO_EXACT_MODIFIERS = new Set([
  'bán',
  'bạn',
  'chở',
  'cửa',
  'đổi',
  'lô',
  'mẫu',
  'mặt',
  'mối',
  'nhà',
  'quầy',
  'sạp',
  'tiền',
  'tiệm',
  'trả',
  'tồn',
  'tuyến',
  'xếp',
]);

const URL_RE = /(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>"{}|\\^`]+/gi;
const EMAIL_RE =
  /(?<![\p{L}\p{N}\p{M}._%+-])[\p{L}\p{N}\p{M}._%+-]+@[\p{L}\p{N}]+(?:-+[\p{L}\p{N}]+)*(?:\.[\p{L}\p{N}]+(?:-+[\p{L}\p{N}]+)*)+/giu;
const FILE_OR_DOMAIN_RE =
  /(?:^|(?<=[\s([,"'/]))(?<![\p{L}\p{N}\p{M}_.-])[\p{L}\p{N}\p{M}_]+(?:[.-]+[\p{L}\p{N}\p{M}_]+)*\.(?:[a-z][a-z0-9]{1,5}|PDF|DOCX?|XLSX?|PPTX?|CSV|TXT|MD|JSON|XML|PNG|JPE?G|GIF|SVG|ZIP|RAR|TAR|GZ)(?=$|[\s.,;:!?)\]"'])/gu;
const UNIX_ABS_PATH_RE =
  /(?:^|(?<=[\s([,"']))(?<![\p{L}\p{N}\p{M}_./-])(?:\/[\p{L}\p{N}\p{M}_.@-]+){2,}\/?(?=$|[\s.,;:!?)\]"'])/gu;
const UNIX_ROOTED_REL_PATH_RE =
  /(?:^|(?<=[\s([,"']))(?<![\p{L}\p{N}\p{M}_./-])(?:~|\.\.?)(?:\/[\p{L}\p{N}\p{M}_.@-]+)+\/?(?=$|[\s.,;:!?)\]"'])/gu;
const REL_SLASH_PATH_RE =
  /(?:^|(?<=[\s([,"']))(?<![\p{L}\p{N}\p{M}_./-])(?=[0-9_.-]*\p{L})[\p{L}\p{N}\p{M}_.-]+(?:\/[\p{L}\p{N}\p{M}_.@-]+)+\/?(?=$|[\s.,;:!?)\]"'])/gu;
const WIN_PATH_RE =
  /(?:^|(?<=[\s([,"']))(?<![\p{L}\p{N}\p{M}_./-])[A-Za-z]:(?:[\\/][\p{L}\p{N}\p{M}_.@-]+)+[\\/]?(?=$|[\s.,;:!?)\]"'])/gu;
const PRIORITY_RE = /(?:^|(?<=[\s([,]))!p([1-4])(?=$|[\s.,;:!?)\]])/gi;
const TAG_RE = /(?:^|(?<=[\s([,]))#(?=[0-9_-]*\p{L})([\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}_-]{0,39})(?=$|[\s.,;:!?)\]])/gu;
const LIST_QUOTED_RE = /(?:^|(?<=[\s([,]))\/"([^"\n]{1,60})"(?=$|[\s.,;:!?)\]])/gu;
const LIST_UNQUOTED_RE = /(?:^|(?<=[\s([,]))\/(?=[0-9_-]*\p{L})([\p{L}\p{N}\p{M}_.-]{1,40})(?=$|[\s.,;:!?)\]])/gu;
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

const ISO_TIMESTAMP_RE =
  /(?:^|(?<=[\s([,"']))\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?(?=$|[\s.,;:!?)\]"'])/gu;
const ISO_DATE_TOKEN_RE = /(?:^|(?<=[\s([,]))(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[\s.,;:!?)\]])/gu;
const DMY_DATE_TOKEN_RE =
  /(?<![\p{L}\p{N}\p{M}_/.-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\p{L}\p{N}\p{M}_/]|[.-][\p{L}\p{N}])/gu;

const VN_GIO_WORD = '(?:gi(?:ờ|ơ\\u0300|ò\\u031b|o\\u031b\\u0300|o\\u0300\\u031b|o))';
const VN_PHUT_WORD = '(?:ph(?:ú|u\\u0301|u)t|p)';
const VN_RUOI_WORD = '(?:r(?:ư|u\\u031b|u)(?:ỡ|ơ\\u0303|õ\\u031b|o\\u031b\\u0303|o\\u0303\\u031b|o)i)';

const CLOCK_COLON_RE =
  /(?<![\p{L}\p{N}\p{M}_:.+])(\d{1,2}):([0-5]\d)(?![\d:.]|[\p{L}\p{M}])(?![ \t]*(?:a\.m\.?|p\.m\.?|am|pm)(?![\p{L}\p{N}\p{M}]))/giu;
const CLOCK_AMPM_RE =
  /(?<![\p{L}\p{N}\p{M}_:.+])(\d{1,2})(?::([0-5]\d))?[ \t]*(a\.m\.?|p\.m\.?|am|pm)(?![\p{L}\p{N}\p{M}])/giu;
const CLOCK_VN_GIO_RE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_:.])((\\d{1,2})\\s*${VN_GIO_WORD})(?:\\s*(?:([0-5]?\\d)\\s*${VN_PHUT_WORD}|([0-5]\\d)(?!\\d|\\/|\\.[0-9]|-[0-9])|(${VN_RUOI_WORD})))?(?![\\p{L}\\p{N}\\p{M}])`,
  'giu',
);
const CLOCK_VN_SHORT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_:.])((\\d{1,2})\\s*([hg]))(?:([0-5]?\\d)(?!\\d|\\/|\\.[0-9]|-[0-9])(?:\\s*${VN_PHUT_WORD})?|[ \\t]+(?:([0-5]?\\d)(?!\\d|\\/|\\.[0-9]|-[0-9])[ \\t]*${VN_PHUT_WORD}|([0-5]\\d)(?!\\d|\\/|\\.[0-9]|-[0-9]))|\\s*(${VN_RUOI_WORD}))?(?![\\p{L}\\p{N}\\p{M}])`,
  'giu',
);

const VN_COUNT_NOUNS_AFTER_CLOCK = new Set([
  'nguoi',
  'cai',
  'chiec',
  'muc',
  'bai',
  'to',
  'cuon',
  'lan',
  'hop',
  'goi',
  'suat',
  'phan',
  'ban',
  'tap',
  've',
  'don',
  'mau',
  'khach',
  'dong',
  'nghin',
  'ngan',
  'trieu',
  'ty',
  'trang',
  'tep',
  'file',
  'item',
  'items',
  'people',
  'usd',
  'vnd',
]);

const TEMPORAL_UNITS_AFTER_CLOCK = new Set([
  'tuan',
  'thang',
  'nam',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'giay',
  'second',
  'seconds',
]);

// Strictly unambiguous SI / weight / volume / length / currency units that never collide with Vietnamese words.
const DMY_UNAMBIGUOUS_UNITS = new Set([
  'kg',
  'gr',
  'gram',
  'grams',
  'mg',
  'lit',
  'liter',
  'liters',
  'litre',
  'litres',
  'ml',
  'cl',
  'dl',
  'km',
  'cm',
  'mm',
  'm2',
  'm3',
  'oz',
  'lb',
  'lbs',
  'tbsp',
  'tsp',
  'vnd',
  'usd',
]);

// Packaging, duration, and count nouns blocked only for proper fractions (day < month, e.g. "1/2 hộp", "3/4 trang").
const DMY_FRACTION_NOUNS = new Set([
  'g',
  'l',
  'm',
  'ha',
  'tan',
  'ta',
  'yen',
  'lang',
  'can',
  'hop',
  'goi',
  'chai',
  'lon',
  'thung',
  'tui',
  'bao',
  'ly',
  'coc',
  'chen',
  'bat',
  'muong',
  'thia',
  'mieng',
  'lat',
  'khuc',
  'suat',
  'cup',
  'cups',
  'bottle',
  'bottles',
  'pack',
  'packs',
  'box',
  'boxes',
  'bag',
  'bags',
  'piece',
  'pieces',
  'slice',
  'slices',
  'trieu',
  'nghin',
  'ngan',
  'dong',
  'tr',
  'phan',
  'ban',
  'trang',
  'cuon',
  'to',
  'don',
  'qua',
  'trai',
  'cu',
  'con',
  'cai',
  'chiec',
  'gio',
  'tieng',
  'phut',
  'ngay',
  'tuan',
  'thang',
  'nam',
  'hour',
  'hours',
  'minute',
  'minutes',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'diem',
  'point',
  'points',
  'so',
  'luong',
  'quang',
  'bo',
  'set',
  'cap',
  'doi',
]);

function foldVn(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

function vnMatch(word: WordToken, targetNfc: string): boolean {
  const expected = targetNfc.normalize('NFC').toLowerCase();
  if (word.nfcLower === expected) return true;
  if (word.isAscii && foldVn(expected) === word.nfcLower) return true;
  return false;
}

function vnMatchAny(word: WordToken, targets: readonly string[]): boolean {
  return targets.some((t) => vnMatch(word, t));
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function hasOverlap(spans: readonly Span[], candidate: Span): boolean {
  return spans.some((s) => overlaps(s, candidate));
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextOccurrenceOfWeekday(today: string, targetWeekday: number, includeToday: boolean): string {
  const current = weekdayOfDate(today);
  let diff = (targetWeekday - current + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addLocalDays(today, diff);
}

function nextWeekOccurrenceOfWeekday(today: string, targetWeekday: number): string {
  const current = weekdayOfDate(today);
  const isoToday = current === 0 ? 7 : current;
  const isoTarget = targetWeekday === 0 ? 7 : targetWeekday;
  const mondayOfThisWeek = addLocalDays(today, -(isoToday - 1));
  const mondayOfNextWeek = addLocalDays(mondayOfThisWeek, 7);
  return addLocalDays(mondayOfNextWeek, isoTarget - 1);
}

function nextMonthDayDate(today: string, dayOfMonth: number): string {
  const parsed = parseIsoCalendarDate(today);
  if (!parsed) return today;
  const { year, month } = parsed;
  const resolve = (y: number, m: number) =>
    formatIsoDate(y, m, dayOfMonth === -1 ? daysInCalendarMonth(y, m) : Math.min(dayOfMonth, daysInCalendarMonth(y, m)));
  const thisMonth = resolve(year, month);
  if (thisMonth >= today) return thisMonth;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return resolve(nextYear, nextMonth);
}

function addCalendarMonthsForRecurrence(today: string, interval: number, byMonthDay?: number): string {
  const parsed = parseIsoCalendarDate(today);
  if (!parsed) return today;
  const totalMonths = parsed.year * 12 + (parsed.month - 1) + interval;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const maxDay = daysInCalendarMonth(targetYear, targetMonth);
  const targetDay = byMonthDay === -1 ? maxDay : Math.min(byMonthDay ?? parsed.day, maxDay);
  return formatIsoDate(targetYear, targetMonth, targetDay);
}

function findProtectedUrlSpans(input: string): Span[] {
  const spans: Span[] = [];
  for (const m of input.matchAll(URL_RE)) {
    const start = m.index;
    let raw = m[0];
    while (raw.length > 0 && /[.,;:!?)\]]/.test(raw[raw.length - 1] ?? '')) {
      const last = raw[raw.length - 1];
      if (last === ')' && raw.includes('(')) break;
      if (last === ']' && raw.includes('[')) break;
      raw = raw.slice(0, -1);
    }
    if (raw.length > 0) spans.push({ start, end: start + raw.length });
  }
  for (const re of [
    EMAIL_RE,
    FILE_OR_DOMAIN_RE,
    UNIX_ABS_PATH_RE,
    UNIX_ROOTED_REL_PATH_RE,
    REL_SLASH_PATH_RE,
    WIN_PATH_RE,
    ISO_TIMESTAMP_RE,
  ]) {
    for (const m of input.matchAll(re)) {
      if (m[0].length > 0) spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}

function tokenizeWords(input: string): WordToken[] {
  const words: WordToken[] = [];
  for (const m of input.matchAll(WORD_RE)) {
    const raw = m[0];
    const nfcLower = raw.normalize('NFC').toLowerCase();
    words.push({
      raw,
      nfcLower,
      isAscii: /^[a-z0-9]+$/.test(nfcLower),
      folded: foldVn(nfcLower),
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return words;
}

function spacesOnlyBetween(input: string, aEnd: number, bStart: number): boolean {
  if (bStart < aEnd) return false;
  return /^[ \t]+$/.test(input.slice(aEnd, bStart));
}

const TOI_PRONOUN_PRECEDING = [
  'cho',
  'với',
  'của',
  'giúp',
  'giùm',
  'nhờ',
  'cùng',
  'gửi',
  'bảo',
  'nhắc',
  'hỏi',
  'gọi',
  'nhắn',
  'đưa',
  'giao',
  'nói',
  'hẹn',
  'chờ',
  'đợi',
  'đón',
  'theo',
  'thay',
  'tìm',
  'mời',
  'kêu',
  'trả',
  'mà',
  'để',
  'tới',
  'xong',
  'rồi',
  'còn',
  'nếu',
  'khi',
] as const;

const VN_PERIOD_NAME_BEFORE_GUARDS = [
  'anh',
  'chị',
  'em',
  'bạn',
  'cô',
  'chú',
  'bác',
  'ông',
  'bà',
  'sếp',
  'thầy',
  'cháu',
  'bé',
  'cậu',
  'mợ',
  'dì',
  'dượng',
  'ngài',
  'mr',
  'mrs',
  'ms',
  'dr',
  'cho',
  'với',
  'của',
  'nhờ',
  'cùng',
  'giúp',
  'giùm',
  'thay',
  'gặp',
  'mời',
  'đón',
  'tìm',
  'kêu',
  'theo',
  'về',
  'hỏi',
  'nhắc',
  'gửi',
  'bảo',
  'nhắn',
  'đưa',
  'giao',
  'gọi',
  'nói',
  'hẹn',
  'chờ',
  'đợi',
  'chào',
] as const;
const VN_SANG_VERB_BEFORE_GUARDS = ['chuyển', 'dời', 'đổi', 'lùi', 'lịch'] as const;

function wordBefore(words: readonly WordToken[], target: WordToken): WordToken | undefined {
  const idx = words.indexOf(target);
  return idx > 0 ? words[idx - 1] : undefined;
}

function wordAfter(words: readonly WordToken[], target: WordToken): WordToken | undefined {
  const idx = words.indexOf(target);
  return idx >= 0 && idx + 1 < words.length ? words[idx + 1] : undefined;
}

function isProperCapitalizedWord(raw: string): boolean {
  return /^\p{Lu}\p{Ll}/u.test(raw);
}

function isVnPeriodGuardedAsNameOrVerb(
  word: WordToken,
  prevWord?: WordToken,
  input?: string,
  nextWord?: WordToken,
): boolean {
  const adjPrev = prevWord && (!input || spacesOnlyBetween(input, prevWord.end, word.start)) ? prevWord : undefined;
  if (!adjPrev) return false;
  if (vnMatchAny(adjPrev, ['buổi', 'vào', 'lúc']) || /^\d/.test(adjPrev.raw)) return false;

  const properCap = isProperCapitalizedWord(word.raw);
  if ((word.isAscii || properCap) && vnMatchAny(adjPrev, VN_PERIOD_NAME_BEFORE_GUARDS)) {
    return true;
  }
  if (word.isAscii && word.folded === 'sang' && vnMatchAny(adjPrev, VN_SANG_VERB_BEFORE_GUARDS)) {
    return true;
  }
  // Unaccented mid-clause names ("Minh Sang", "Tran Chieu") stay intact unless adjacent words are Title Case too.
  if (word.isAscii && properCap) {
    const adjNext = nextWord && (!input || spacesOnlyBetween(input, word.end, nextWord.start)) ? nextWord : undefined;
    if (!adjNext || !isProperCapitalizedWord(adjNext.raw)) {
      return true;
    }
  }
  return false;
}

function matchDayPeriod(
  word: WordToken,
  allowEnglishShort = true,
  prevWord?: WordToken,
  input?: string,
  nextWord?: WordToken,
): DayPeriod | null {
  if (allowEnglishShort && word.nfcLower === 'morning') return 'morning';
  if (allowEnglishShort && word.nfcLower === 'noon') return 'noon';
  if (allowEnglishShort && word.nfcLower === 'afternoon') return 'afternoon';
  if (allowEnglishShort && word.nfcLower === 'night') return 'night';
  if (allowEnglishShort && word.nfcLower === 'evening') return 'evening';

  if (vnMatch(word, 'sáng')) {
    return isVnPeriodGuardedAsNameOrVerb(word, prevWord, input, nextWord) ? null : 'morning';
  }
  if (vnMatch(word, 'trưa')) {
    return isVnPeriodGuardedAsNameOrVerb(word, prevWord, input, nextWord) ? null : 'noon';
  }
  if (vnMatch(word, 'chiều')) {
    return isVnPeriodGuardedAsNameOrVerb(word, prevWord, input, nextWord) ? null : 'afternoon';
  }
  if (vnMatch(word, 'đêm')) {
    return isVnPeriodGuardedAsNameOrVerb(word, prevWord, input, nextWord) ? null : 'night';
  }
  if (vnMatch(word, 'tối')) {
    // Unaccented ASCII "toi" collides with "tôi" (I/me) after prepositions/verbs ("cho toi ngay mai", "nhac toi").
    const adjPrev = prevWord && (!input || spacesOnlyBetween(input, prevWord.end, word.start)) ? prevWord : undefined;
    if (word.isAscii && adjPrev && vnMatchAny(adjPrev, TOI_PRONOUN_PRECEDING)) return null;
    if (isVnPeriodGuardedAsNameOrVerb(word, prevWord, input, nextWord)) return null;
    return 'evening';
  }
  return null;
}

function matchWeekday(
  input: string,
  words: readonly WordToken[],
  index: number,
  allowShortEnglish: boolean,
): { weekday: number; consumed: number } | null {
  const w0 = words[index];
  if (!w0) return null;
  const w1 = words[index + 1];

  // Vietnamese "thứ hai" .. "thứ bảy", "thứ 2" .. "thứ 7"
  if (vnMatch(w0, 'thứ') && w1 && spacesOnlyBetween(input, w0.end, w1.start)) {
    const prev = words[index - 1];
    if (prev && spacesOnlyBetween(input, prev.end, w0.start) && vnMatchAny(prev, ORDINAL_GUARD_WORDS)) {
      return null;
    }
    if (vnMatch(w1, 'hai') || w1.nfcLower === '2') return { weekday: 1, consumed: 2 };
    if (vnMatch(w1, 'ba') || w1.nfcLower === '3') return { weekday: 2, consumed: 2 };
    if (vnMatch(w1, 'tư') || w1.nfcLower === '4') return { weekday: 3, consumed: 2 };
    if (vnMatch(w1, 'năm') || w1.nfcLower === '5') return { weekday: 4, consumed: 2 };
    if (vnMatch(w1, 'sáu') || w1.nfcLower === '6') return { weekday: 5, consumed: 2 };
    if (vnMatchAny(w1, ['bảy', 'bẩy']) || w1.nfcLower === '7') return { weekday: 6, consumed: 2 };
  }

  // Vietnamese "chủ nhật"
  if (vnMatch(w0, 'chủ') && w1 && spacesOnlyBetween(input, w0.end, w1.start) && vnMatch(w1, 'nhật')) {
    return { weekday: 0, consumed: 2 };
  }

  // Shorthand t2..t7, cn (safe only when not surrounded by non-space word punctuation like slashes)
  const beforeChar = w0.start > 0 ? input[w0.start - 1] : '';
  const afterChar = w0.end < input.length ? input[w0.end] : '';
  if (beforeChar !== '/' && afterChar !== '/') {
    if (w0.nfcLower === 'cn') return { weekday: 0, consumed: 1 };
    const tMatch = /^t([2-7])$/.exec(w0.nfcLower);
    if (tMatch) {
      const n = Number(tMatch[1]);
      return { weekday: n - 1, consumed: 1 };
    }
  }

  // Full English weekdays
  const fullEn: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  if (Object.hasOwn(fullEn, w0.nfcLower)) {
    return { weekday: fullEn[w0.nfcLower] as number, consumed: 1 };
  }

  // Always-safe English abbreviations (do not collide with Vietnamese words)
  const safeShortEn: Record<string, number> = {
    tue: 2,
    tues: 2,
    wed: 3,
    thurs: 4,
    fri: 5,
  };
  if (Object.hasOwn(safeShortEn, w0.nfcLower)) {
    return { weekday: safeShortEn[w0.nfcLower] as number, consumed: 1 };
  }

  // Context-dependent English abbreviations ("mon", "thu", "sat", "sun")
  if (allowShortEnglish) {
    const shortEn: Record<string, number> = { sun: 0, mon: 1, thu: 4, sat: 6 };
    if (Object.hasOwn(shortEn, w0.nfcLower)) {
      return { weekday: shortEn[w0.nfcLower] as number, consumed: 1 };
    }
  }

  return null;
}

function adjustHourForPeriod(hour: number, period: DayPeriod | undefined): number {
  if (!period) return hour;
  if ((period === 'afternoon' || period === 'evening') && hour >= 1 && hour <= 11) return hour + 12;
  // Post-midnight "1h..5h đêm" stays 01:00..05:00 while late-evening "6h..11h đêm" maps to 18:00..23:00 and "12h đêm" is 00:00.
  if (period === 'night' && hour >= 6 && hour <= 11) return hour + 12;
  if (period === 'noon' && hour >= 1 && hour <= 3) return hour + 12;
  if ((period === 'morning' || period === 'evening' || period === 'night') && hour === 12) return 0;
  return hour;
}

function formatHHmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function resolveExplicitMonthDay(today: string, day: number, month: number, explicitYear?: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (explicitYear !== undefined) {
    if (explicitYear < 1970 || explicitYear > 2100) return null;
    const candidate = formatIsoDate(explicitYear, month, day);
    return parseIsoCalendarDate(candidate) ? candidate : null;
  }
  const todayParts = parseIsoCalendarDate(today);
  if (!todayParts) return null;
  // Impossible in every year (e.g. Feb 30, Apr 31)
  if (day > daysInCalendarMonth(2024, month)) return null;
  for (let offset = 0; offset <= 4; offset++) {
    const year = todayParts.year + offset;
    if (day <= daysInCalendarMonth(year, month)) {
      const candidate = formatIsoDate(year, month, day);
      if (candidate >= today) return candidate;
    }
  }
  return null;
}

function expandConnectorBefore(
  input: string,
  words: readonly WordToken[],
  tokenStart: number,
  connectors: readonly (readonly string[])[],
  blockedSpans: readonly Span[],
): number {
  for (const seq of connectors) {
    const n = seq.length;
    for (let i = words.length - 1; i >= 0; i--) {
      const last = words[i];
      if (!last || last.end > tokenStart) continue;
      if (!spacesOnlyBetween(input, last.end, tokenStart)) break;
      const firstIdx = i - (n - 1);
      if (firstIdx < 0) break;
      let ok = true;
      for (let k = 0; k < n; k++) {
        const w = words[firstIdx + k];
        const expected = seq[k] as string;
        if (!w || !vnMatch(w, expected)) {
          ok = false;
          break;
        }
        if (k > 0) {
          const prev = words[firstIdx + k - 1] as WordToken;
          if (!spacesOnlyBetween(input, prev.end, w.start)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const start = (words[firstIdx] as WordToken).start;
        if (!hasOverlap(blockedSpans, { start, end: tokenStart })) return start;
      }
      break;
    }
  }
  return tokenStart;
}

function findAdjacentWordAfter(
  input: string,
  words: readonly WordToken[],
  tokenEnd: number,
  blockedSpans: readonly Span[],
): WordToken | null {
  for (const w of words) {
    if (w.start < tokenEnd) continue;
    if (!spacesOnlyBetween(input, tokenEnd, w.start)) return null;
    if (hasOverlap(blockedSpans, w)) return null;
    return w;
  }
  return null;
}

function findAdjacentWordBefore(
  input: string,
  words: readonly WordToken[],
  tokenStart: number,
  blockedSpans: readonly Span[],
): WordToken | null {
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (!w || w.end > tokenStart) continue;
    if (!spacesOnlyBetween(input, w.end, tokenStart)) return null;
    if (hasOverlap(blockedSpans, w)) return null;
    return w;
  }
  return null;
}

/**
 * Reconstructs a clean title from `input` by removing the specified character `spans` while
 * preserving surrounding non-token punctuation and collapsing excess whitespace.
 */
export function buildTitleWithoutSpans(input: string, spans: readonly Span[]): string {
  if (spans.length === 0) return input.replace(/\s+/g, ' ').trim();
  const sorted = [...spans].sort((a, b) => a.start - b.start);

  // Merge overlapping spans and spans separated only by horizontal spaces, then expand over empty `(...)`.
  const preMerged: Span[] = [];
  for (const s of sorted) {
    const prev = preMerged[preMerged.length - 1];
    if (prev && (s.start <= prev.end || /^[ \t]*$/.test(input.slice(prev.end, s.start)))) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      preMerged.push({ ...s });
    }
  }

  // Expand spans over empty parentheses created solely by stripping inner tokens.
  const expanded = preMerged.map((s) => {
    let start = s.start;
    let end = s.end;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const openParen = /\([ \t]*$/.exec(before);
    const closeParen = /^[ \t]*\)/.exec(after);
    if (openParen && closeParen) {
      start -= openParen[0].length;
      end += closeParen[0].length;
    }
    return { start, end };
  });

  // Merge any overlapping expanded spans
  const merged: Span[] = [];
  for (const s of expanded) {
    const prev = merged[merged.length - 1];
    if (prev && s.start <= prev.end) prev.end = Math.max(prev.end, s.end);
    else merged.push({ ...s });
  }

  let out = '';
  let cursor = 0;
  for (const s of merged) {
    let chunk = input.slice(cursor, s.start);
    const after = input.slice(s.end);
    // If a trailing comma/semicolon sat immediately before a stripped token that precedes another separator or EOF, drop it.
    if (/^[ \t]*(?:[,.;:!?]|$)/.test(after)) {
      chunk = chunk.replace(/(?<![ \t])[ \t]*[,;][ \t]*$/, '');
    }
    if (out.length > 0 && chunk.length > 0 && !/\s$/.test(out) && !/^[\s.,;:!?)\]]/.test(chunk)) {
      out += ' ';
    }
    out += chunk;
    cursor = s.end;
  }
  const tail = input.slice(cursor);
  if (out.length > 0 && tail.length > 0 && !/\s$/.test(out) && !/^[\s.,;:!?)\]]/.test(tail)) {
    out += ' ';
  }
  out += tail;

  // Strip leading orphaned commas/semicolons left behind when a leading token was removed.
  if (merged[0]?.start === 0 || /^[ \t]+$/.test(input.slice(0, merged[0]?.start ?? 0))) {
    out = out.replace(/^[ \t]*[,;][ \t]*/, '');
  }
  out = out.replace(/(?<![ \t])[ \t]+([,.;:!?])(?=$|[\s.,;:!?)\]])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

/**
 * Deterministically parses natural-language Vietnamese (with or without diacritics) and English
 * quick-add input into structured due dates, times, recurrences, priorities, tags, and lists.
 */
export function parseTodoQuickAdd(input: string, opts: TodoQuickAddOptions): TodoQuickAddResult {
  assertValidTimeZone(opts.timeZone);
  const remindBeforeMinutes = Math.max(0, opts.defaultRemindBeforeMinutes ?? DEFAULT_REMIND_BEFORE_MINUTES);
  const nowMs = opts.now.getTime();
  const today = zonedDateString(opts.timeZone, nowMs);

  const dismissedList = opts.dismissedTokens ?? [];
  const dismissedSpans: Span[] = dismissedList.map((t) => ({ start: t.start, end: t.end }));
  const dismissedTimeSpans: Span[] = dismissedList.filter((t) => t.kind === 'time').map((t) => ({ start: t.start, end: t.end }));
  const protectedSpans = findProtectedUrlSpans(input);
  const blockedBase: Span[] = [...protectedSpans, ...dismissedSpans];
  const occupied: Span[] = [...blockedBase];
  const tokens: TodoQuickAddToken[] = [];

  const isAvailable = (span: Span) => !hasOverlap(occupied, span);
  const hasCleanLeftBoundary = (span: Span): boolean => {
    const left = span.start > 0 ? input[span.start - 1] : '';
    if (left === '_') return false;
    if (left === '-' && span.start >= 2 && /[\p{L}\p{N}\p{M}]/u.test(input[span.start - 2] ?? '')) return false;
    if ((left === "'" || left === '\u2019') && span.start >= 2 && /\p{L}/u.test(input[span.start - 2] ?? '')) return false;
    return true;
  };
  const hasCleanRightBoundary = (span: Span): boolean => {
    const right = span.end < input.length ? input[span.end] : '';
    if (right === '_') return false;
    if (right === '-' && span.end + 1 < input.length && /[\p{L}\p{N}\p{M}]/u.test(input[span.end + 1] ?? '')) return false;
    if ((right === "'" || right === '\u2019') && span.end + 1 < input.length && /\p{L}/u.test(input[span.end + 1] ?? '')) {
      return false;
    }
    return true;
  };
  const isWordSpanAvailable = (span: Span): boolean =>
    isAvailable(span) && hasCleanLeftBoundary(span) && hasCleanRightBoundary(span);
  const claimToken = (kind: TodoQuickAddTokenKind, start: number, end: number) => {
    occupied.push({ start, end });
    tokens.push({ kind, raw: input.slice(start, end), start, end });
  };

  // 1. List (/ListName or /"List Name") - run first so #tags or date words inside quoted list names stay protected
  let listName: string | null = null;
  const listMatches: Array<{ start: number; end: number; name: string }> = [];
  for (const m of input.matchAll(LIST_QUOTED_RE)) {
    const name = (m[1] ?? '').trim();
    if (name) listMatches.push({ start: m.index, end: m.index + m[0].length, name });
  }
  for (const m of input.matchAll(LIST_UNQUOTED_RE)) {
    const name = (m[1] ?? '').trim();
    if (name) listMatches.push({ start: m.index, end: m.index + m[0].length, name });
  }
  listMatches.sort((a, b) => a.start - b.start);
  for (const lm of listMatches) {
    if (!isAvailable(lm)) continue;
    listName = lm.name;
    claimToken('list', lm.start, lm.end);
    break;
  }

  // 2. Priority (!p1.. !p4)
  let priority: 1 | 2 | 3 | 4 | null = null;
  for (const m of input.matchAll(PRIORITY_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isAvailable({ start, end })) continue;
    priority = Number(m[1]) as 1 | 2 | 3 | 4;
    claimToken('priority', start, end);
    break;
  }

  // 3. Tags (#tag)
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const m of input.matchAll(TAG_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isAvailable({ start, end })) continue;
    const tag = (m[1] ?? '').normalize('NFC').toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag && !seenTags.has(tag) && tags.length < MAX_TAGS) {
      seenTags.add(tag);
      tags.push(tag);
    }
    claimToken('tag', start, end);
  }

  const words = tokenizeWords(input);
  const matchPeriodWord = (word: WordToken, allowEnglishShort = false): DayPeriod | null =>
    matchDayPeriod(word, allowEnglishShort, wordBefore(words, word), input, wordAfter(words, word));

  // Collect raw explicit clock candidates early so Step 4a can distinguish "cuối tháng 14:30" / "cuối tháng 9 giờ" from "cuối tháng 12".
  const timeCandidates: Array<{
    start: number;
    end: number;
    hour: number;
    minute: number;
    hasAmPm: boolean;
    usesShortG?: boolean | undefined;
    hasMinutesOrHalf?: boolean | undefined;
  }> = [];

  for (const m of input.matchAll(CLOCK_COLON_RE)) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 0 && hour <= 23) {
      timeCandidates.push({ start: m.index, end: m.index + m[0].length, hour, minute, hasAmPm: false });
    }
  }
  for (const m of input.matchAll(CLOCK_AMPM_RE)) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const ampm = (m[3] ?? '').toLowerCase();
    if (hour < 1 || hour > 12) continue;
    const converted = ampm.startsWith('a') ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
    timeCandidates.push({ start: m.index, end: m.index + m[0].length, hour: converted, minute, hasAmPm: true });
  }
  const isTrailingCountOrTemporalUnit = (endPos: number): boolean => {
    const after = input.slice(endPos).match(/^[ \t]*([\p{L}\p{N}\p{M}]+)(?:[ \t]+([\p{L}\p{N}\p{M}]+))?/u);
    if (!after) return false;
    const next1 = foldVn(after[1] ?? '');
    const next2 = after[2] ? foldVn(after[2]) : '';
    if (VN_COUNT_NOUNS_AFTER_CLOCK.has(next1) || TEMPORAL_UNITS_AFTER_CLOCK.has(next1)) return true;
    return next1 === 'ngay' && (next2 === 'nua' || next2 === 'toi');
  };

  for (const m of input.matchAll(CLOCK_VN_GIO_RE)) {
    const hour = Number(m[2]);
    if (hour < 0 || hour > 23) continue;
    const gioEnd = m.index + (m[1] ?? '').length;
    const withUnitMinutes = m[3];
    const bareTwoDigitMinutes = m[4];
    const half = m[5] !== undefined;
    let end = m.index + m[0].length;
    let minute = 0;
    if (half) {
      minute = 30;
    } else if (withUnitMinutes !== undefined) {
      minute = Number(withUnitMinutes);
    } else if (bareTwoDigitMinutes !== undefined) {
      if (isTrailingCountOrTemporalUnit(end)) {
        end = gioEnd;
        minute = 0;
      } else {
        minute = Number(bareTwoDigitMinutes);
      }
    }
    if (minute < 0 || minute > 59) continue;
    timeCandidates.push({ start: m.index, end, hour, minute, hasAmPm: false });
  }
  for (const m of input.matchAll(CLOCK_VN_SHORT_RE)) {
    const hour = Number(m[2]);
    if (hour < 0 || hour > 23) continue;
    const shortEnd = m.index + (m[1] ?? '').length;
    const unit = (m[3] ?? '').toLowerCase();
    const tightOrUnitDigits = m[4] ?? m[5];
    const bareSpacedMinutes = m[6];
    const half = m[7] !== undefined;
    let end = m.index + m[0].length;
    let minute = 0;
    let hasMinutesOrHalf = tightOrUnitDigits !== undefined || half;
    if (half) {
      minute = 30;
    } else if (tightOrUnitDigits !== undefined) {
      minute = Number(tightOrUnitDigits);
    } else if (bareSpacedMinutes !== undefined) {
      if (isTrailingCountOrTemporalUnit(end)) {
        end = shortEnd;
        minute = 0;
      } else {
        minute = Number(bareSpacedMinutes);
        hasMinutesOrHalf = true;
      }
    }
    if (minute < 0 || minute > 59) continue;
    timeCandidates.push({
      start: m.index,
      end,
      hour,
      minute,
      hasAmPm: false,
      usesShortG: unit === 'g',
      hasMinutesOrHalf,
    });
  }

  timeCandidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const dedupedTimeCandidates: typeof timeCandidates = [];
  for (const cand of timeCandidates) {
    const prev = dedupedTimeCandidates[dedupedTimeCandidates.length - 1];
    if (prev && cand.start < prev.end) continue;
    dedupedTimeCandidates.push(cand);
  }
  const dedupedTimeCandidateByStart = new Map(dedupedTimeCandidates.map((cand) => [cand.start, cand]));
  const startsClockAt = (pos: number): boolean => {
    const tc = dedupedTimeCandidateByStart.get(pos);
    if (!tc) return false;
    if (!tc.usesShortG || tc.hasMinutesOrHalf) return true;
    const afterWord = findAdjacentWordAfter(input, words, tc.end, occupied);
    return Boolean(afterWord && matchPeriodWord(afterWord, false));
  };

  // 4. Recurrence phrases (evaluated before dates/weekdays so "hàng tuần thứ hai" and "ngày 20 hàng tháng" stay unified)
  const recurrenceState: { rule: TodoQuickAddRecurrence | null; derivedDueOn: string | null } = {
    rule: null,
    derivedDueOn: null,
  };
  const recordRecurrence = (rule: TodoQuickAddRecurrence, derivedDue: string, start: number, end: number) => {
    occupied.push({ start, end });
    // Only the first recurrence rule is saved/tokenized; secondary rules stay occupied so trailing weekdays don't leak into Step 7.
    if (recurrenceState.rule === null) {
      recurrenceState.rule = rule;
      recurrenceState.derivedDueOn = derivedDue;
      tokens.push({ kind: 'recurrence', raw: input.slice(start, end), start, end });
    }
  };

  const extendMultiWeekdayEndIdx = (afterWdIdx: number, allowShortEn: boolean): number | null => {
    let curEndIdx = afterWdIdx;
    let foundMore = false;
    while (curEndIdx + 1 < words.length) {
      const curWord = words[curEndIdx];
      const nextWord = words[curEndIdx + 1];
      if (!curWord || !nextWord) break;
      const gap = input.slice(curWord.end, nextWord.start);
      let wdStartIdx = curEndIdx + 1;
      if (!/^[ \t]*[,&/][ \t]*$/u.test(gap)) {
        if (
          /^[ \t]+$/u.test(gap) &&
          (vnMatchAny(nextWord, ['và', 'với', 'cùng', 'hoặc']) ||
            nextWord.nfcLower === 'and' ||
            nextWord.nfcLower === 'or') &&
          curEndIdx + 2 < words.length &&
          spacesOnlyBetween(input, nextWord.end, (words[curEndIdx + 2] as WordToken).start)
        ) {
          wdStartIdx = curEndIdx + 2;
        } else {
          break;
        }
      }
      const extraWd = matchWeekday(input, words, wdStartIdx, allowShortEn);
      if (!extraWd) break;
      const extraEndIdx = wdStartIdx + extraWd.consumed - 1;
      const extraSpan = {
        start: (words[wdStartIdx] as WordToken).start,
        end: (words[extraEndIdx] as WordToken).end,
      };
      if (!isWordSpanAvailable(extraSpan)) break;
      curEndIdx = extraEndIdx;
      foundMore = true;
    }
    return foundMore ? curEndIdx : null;
  };

  const prependMultiWeekdayStart = (beforeStartIdx: number, allowShortEn: boolean): number | null => {
    let curStartIdx = beforeStartIdx;
    let foundMore = false;
    while (curStartIdx >= 1) {
      const prevWord = words[curStartIdx - 1];
      const curStartWord = words[curStartIdx];
      if (!prevWord || !curStartWord) break;
      const gap = input.slice(prevWord.end, curStartWord.start);
      let wdEndIdx = curStartIdx - 1;
      if (!/^[ \t]*[,&/][ \t]*$/u.test(gap)) {
        if (
          /^[ \t]+$/u.test(gap) &&
          (vnMatchAny(prevWord, ['và', 'với', 'cùng', 'hoặc']) ||
            prevWord.nfcLower === 'and' ||
            prevWord.nfcLower === 'or') &&
          curStartIdx >= 2 &&
          spacesOnlyBetween(input, (words[curStartIdx - 2] as WordToken).end, prevWord.start)
        ) {
          wdEndIdx = curStartIdx - 2;
        } else {
          break;
        }
      }
      const twoWd = wdEndIdx >= 1 ? matchWeekday(input, words, wdEndIdx - 1, allowShortEn) : null;
      const oneWd = matchWeekday(input, words, wdEndIdx, allowShortEn);
      const wdStartIdx = twoWd && twoWd.consumed === 2 ? wdEndIdx - 1 : oneWd && oneWd.consumed === 1 ? wdEndIdx : -1;
      if (wdStartIdx < 0) break;
      const extraSpan = {
        start: (words[wdStartIdx] as WordToken).start,
        end: (words[wdEndIdx] as WordToken).end,
      };
      if (!isWordSpanAvailable(extraSpan)) break;
      curStartIdx = wdStartIdx;
      foundMore = true;
    }
    return foundMore ? (words[curStartIdx] as WordToken).start : null;
  };

  // Preserves multi-weekday lists ("every Monday and Wednesday") intact without saving a misleading single-weekday rule.
  const claimWeeklyWeekdayPhrase = (
    spanStart: number,
    phraseEndIdx: number,
    weekday: number,
    allowShortEn: boolean,
    checkLeadingStartIdx?: number,
  ): number | null => {
    const baseEnd = (words[phraseEndIdx] as WordToken).end;
    if (!isWordSpanAvailable({ start: spanStart, end: baseEnd })) return null;
    const multiEndIdx = extendMultiWeekdayEndIdx(phraseEndIdx, allowShortEn);
    const multiStart =
      checkLeadingStartIdx !== undefined ? prependMultiWeekdayStart(checkLeadingStartIdx, allowShortEn) : null;
    if (multiEndIdx !== null || multiStart !== null) {
      const start = multiStart ?? spanStart;
      const finalEndIdx = multiEndIdx ?? phraseEndIdx;
      occupied.push({ start, end: (words[finalEndIdx] as WordToken).end });
      return finalEndIdx;
    }
    recordRecurrence(
      { freq: 'weekly', interval: 1, byWeekday: weekday },
      nextOccurrenceOfWeekday(today, weekday, true),
      spanStart,
      baseEnd,
    );
    return phraseEndIdx;
  };

  for (let i = 0; i < words.length; i++) {
    const w0 = words[i];
    if (!w0 || !isWordSpanAvailable(w0)) continue;

    // Helper to check a contiguous sequence of words at i
    const spanOf = (endIdx: number): Span => ({ start: w0.start, end: (words[endIdx] as WordToken).end });
    const isWordPhraseEndAvailable = (span: Span): boolean => isWordSpanAvailable(span);
    const contiguous = (fromIdx: number, toIdx: number): boolean => {
      for (let k = fromIdx; k < toIdx; k++) {
        const a = words[k];
        const b = words[k + 1];
        if (!a || !b || !spacesOnlyBetween(input, a.end, b.start)) return false;
      }
      return true;
    };

    const w1 = words[i + 1];
    const w2 = words[i + 2];
    const w3 = words[i + 3];
    const w4 = words[i + 4];

    const hasMonthModifierAfter = (endIdx: number): boolean => {
      const lastW = words[endIdx];
      const nextW = words[endIdx + 1];
      if (!lastW || !nextW || !spacesOnlyBetween(input, lastW.end, nextW.start)) return false;
      if (vnMatchAny(nextW, ['này', 'sau', 'tới', 'trước', 'qua'])) return true;
      if (!vnMatch(lastW, 'tháng') || !/^\d{1,2}$/.test(nextW.nfcLower)) return false;
      const monthNum = Number(nextW.nfcLower);
      if (monthNum < 1 || monthNum > 12) return false;
      if (startsClockAt(nextW.start) || /^[/:]/.test(input.slice(nextW.end))) return false;
      return true;
    };

    const isHangCargoWord = (idx: number): boolean => {
      const tok = words[idx];
      const prev = words[idx - 1];
      if (!tok || !prev || !contiguous(idx - 1, idx)) return false;
      const isHangForm = tok.nfcLower === 'hàng' || (tok.isAscii && tok.nfcLower === 'hang');
      if (!isHangForm) return false;
      return HANG_CARGO_FOLDED_MODIFIERS.has(prev.folded) || HANG_CARGO_EXACT_MODIFIERS.has(prev.nfcLower);
    };

    const unitStartsDatePhrase = (unitIdx: number): boolean => {
      const unitW = words[unitIdx];
      const nextW = words[unitIdx + 1];
      if (!unitW || !nextW || !contiguous(unitIdx, unitIdx + 1)) return false;
      if (vnMatch(unitW, 'ngày')) {
        if (vnMatchAny(nextW, ['mai', 'kia', 'mốt', 'nay', 'hôm', 'cuối'])) return true;
        if (/^\d{1,2}$/.test(nextW.nfcLower) && (!startsClockAt(nextW.start) || /^[/:]/.test(input.slice(nextW.end)))) {
          return true;
        }
        return matchWeekday(input, words, unitIdx + 1, false) !== null;
      }
      if (vnMatch(unitW, 'tuần')) {
        return vnMatchAny(nextW, ['này', 'sau', 'tới', 'trước', 'qua']);
      }
      if (vnMatch(unitW, 'tháng')) {
        return hasMonthModifierAfter(unitIdx);
      }
      return false;
    };

    // 4a. "cuối tháng" / "ngày cuối tháng" / "cuối mỗi tháng" / "cuối tháng hàng tháng" / "last day of [every|the] month"
    if (
      w1 &&
      w2 &&
      w3 &&
      contiguous(i, i + 3) &&
      ((vnMatch(w0, 'cuối') && vnMatch(w1, 'tháng') && vnMatchAny(w2, ['hàng', 'hằng', 'mỗi']) && vnMatch(w3, 'tháng')) ||
        (w0.nfcLower === 'last' && w1.nfcLower === 'day' && w2.nfcLower === 'of' && w3.nfcLower === 'month')) &&
      !hasMonthModifierAfter(i + 3)
    ) {
      const span = spanOf(i + 3);
      if (isWordPhraseEndAvailable(span)) {
        recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: -1 }, nextMonthDayDate(today, -1), span.start, span.end);
        i += 3;
        continue;
      }
    }
    if (
      w1 &&
      w2 &&
      w3 &&
      w4 &&
      contiguous(i, i + 4) &&
      w0.nfcLower === 'last' &&
      w1.nfcLower === 'day' &&
      w2.nfcLower === 'of' &&
      (w3.nfcLower === 'every' || w3.nfcLower === 'the') &&
      w4.nfcLower === 'month' &&
      !hasMonthModifierAfter(i + 4)
    ) {
      const span = spanOf(i + 4);
      if (isWordPhraseEndAvailable(span)) {
        recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: -1 }, nextMonthDayDate(today, -1), span.start, span.end);
        i += 4;
        continue;
      }
    }
    if (
      w1 &&
      w2 &&
      contiguous(i, i + 2) &&
      ((vnMatch(w0, 'ngày') && vnMatch(w1, 'cuối') && vnMatch(w2, 'tháng')) ||
        (vnMatch(w0, 'cuối') && vnMatchAny(w1, ['mỗi', 'hàng', 'hằng']) && vnMatch(w2, 'tháng')) ||
        (w0.nfcLower === 'end' && w1.nfcLower === 'of' && w2.nfcLower === 'month')) &&
      !hasMonthModifierAfter(i + 2)
    ) {
      const span = spanOf(i + 2);
      if (isWordPhraseEndAvailable(span)) {
        const start = expandConnectorBefore(input, words, span.start, [['vào']], occupied);
        recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: -1 }, nextMonthDayDate(today, -1), start, span.end);
        i += 2;
        continue;
      }
    }
    if (w1 && contiguous(i, i + 1) && vnMatch(w0, 'cuối') && vnMatch(w1, 'tháng') && !hasMonthModifierAfter(i + 1)) {
      const span = spanOf(i + 1);
      if (isWordPhraseEndAvailable(span)) {
        const start = expandConnectorBefore(input, words, span.start, [['vào']], occupied);
        recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: -1 }, nextMonthDayDate(today, -1), start, span.end);
        i += 1;
        continue;
      }
    }

    // 4b. "ngày <d> hàng tháng" / "day <d> every month" / "every month on day <d>"
    if (
      w1 &&
      w2 &&
      w3 &&
      w4 &&
      contiguous(i, i + 4) &&
      w0.nfcLower === 'every' &&
      w1.nfcLower === 'month' &&
      w2.nfcLower === 'on' &&
      w3.nfcLower === 'day' &&
      /^\d{1,2}$/.test(w4.nfcLower)
    ) {
      const d = Number(w4.nfcLower);
      if (d >= 1 && d <= 31) {
        const span = spanOf(i + 4);
        if (isWordPhraseEndAvailable(span)) {
          recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: d }, nextMonthDayDate(today, d), span.start, span.end);
          i += 4;
          continue;
        }
      }
    }
    if (
      w1 &&
      w2 &&
      w3 &&
      contiguous(i, i + 3) &&
      ((vnMatch(w0, 'ngày') && /^\d{1,2}$/.test(w1.nfcLower) && vnMatchAny(w2, ['hàng', 'hằng', 'mỗi']) && vnMatch(w3, 'tháng')) ||
        (w0.nfcLower === 'day' && /^\d{1,2}$/.test(w1.nfcLower) && w2.nfcLower === 'every' && w3.nfcLower === 'month'))
    ) {
      const d = Number(w1.nfcLower);
      if (d >= 1 && d <= 31) {
        const span = spanOf(i + 3);
        if (isWordPhraseEndAvailable(span)) {
          const start = expandConnectorBefore(input, words, span.start, [['vào']], occupied);
          recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: d }, nextMonthDayDate(today, d), start, span.end);
          i += 3;
          continue;
        }
      }
    }
    if (
      w1 &&
      w2 &&
      w3 &&
      contiguous(i, i + 3) &&
      !isHangCargoWord(i) &&
      vnMatchAny(w0, ['hàng', 'hằng', 'mỗi']) &&
      vnMatch(w1, 'tháng') &&
      vnMatch(w2, 'ngày') &&
      /^\d{1,2}$/.test(w3.nfcLower)
    ) {
      const d = Number(w3.nfcLower);
      if (d >= 1 && d <= 31) {
        const span = spanOf(i + 3);
        if (isWordPhraseEndAvailable(span)) {
          recordRecurrence({ freq: 'monthly', interval: 1, byMonthDay: d }, nextMonthDayDate(today, d), span.start, span.end);
          i += 3;
          continue;
        }
      }
    }

    // 4c. "hàng tuần [vào] <weekday>" / "mỗi tuần [vào] <weekday>" / "every week [on] <weekday>" / "every <weekday>" / "<weekday> hàng tuần"
    if (!isHangCargoWord(i) && vnMatchAny(w0, ['mỗi', 'hàng', 'hằng']) && w1 && contiguous(i, i + 1) && vnMatch(w1, 'tuần') && !unitStartsDatePhrase(i + 1)) {
      let afterWeekIdx = i + 2;
      const connWord = words[afterWeekIdx];
      if (connWord && vnMatch(connWord, 'vào') && contiguous(i + 1, afterWeekIdx)) afterWeekIdx += 1;
      const wd = afterWeekIdx < words.length && contiguous(i + 1, afterWeekIdx) ? matchWeekday(input, words, afterWeekIdx, false) : null;
      const endIdx = wd ? afterWeekIdx + wd.consumed - 1 : i + 1;
      if (wd) {
        const consumedTo = claimWeeklyWeekdayPhrase(w0.start, endIdx, wd.weekday, false);
        if (consumedTo !== null) {
          i = consumedTo;
          continue;
        }
      } else {
        const span = spanOf(endIdx);
        if (isWordPhraseEndAvailable(span)) {
          recordRecurrence({ freq: 'weekly', interval: 1 }, today, span.start, span.end);
          i = endIdx;
          continue;
        }
      }
    }
    if (w0.nfcLower === 'every' && w1 && contiguous(i, i + 1) && w1.nfcLower === 'week') {
      let afterWeekIdx = i + 2;
      if (words[afterWeekIdx]?.nfcLower === 'on' && contiguous(i + 1, afterWeekIdx)) afterWeekIdx += 1;
      const wd = afterWeekIdx < words.length && contiguous(i + 1, afterWeekIdx) ? matchWeekday(input, words, afterWeekIdx, true) : null;
      const endIdx = wd ? afterWeekIdx + wd.consumed - 1 : i + 1;
      if (wd) {
        const consumedTo = claimWeeklyWeekdayPhrase(w0.start, endIdx, wd.weekday, true);
        if (consumedTo !== null) {
          i = consumedTo;
          continue;
        }
      } else {
        const span = spanOf(endIdx);
        if (isWordPhraseEndAvailable(span)) {
          recordRecurrence({ freq: 'weekly', interval: 1 }, today, span.start, span.end);
          i = endIdx;
          continue;
        }
      }
    }
    if ((!isHangCargoWord(i) && vnMatchAny(w0, ['mỗi', 'hàng', 'hằng'])) || w0.nfcLower === 'every') {
      const allowShort = w0.nfcLower === 'every';
      const wd = w1 && contiguous(i, i + 1) ? matchWeekday(input, words, i + 1, allowShort) : null;
      if (wd) {
        const consumedTo = claimWeeklyWeekdayPhrase(w0.start, i + wd.consumed, wd.weekday, allowShort);
        if (consumedTo !== null) {
          i = consumedTo;
          continue;
        }
      }
    }

    // "<weekday> hàng tuần" / "<weekday> every week"
    const leadingWd = matchWeekday(input, words, i, false);
    if (leadingWd) {
      const afterIdx = i + leadingWd.consumed;
      const a0 = words[afterIdx];
      const a1 = words[afterIdx + 1];
      if (
        a0 &&
        a1 &&
        contiguous(i, afterIdx + 1) &&
        ((vnMatchAny(a0, ['mỗi', 'hàng', 'hằng']) && vnMatch(a1, 'tuần')) || (a0.nfcLower === 'every' && a1.nfcLower === 'week'))
      ) {
        const consumedTo = claimWeeklyWeekdayPhrase(
          w0.start,
          afterIdx + 1,
          leadingWd.weekday,
          a0.nfcLower === 'every',
          i,
        );
        if (consumedTo !== null) {
          i = consumedTo;
          continue;
        }
      }
    }

    // 4d. Intervals: "mỗi <N> ngày|tuần|tháng" / "every <N> days|weeks|months"
    if ((vnMatch(w0, 'mỗi') || w0.nfcLower === 'every') && w1 && w2 && contiguous(i, i + 2) && /^\d{1,3}$/.test(w1.nfcLower)) {
      const interval = Number(w1.nfcLower);
      if (interval >= 1 && interval <= MAX_INTERVAL) {
        const freq: 'daily' | 'weekly' | 'monthly' | null =
          vnMatch(w2, 'ngày') || w2.nfcLower === 'day' || w2.nfcLower === 'days'
            ? 'daily'
            : vnMatch(w2, 'tuần') || w2.nfcLower === 'week' || w2.nfcLower === 'weeks'
              ? 'weekly'
              : vnMatch(w2, 'tháng') || w2.nfcLower === 'month' || w2.nfcLower === 'months'
                ? 'monthly'
                : null;
        if (freq) {
          const span = spanOf(i + 2);
          if (isWordPhraseEndAvailable(span)) {
            recordRecurrence({ freq, interval }, today, span.start, span.end);
            i += 2;
            continue;
          }
        }
      }
    }

    // 4e. Simple daily / monthly / weekly
    if (
      w1 &&
      contiguous(i, i + 1) &&
      ((!isHangCargoWord(i) && vnMatchAny(w0, ['mỗi', 'hàng', 'hằng']) && vnMatch(w1, 'ngày') && !unitStartsDatePhrase(i + 1)) ||
        (w0.nfcLower === 'every' && w1.nfcLower === 'day'))
    ) {
      const span = spanOf(i + 1);
      if (isWordPhraseEndAvailable(span)) {
        recordRecurrence({ freq: 'daily', interval: 1 }, today, span.start, span.end);
        i += 1;
        continue;
      }
    }
    if (
      w1 &&
      contiguous(i, i + 1) &&
      ((!isHangCargoWord(i) && vnMatchAny(w0, ['mỗi', 'hàng', 'hằng']) && vnMatch(w1, 'tháng') && !unitStartsDatePhrase(i + 1)) ||
        (w0.nfcLower === 'every' && w1.nfcLower === 'month'))
    ) {
      const span = spanOf(i + 1);
      if (isWordPhraseEndAvailable(span)) {
        recordRecurrence({ freq: 'monthly', interval: 1 }, today, span.start, span.end);
        i += 1;
        continue;
      }
    }
    if (w0.nfcLower === 'weekly' && w1?.nfcLower === 'on' && w2 && contiguous(i, i + 2) && isWordPhraseEndAvailable(w0)) {
      const wd = matchWeekday(input, words, i + 2, true);
      if (wd) {
        const endIdx = i + 1 + wd.consumed;
        const consumedTo = claimWeeklyWeekdayPhrase(w0.start, endIdx, wd.weekday, true);
        if (consumedTo !== null) {
          i = consumedTo;
          continue;
        }
      }
    }
  }

  // 5. Explicit numeric dates (yyyy-mm-dd, dd/mm/yyyy, dd/mm)
  let explicitDueOn: string | null = null;
  let explicitTodaySpecified = false;
  const dateSpans: Span[] = [];
  const numericDateCandidates: Array<{ start: number; end: number; dueOn: string }> = [];

  for (const m of input.matchAll(ISO_DATE_TOKEN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isAvailable({ start, end })) continue;
    const candidate = formatIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!parseIsoCalendarDate(candidate)) continue;
    numericDateCandidates.push({ start, end, dueOn: candidate });
  }

  for (const m of input.matchAll(DMY_DATE_TOKEN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isAvailable({ start, end })) continue;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? Number(m[3]) : undefined;
    const prevWord = findAdjacentWordBefore(input, words, start, occupied);
    const hasExplicitDateIntroducer =
      prevWord !== null && (vnMatchAny(prevWord, ['ngày', 'từ', 'đến', 'trước', 'sau']) || prevWord.nfcLower === 'on');
    if (year === undefined && !hasExplicitDateIntroducer) {
      if (/^[ \t]*[%‰]/.test(input.slice(end))) continue;
      const nextWord = findAdjacentWordAfter(input, words, end, occupied);
      if (nextWord) {
        if (DMY_UNAMBIGUOUS_UNITS.has(nextWord.folded)) continue;
        if (day < month && DMY_FRACTION_NOUNS.has(nextWord.folded)) continue;
      }
    }
    const resolved = resolveExplicitMonthDay(today, day, month, year);
    if (!resolved) continue;
    numericDateCandidates.push({ start, end, dueOn: resolved });
  }

  numericDateCandidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const isMultiDateConnector = (leftEnd: number, rightStart: number): boolean => {
    if (rightStart < leftEnd) return false;
    const foldedBetween = foldVn(input.slice(leftEnd, rightStart)).replace(/\s+/g, ' ').trim();
    return /^(?:-|\u2013|\u2014|&|to|till|until|and|or|den|toi|va|hoac|hay|->|~)(?:\s+(?:(?:vao\s+)?ngay|on))?$/u.test(
      foldedBetween,
    );
  };

  let parsedTime: ParsedTimeInfo | null = null;
  const timeSpans: Span[] = [];
  const englishTimeSpans: Span[] = [];
  let hasExplicitClockRange = false;
  let contextPeriod: DayPeriod | undefined;
  const timeTokenDismissed = (opts.dismissedTokens ?? []).some((t) => t.kind === 'time');
  let suppressDefaultPeriodTime = timeTokenDismissed;

  const isDurationClock = (
    cand: { start: number; end: number; hour: number; hasAmPm: boolean },
    period: DayPeriod | undefined,
  ): boolean => {
    const afterWord = findAdjacentWordAfter(input, words, cand.end, occupied);
    if (afterWord && (vnMatch(afterWord, 'nữa') || afterWord.nfcLower === 'later')) return true;

    const prevWord = findAdjacentWordBefore(input, words, cand.start, occupied);
    if (!prevWord) return false;
    if (vnMatchAny(prevWord, ['trong', 'mất', 'tốn', 'hết', 'suốt'])) return true;
    if (prevWord.nfcLower === 'in' || prevWord.nfcLower === 'for' || prevWord.nfcLower === 'within') return true;
    const prevPrev = wordBefore(words, prevWord);
    if (vnMatch(prevWord, 'dài') && prevPrev && vnMatch(prevPrev, 'kéo')) return true;
    const candSlice = input.slice(cand.start, cand.end);
    const hasColon = candSlice.includes(':');
    if (prevWord.nfcLower === 'after') {
      if (!period && !cand.hasAmPm && !hasColon && cand.hour >= 1 && cand.hour <= 12) return true;
    }
    if (vnMatch(prevWord, 'sau')) {
      if (prevPrev && vnMatchAny(prevPrev, ['tuần', 'ngày', 'hôm', 'tháng', 'năm'])) return false;
      const usesGioWord = /(?:giờ|gio|giơ|o\u031b)/iu.test(candSlice);
      if (!period && !cand.hasAmPm && !hasColon && (usesGioWord || (cand.hour >= 1 && cand.hour <= 12))) return true;
    }
    return false;
  };

  const isRangeBetweenClocks = (leftEnd: number, rightStart: number): boolean => {
    if (rightStart < leftEnd) return false;
    const foldedBetween = foldVn(input.slice(leftEnd, rightStart)).trim();
    return /^(?:-|\u2013|\u2014|to|till|until|den|toi|->|~)$/u.test(foldedBetween);
  };

  const afterClockPeriodOk = (w: WordToken): boolean =>
    isWordSpanAvailable(w) ||
    (isAvailable(w) && hasCleanLeftBoundary(w) && /^(?:-|\u2013|\u2014|->|~)\s*\d/u.test(input.slice(w.end)));

  const beforeClockPeriodOk = (w: WordToken): boolean =>
    isWordSpanAvailable(w) ||
    (isAvailable(w) && hasCleanRightBoundary(w) && /\d\s*(?:-|\u2013|\u2014|->|~)$/u.test(input.slice(0, w.start)));

  const resolveClockPeriod = (
    tc: (typeof dedupedTimeCandidates)[number],
  ): { start: number; end: number; period: DayPeriod | undefined; shortGBlocked: boolean } => {
    let start = tc.start;
    let end = tc.end;
    let period: DayPeriod | undefined;
    if (!tc.hasAmPm) {
      const afterWord = findAdjacentWordAfter(input, words, end, occupied);
      const afterPeriod = afterWord && afterClockPeriodOk(afterWord) ? matchPeriodWord(afterWord, false) : null;
      if (afterWord && afterPeriod) {
        period = afterPeriod;
        end = afterWord.end;
      } else {
        const beforeWord = findAdjacentWordBefore(input, words, start, occupied);
        const beforePeriod = beforeWord && beforeClockPeriodOk(beforeWord) ? matchPeriodWord(beforeWord, false) : null;
        if (beforeWord && beforePeriod) {
          period = beforePeriod;
          start = beforeWord.start;
        }
      }
    }
    // Require "g" (easily confused with grams "20 g bột" or 5G) to have minutes/rưỡi, a day period, or lúc/vào.
    let shortGBlocked = false;
    if (tc.usesShortG && !tc.hasMinutesOrHalf && !period) {
      const beforeClock = findAdjacentWordBefore(input, words, start, occupied);
      if (!beforeClock || !isWordSpanAvailable(beforeClock) || !vnMatchAny(beforeClock, ['lúc', 'vào'])) {
        shortGBlocked = true;
      }
    }
    return { start, end, period, shortGBlocked };
  };

  const hasHalfUnitRangeBefore = (candStart: number): boolean => {
    const prefixBefore = input.slice(0, candStart);
    const dashMatch = /(?:^|[\s([,])(\d{1,2})\s*(?:-|\u2013|\u2014|->|~)\s*$/u.exec(prefixBefore);
    if (dashMatch && Number(dashMatch[1]) <= 23) return true;
    const conn = findAdjacentWordBefore(input, words, candStart, occupied);
    if (conn && (vnMatchAny(conn, ['đến', 'tới']) || conn.nfcLower === 'to' || conn.nfcLower === 'till' || conn.nfcLower === 'until')) {
      const startHourWord = findAdjacentWordBefore(input, words, conn.start, occupied);
      if (
        startHourWord &&
        isWordSpanAvailable(startHourWord) &&
        /^\d{1,2}$/.test(startHourWord.nfcLower) &&
        Number(startHourWord.nfcLower) <= 23 &&
        (startHourWord.start === 0 || (input[startHourWord.start - 1] !== '/' && input[startHourWord.start - 1] !== ':'))
      ) {
        return true;
      }
    }
    return false;
  };

  const hasHalfUnitRangeAfter = (candEnd: number): boolean => {
    const isBlockedAfterRangeNum = (numEnd: number): boolean => {
      const nextWord = findAdjacentWordAfter(input, words, numEnd, occupied);
      if (!nextWord) return false;
      if (VN_COUNT_NOUNS_AFTER_CLOCK.has(nextWord.folded) || TEMPORAL_UNITS_AFTER_CLOCK.has(nextWord.folded)) {
        return true;
      }
      if (vnMatch(nextWord, 'ngày')) {
        const afterDateWord = findAdjacentWordAfter(input, words, nextWord.end, occupied);
        // "ngày mai/kia/mốt" is an adjacent VN date phrase ("11 ngày mai"), not "<N> ngày nữa" ("2 ngày nữa").
        if (!afterDateWord || !vnMatchAny(afterDateWord, ['mai', 'kia', 'mốt'])) return true;
      }
      return false;
    };

    const suffix = input.slice(candEnd);
    const dashMatch = /^\s*(?:-|\u2013|\u2014|->|~)\s*(\d{1,2})(?=$|[\s.,;:!?)\]])/u.exec(suffix);
    if (dashMatch && Number(dashMatch[1]) <= 23) {
      const numText = dashMatch[1] ?? '';
      const numStart = candEnd + dashMatch[0].length - numText.length;
      const numSpan = { start: numStart, end: numStart + numText.length };
      if (!isAvailable(numSpan) || !hasCleanRightBoundary(numSpan)) return false;
      if (isBlockedAfterRangeNum(numSpan.end)) return false;
      return true;
    }
    const conn = findAdjacentWordAfter(input, words, candEnd, occupied);
    if (conn && (vnMatchAny(conn, ['đến', 'tới']) || conn.nfcLower === 'to' || conn.nfcLower === 'till' || conn.nfcLower === 'until')) {
      const endHourWord = findAdjacentWordAfter(input, words, conn.end, occupied);
      if (
        endHourWord &&
        isWordSpanAvailable(endHourWord) &&
        /^\d{1,2}$/.test(endHourWord.nfcLower) &&
        Number(endHourWord.nfcLower) <= 23
      ) {
        const afterChar = endHourWord.end < input.length ? input[endHourWord.end] : '';
        if (afterChar === '/' || afterChar === ':' || afterChar === '.') return false;
        if (isBlockedAfterRangeNum(endHourWord.end)) return false;
        return true;
      }
    }
    return false;
  };

  interface DateCandidate {
    start: number;
    end: number;
    prefixStart: number;
    apply: () => void;
  }

  const collectDateCandidates = (enTimeSpans: Span[]): DateCandidate[] => {
    const dateCandidates: DateCandidate[] = [];

  for (const dc of numericDateCandidates) {
    if (!isAvailable(dc)) continue;
    const prefixStart = expandConnectorBefore(input, words, dc.start, [['vào', 'ngày'], ['ngày'], ['on']], occupied);
    dateCandidates.push({
      start: dc.start,
      end: dc.end,
      prefixStart,
      apply: () => {
        explicitDueOn = dc.dueOn;
        explicitTodaySpecified = dc.dueOn === today;
        claimToken('date', prefixStart, dc.end);
        dateSpans.push({ start: prefixStart, end: dc.end });
      },
    });
  }

  for (let i = 0; i < words.length; i++) {
    const w0 = words[i];
    if (!w0 || !isWordSpanAvailable(w0)) continue;

    const contiguous = (fromIdx: number, toIdx: number): boolean => {
      for (let k = fromIdx; k < toIdx; k++) {
        const a = words[k];
        const b = words[k + 1];
        if (!a || !b || !spacesOnlyBetween(input, a.end, b.start)) return false;
      }
      return true;
    };

    const w1 = words[i + 1];
    const w2 = words[i + 2];

    const queueDateRange = (startIdx: number, endIdx: number, dateValue: string, isToday: boolean) => {
      const coreStart = (words[startIdx] as WordToken).start;
      const end = (words[endIdx] as WordToken).end;
      if (!isWordSpanAvailable({ start: coreStart, end })) return false;

      const prev = words[startIdx - 1];
      const hasPrevPeriod =
        prev !== undefined &&
        spacesOnlyBetween(input, prev.end, coreStart) &&
        isWordSpanAvailable(prev) &&
        matchPeriodWord(prev, false) !== null;
      const prefixStart = hasPrevPeriod && prev
        ? expandConnectorBefore(input, words, prev.start, [['vào', 'buổi'], ['buổi'], ['vào'], ['vào', 'ngày'], ['on']], occupied)
        : expandConnectorBefore(input, words, coreStart, [['vào', 'ngày'], ['vào'], ['on']], occupied);

      dateCandidates.push({
        start: coreStart,
        end,
        prefixStart,
        apply: () => {
          let start = coreStart;
          if (prev && spacesOnlyBetween(input, prev.end, start) && isWordSpanAvailable(prev)) {
            const p = matchPeriodWord(prev, false);
            if (p) {
              contextPeriod = p;
              if ((parsedTime !== null && !parsedTime.hasAmPm) || (timeTokenDismissed && !hasExplicitClockRange)) {
                // Clock time already exists (e.g. "sáng mai 9h") or user dismissed clock time: merge period into date token.
                start = expandConnectorBefore(input, words, prev.start, [['vào', 'buổi'], ['buổi'], ['vào']], occupied);
              } else if (parsedTime === null && !suppressDefaultPeriodTime) {
                // Emit separate time token so user can independently dismiss period vs date.
                const pStart = expandConnectorBefore(input, words, prev.start, [['vào', 'buổi'], ['buổi'], ['vào'], ['lúc']], occupied);
                parsedTime = { hour: PERIOD_DEFAULT_HOUR[p], minute: 0, explicitClock: false, period: p };
                claimToken('time', pStart, prev.end);
                timeSpans.push({ start: pStart, end: prev.end });
              }
            }
          }
          start = expandConnectorBefore(input, words, start, [['vào', 'ngày'], ['vào'], ['on']], occupied);
          explicitDueOn = dateValue;
          explicitTodaySpecified = isToday;
          claimToken('date', start, end);
          dateSpans.push({ start, end });
        },
      });
      return true;
    };

    // 7a. "day after tomorrow" and "[ngày] cuối tháng này|sau|tới" / "end of this|next month"
    const w3 = words[i + 3];
    const resolveMonthEndOffset = (monthOffset: number): string => {
      const todayParts = parseIsoCalendarDate(today) ?? { year: 2026, month: 1, day: 1 };
      const totalMonths = todayParts.year * 12 + (todayParts.month - 1) + monthOffset;
      const targetYear = Math.floor(totalMonths / 12);
      const targetMonth = (totalMonths % 12) + 1;
      return formatIsoDate(targetYear, targetMonth, daysInCalendarMonth(targetYear, targetMonth));
    };
    if (
      w1 &&
      w2 &&
      w3 &&
      contiguous(i, i + 3) &&
      ((vnMatch(w0, 'ngày') && vnMatch(w1, 'cuối') && vnMatch(w2, 'tháng') && vnMatchAny(w3, ['này', 'sau', 'tới'])) ||
        (w0.nfcLower === 'end' && w1.nfcLower === 'of' && (w2.nfcLower === 'this' || w2.nfcLower === 'next') && w3.nfcLower === 'month'))
    ) {
      const monthOffset = vnMatch(w3, 'này') || w2.nfcLower === 'this' ? 0 : 1;
      const resolved = resolveMonthEndOffset(monthOffset);
      if (queueDateRange(i, i + 3, resolved, resolved === today)) {
        i += 3;
        continue;
      }
    }
    if (
      w1 &&
      w2 &&
      contiguous(i, i + 2) &&
      vnMatch(w0, 'cuối') &&
      vnMatch(w1, 'tháng') &&
      vnMatchAny(w2, ['này', 'sau', 'tới'])
    ) {
      const resolved = resolveMonthEndOffset(vnMatch(w2, 'này') ? 0 : 1);
      if (queueDateRange(i, i + 2, resolved, resolved === today)) {
        i += 2;
        continue;
      }
    }
    if (w1 && w2 && contiguous(i, i + 2) && w0.nfcLower === 'day' && w1.nfcLower === 'after' && w2.nfcLower === 'tomorrow') {
      if (queueDateRange(i, i + 2, addLocalDays(today, 2), false)) {
        i += 2;
        continue;
      }
    }

    // 7b. "this morning/afternoon/evening" / "tomorrow morning/afternoon/evening/night"
    if (w1 && contiguous(i, i + 1) && (w0.nfcLower === 'this' || w0.nfcLower === 'tomorrow')) {
      const enPeriod = matchPeriodWord(w1, true);
      if (enPeriod) {
        const span = { start: w0.start, end: w1.end };
        if (isWordSpanAvailable(span)) {
          const isTmr = w0.nfcLower === 'tomorrow';
          const prefixStart = expandConnectorBefore(input, words, span.start, [['on']], occupied);
          dateCandidates.push({
            start: span.start,
            end: span.end,
            prefixStart,
            apply: () => {
              explicitDueOn = isTmr ? addLocalDays(today, 1) : today;
              explicitTodaySpecified = !isTmr;
              contextPeriod = enPeriod;
              if (isTmr && !parsedTime && !suppressDefaultPeriodTime) {
                parsedTime = { hour: PERIOD_DEFAULT_HOUR[enPeriod], minute: 0, explicitClock: false, period: enPeriod };
                claimToken('date', prefixStart, w0.end);
                dateSpans.push({ start: prefixStart, end: w0.end });
                claimToken('time', w1.start, w1.end);
                timeSpans.push({ start: w1.start, end: w1.end });
              } else if (isTmr && hasExplicitClockRange && !parsedTime) {
                claimToken('date', prefixStart, w0.end);
                dateSpans.push({ start: prefixStart, end: w0.end });
              } else {
                if (!parsedTime && !suppressDefaultPeriodTime) {
                  parsedTime = { hour: PERIOD_DEFAULT_HOUR[enPeriod], minute: 0, explicitClock: false, period: enPeriod };
                }
                claimToken('date', prefixStart, span.end);
                dateSpans.push({ start: prefixStart, end: span.end });
              }
            },
          });
          i += 1;
          continue;
        }
      }
    }

    // 7c. "tonight"
    if (w0.nfcLower === 'tonight' && isWordSpanAvailable(w0)) {
      dateCandidates.push({
        start: w0.start,
        end: w0.end,
        prefixStart: w0.start,
        apply: () => {
          explicitDueOn = today;
          explicitTodaySpecified = true;
          contextPeriod = 'evening';
          if (!parsedTime && !suppressDefaultPeriodTime) {
            parsedTime = { hour: PERIOD_DEFAULT_HOUR.evening, minute: 0, explicitClock: false, period: 'evening' };
          }
          claimToken('date', w0.start, w0.end);
          dateSpans.push(w0);
        },
      });
      continue;
    }

    // 7d. "hôm nay" / "bữa nay" / "today"
    if (
      w1 && contiguous(i, i + 1) && vnMatchAny(w0, ['hôm', 'bữa']) && vnMatch(w1, 'nay') && queueDateRange(i, i + 1, today, true)
    ) {
      i += 1;
      continue;
    }
    if (w0.nfcLower === 'today' && queueDateRange(i, i, today, true)) {
      continue;
    }

    // 7e. "sáng nay" / "trưa nay" / "chiều nay" / "tối nay" / "đêm nay" (plus "[vào] [buổi] <period> nay")
    const pToday = matchPeriodWord(w0, false);
    if (pToday && w1 && contiguous(i, i + 1) && vnMatch(w1, 'nay')) {
      const span = { start: w0.start, end: w1.end };
      if (isWordSpanAvailable(span)) {
        const prefixStart = expandConnectorBefore(input, words, w0.start, [['vào', 'buổi'], ['buổi'], ['vào']], occupied);
        dateCandidates.push({
          start: span.start,
          end: span.end,
          prefixStart,
          apply: () => {
            explicitDueOn = today;
            explicitTodaySpecified = true;
            contextPeriod = pToday;
            if (parsedTime || (timeTokenDismissed && !hasExplicitClockRange)) {
              claimToken('date', prefixStart, w1.end);
              dateSpans.push({ start: prefixStart, end: w1.end });
            } else if (hasExplicitClockRange) {
              claimToken('date', w1.start, w1.end);
              dateSpans.push({ start: w1.start, end: w1.end });
            } else {
              parsedTime = { hour: PERIOD_DEFAULT_HOUR[pToday], minute: 0, explicitClock: false, period: pToday };
              claimToken('time', prefixStart, w0.end);
              claimToken('date', w1.start, w1.end);
              dateSpans.push({ start: w1.start, end: w1.end });
            }
          },
        });
        i += 1;
        continue;
      }
    }
    // If the period half of "<period> nay" was absorbed into a clock ("9h sáng nay") or dismissed as time, "nay" stays a date ("today").
    if (vnMatch(w0, 'nay')) {
      const prev = words[i - 1];
      const prevPeriod = prev ? matchPeriodWord(prev, false) : null;
      if (
        prev &&
        prevPeriod &&
        spacesOnlyBetween(input, prev.end, w0.start) &&
        (hasOverlap(timeSpans, prev) || hasOverlap(dismissedTimeSpans, prev))
      ) {
        dateCandidates.push({
          start: w0.start,
          end: w0.end,
          prefixStart: w0.start,
          apply: () => {
            explicitDueOn = today;
            explicitTodaySpecified = true;
            contextPeriod = prevPeriod;
            claimToken('date', w0.start, w0.end);
            dateSpans.push({ start: w0.start, end: w0.end });
          },
        });
        continue;
      }
    }

    // 7f. "ngày mai" / "tomorrow" / "tmr" / "tmrw" / "ngày kia" / "ngày mốt"
    if (w1 && contiguous(i, i + 1) && vnMatch(w0, 'ngày') && vnMatch(w1, 'mai') && queueDateRange(i, i + 1, addLocalDays(today, 1), false)) {
      i += 1;
      continue;
    }
    if (
      (w0.nfcLower === 'tomorrow' || w0.nfcLower === 'tmr' || w0.nfcLower === 'tmrw') &&
      queueDateRange(i, i, addLocalDays(today, 1), false)
    ) {
      continue;
    }
    if (w1 && contiguous(i, i + 1) && vnMatch(w0, 'ngày') && vnMatchAny(w1, ['kia', 'mốt']) && queueDateRange(i, i + 1, addLocalDays(today, 2), false)) {
      i += 1;
      continue;
    }

    // 7g. Standalone "mai" (only exact ASCII/no-wrong-tone 'mai', guarded against names & idioms) and exact diacritic "mốt"
    if (w0.nfcLower === 'mai') {
      const prev = words[i - 1];
      const next = words[i + 1];
      const blockedBefore = prev && spacesOnlyBetween(input, prev.end, w0.start) && vnMatchAny(prev, MAI_BEFORE_GUARDS);
      const blockedAfter = next && spacesOnlyBetween(input, w0.end, next.start) && vnMatchAny(next, MAI_AFTER_GUARDS);
      const capitalizedMidSentence =
        i > 0 &&
        /^[A-Z]/.test(w0.raw) &&
        !(prev && /[.!?\n]/.test(input.slice(prev.end, w0.start))) &&
        !(prev && spacesOnlyBetween(input, prev.end, w0.start) && matchPeriodWord(prev, false) !== null);
      if (!blockedBefore && !blockedAfter && !capitalizedMidSentence && queueDateRange(i, i, addLocalDays(today, 1), false)) {
        continue;
      }
    }
    if (w0.nfcLower === 'mốt' && queueDateRange(i, i, addLocalDays(today, 2), false)) {
      continue;
    }

    // 7h. "<N> ngày nữa" / "in <N> days"
    if (
      w1 &&
      w2 &&
      contiguous(i, i + 2) &&
      ((/^\d{1,3}$/.test(w0.nfcLower) && vnMatch(w1, 'ngày') && vnMatchAny(w2, ['nữa', 'tới'])) ||
        (w0.nfcLower === 'in' && /^\d{1,3}$/.test(w1.nfcLower) && (w2.nfcLower === 'day' || w2.nfcLower === 'days')))
    ) {
      const days = Number(w0.nfcLower === 'in' ? w1.nfcLower : w0.nfcLower);
      if (days >= 0 && days <= MAX_INTERVAL && queueDateRange(i, i + 2, addLocalDays(today, days), days === 0)) {
        i += 2;
        continue;
      }
    }

    // 7i. "next <weekday>" / "this <weekday>"
    if ((w0.nfcLower === 'next' || w0.nfcLower === 'this') && w1 && contiguous(i, i + 1)) {
      const wd = matchWeekday(input, words, i + 1, true);
      if (wd) {
        const endIdx = i + wd.consumed;
        const resolved = w0.nfcLower === 'next' ? nextWeekOccurrenceOfWeekday(today, wd.weekday) : nextOccurrenceOfWeekday(today, wd.weekday, true);
        if (queueDateRange(i, endIdx, resolved, resolved === today)) {
          i = endIdx;
          continue;
        }
      }
    }

    // 7j. "tuần sau|tới [vào] <weekday>" / "next week [on] <weekday>" / bare "tuần sau" / "next week"
    if (
      w1 &&
      contiguous(i, i + 1) &&
      ((vnMatch(w0, 'tuần') && vnMatchAny(w1, ['sau', 'tới'])) || (w0.nfcLower === 'next' && w1.nfcLower === 'week'))
    ) {
      const isEnglish = w0.nfcLower === 'next';
      let afterWeekIdx = i + 2;
      const connWord = words[afterWeekIdx];
      if (connWord && contiguous(i + 1, afterWeekIdx) && (isEnglish ? connWord.nfcLower === 'on' : vnMatch(connWord, 'vào'))) {
        afterWeekIdx += 1;
      }
      const wd = afterWeekIdx < words.length && contiguous(i + 1, afterWeekIdx) ? matchWeekday(input, words, afterWeekIdx, isEnglish) : null;
      const endIdx = wd ? afterWeekIdx + wd.consumed - 1 : i + 1;
      const resolved = wd ? nextWeekOccurrenceOfWeekday(today, wd.weekday) : nextWeekOccurrenceOfWeekday(today, 1);
      if (queueDateRange(i, endIdx, resolved, false)) {
        i = endIdx;
        continue;
      }
    }

    // 7k. "<weekday> tuần sau|tới|này|next week" or bare "<weekday>"
    const prevWord = words[i - 1];
    const hasOnConnector = Boolean(prevWord && spacesOnlyBetween(input, prevWord.end, w0.start) && prevWord.nfcLower === 'on');
    const hasEnglishAdjacentContext =
      hasOnConnector ||
      enTimeSpans.some((s) => spacesOnlyBetween(input, s.end, w0.start) || spacesOnlyBetween(input, w0.end, s.start));
    const wd = matchWeekday(input, words, i, hasEnglishAdjacentContext);
    if (wd) {
      const endWdIdx = i + wd.consumed - 1;
      const a0 = words[endWdIdx + 1];
      const a1 = words[endWdIdx + 2];
      if (
        a0 &&
        a1 &&
        contiguous(endWdIdx, endWdIdx + 2) &&
        ((vnMatch(a0, 'tuần') && vnMatchAny(a1, ['sau', 'tới'])) || (a0.nfcLower === 'next' && a1.nfcLower === 'week'))
      ) {
        const resolved = nextWeekOccurrenceOfWeekday(today, wd.weekday);
        if (queueDateRange(i, endWdIdx + 2, resolved, false)) {
          i = endWdIdx + 2;
          continue;
        }
      }
      if (a0 && a1 && contiguous(endWdIdx, endWdIdx + 2) && vnMatch(a0, 'tuần') && vnMatch(a1, 'này')) {
        const resolved = nextOccurrenceOfWeekday(today, wd.weekday, true);
        if (queueDateRange(i, endWdIdx + 2, resolved, resolved === today)) {
          i = endWdIdx + 2;
          continue;
        }
      }
      const resolved = nextOccurrenceOfWeekday(today, wd.weekday, false);
      if (queueDateRange(i, endWdIdx, resolved, false)) {
        i = endWdIdx;
        continue;
      }
    }
  }

    dateCandidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const dedupedDateCandidates: DateCandidate[] = [];
    for (const dc of dateCandidates) {
      const prev = dedupedDateCandidates[dedupedDateCandidates.length - 1];
      if (prev && dc.start < prev.end) continue;
      dedupedDateCandidates.push(dc);
    }
    return dedupedDateCandidates;
  };

  const ALLOWED_DATE_TO_CLOCK_GAP = new Set(['', ',', 'luc', 'vao luc', 'vao', 'at', '@']);
  const ALLOWED_CLOCK_TO_DATE_GAP = new Set(['', 'ngay', 'vao', 'vao ngay', 'on']);

  const endAfterOptionalAttachedClock = (anchorEnd: number, limitEnd?: number): number => {
    for (let idx = 0; idx < dedupedTimeCandidates.length; idx++) {
      const tc = dedupedTimeCandidates[idx];
      if (!tc || tc.start < anchorEnd) continue;
      if (limitEnd !== undefined && tc.end > limitEnd) break;
      const resolved = resolveClockPeriod(tc);
      if (
        !isAvailable(tc) ||
        !hasCleanLeftBoundary(tc) ||
        !hasCleanRightBoundary(tc) ||
        resolved.shortGBlocked ||
        isDurationClock(tc, resolved.period)
      ) {
        continue;
      }
      if (limitEnd !== undefined && resolved.end > limitEnd) continue;
      const gap = foldVn(input.slice(anchorEnd, resolved.start)).replace(/\s+/g, ' ').trim();
      if (!ALLOWED_DATE_TO_CLOCK_GAP.has(gap)) break;
      let cursorEnd = resolved.end;
      let rangeIdx = idx;
      while (rangeIdx + 1 < dedupedTimeCandidates.length) {
        const nextTc = dedupedTimeCandidates[rangeIdx + 1];
        if (!nextTc || (limitEnd !== undefined && nextTc.end > limitEnd)) break;
        const nextResolved = resolveClockPeriod(nextTc);
        if (!isRangeBetweenClocks(cursorEnd, nextResolved.start) || !hasCleanRightBoundary(nextTc)) break;
        if (limitEnd !== undefined && nextResolved.end > limitEnd) break;
        cursorEnd = nextResolved.end;
        rangeIdx += 1;
      }
      return cursorEnd;
    }
    return anchorEnd;
  };

  const startBeforeOptionalAttachedClock = (targetStart: number, minStart?: number): number => {
    for (let idx = dedupedTimeCandidates.length - 1; idx >= 0; idx--) {
      const tc = dedupedTimeCandidates[idx];
      if (!tc || tc.end > targetStart) continue;
      if (minStart !== undefined && tc.start < minStart) break;
      const resolved = resolveClockPeriod(tc);
      if (
        !isAvailable(tc) ||
        !hasCleanLeftBoundary(tc) ||
        !hasCleanRightBoundary(tc) ||
        resolved.shortGBlocked ||
        isDurationClock(tc, resolved.period)
      ) {
        continue;
      }
      if (resolved.end > targetStart) continue;
      const gap = foldVn(input.slice(resolved.end, targetStart)).replace(/\s+/g, ' ').trim();
      if (!ALLOWED_CLOCK_TO_DATE_GAP.has(gap)) break;
      let innerStart = resolved.start;
      let cursorStart = expandConnectorBefore(input, words, innerStart, [['vào', 'lúc'], ['vào'], ['lúc'], ['at']], occupied);
      let rangeIdx = idx;
      while (rangeIdx - 1 >= 0) {
        const prevTc = dedupedTimeCandidates[rangeIdx - 1];
        if (!prevTc || (minStart !== undefined && prevTc.start < minStart)) break;
        const prevResolved = resolveClockPeriod(prevTc);
        if (!isRangeBetweenClocks(prevResolved.end, innerStart) || !hasCleanLeftBoundary(prevTc)) break;
        const prevStart = expandConnectorBefore(
          input,
          words,
          prevResolved.start,
          [['vào', 'lúc'], ['vào'], ['lúc'], ['at']],
          occupied,
        );
        if (minStart !== undefined && prevStart < minStart) break;
        innerStart = prevResolved.start;
        cursorStart = prevStart;
        rangeIdx -= 1;
      }
      if (minStart !== undefined && cursorStart < minStart) return targetStart;
      return cursorStart;
    }
    return targetStart;
  };

  const isMultiDateRangePair = (prevDc: DateCandidate, nextDc: DateCandidate): boolean => {
    if (isMultiDateConnector(prevDc.end, nextDc.start) || isMultiDateConnector(prevDc.end, nextDc.prefixStart)) {
      return true;
    }
    const leftEndWithClock = endAfterOptionalAttachedClock(prevDc.end, nextDc.prefixStart);
    const rightPrefixWithClock = startBeforeOptionalAttachedClock(nextDc.prefixStart, prevDc.end);
    const rightRawWithClock = startBeforeOptionalAttachedClock(nextDc.start, prevDc.end);
    return (
      isMultiDateConnector(leftEndWithClock, nextDc.start) ||
      isMultiDateConnector(leftEndWithClock, nextDc.prefixStart) ||
      isMultiDateConnector(prevDc.end, rightPrefixWithClock) ||
      isMultiDateConnector(prevDc.end, rightRawWithClock) ||
      (leftEndWithClock <= rightPrefixWithClock && isMultiDateConnector(leftEndWithClock, rightPrefixWithClock)) ||
      (leftEndWithClock <= rightRawWithClock && isMultiDateConnector(leftEndWithClock, rightRawWithClock))
    );
  };

  const findDateRangeEndIdx = (candidates: DateCandidate[], startIdx: number): number => {
    let rangeEndIdx = startIdx;
    while (rangeEndIdx + 1 < candidates.length) {
      const prevDc = candidates[rangeEndIdx];
      const nextDc = candidates[rangeEndIdx + 1];
      if (!prevDc || !nextDc || !isMultiDateRangePair(prevDc, nextDc)) break;
      rangeEndIdx += 1;
    }
    return rangeEndIdx;
  };

  // Detect multi-date & date-time ranges (and clocks bound to unchosen dates) before claiming clocks.
  const rawEnglishTimeSpans = dedupedTimeCandidates
    .filter((tc) => tc.hasAmPm || expandConnectorBefore(input, words, tc.start, [['at']], occupied) < tc.start)
    .map((tc) => ({ start: tc.start, end: tc.end }));
  const preDateCandidates = collectDateCandidates(rawEnglishTimeSpans);
  const skippedDateRangeSpans: Span[] = [];
  let chosenDateCandidate: DateCandidate | undefined;
  const unchosenDateCandidates: DateCandidate[] = [];
  for (let idx = 0; idx < preDateCandidates.length; idx++) {
    const dc = preDateCandidates[idx];
    if (!dc) continue;
    const rangeEndIdx = findDateRangeEndIdx(preDateCandidates, idx);
    if (rangeEndIdx > idx) {
      const lastDc = preDateCandidates[rangeEndIdx] as DateCandidate;
      const rangeStart = Math.min(
        dc.prefixStart,
        startBeforeOptionalAttachedClock(dc.prefixStart),
        startBeforeOptionalAttachedClock(dc.start),
      );
      const rangeEnd = endAfterOptionalAttachedClock(lastDc.end);
      skippedDateRangeSpans.push({ start: rangeStart, end: rangeEnd });
      idx = rangeEndIdx;
    } else if (!chosenDateCandidate) {
      chosenDateCandidate = dc;
    } else {
      unchosenDateCandidates.push(dc);
    }
  }
  const skippedClockSpans: Span[] = [...skippedDateRangeSpans];
  if (chosenDateCandidate && unchosenDateCandidates.length > 0) {
    const chosenEnd = endAfterOptionalAttachedClock(chosenDateCandidate.end);
    for (const uc of unchosenDateCandidates) {
      const ucStart = Math.min(
        uc.prefixStart,
        startBeforeOptionalAttachedClock(uc.prefixStart, chosenEnd),
        startBeforeOptionalAttachedClock(uc.start, chosenEnd),
      );
      const ucEnd = endAfterOptionalAttachedClock(uc.end);
      if (ucStart < uc.prefixStart) skippedClockSpans.push({ start: ucStart, end: uc.prefixStart });
      if (ucEnd > uc.end) skippedClockSpans.push({ start: uc.end, end: ucEnd });
    }
    for (const tc of dedupedTimeCandidates) {
      if (tc.start < chosenEnd) continue;
      const rc = resolveClockPeriod(tc);
      if (unchosenDateCandidates.some((uc) => rc.start < uc.end && rc.end > uc.prefixStart)) {
        skippedClockSpans.push({ start: rc.start, end: rc.end });
      }
    }
  }

  // 6. Explicit clock times (14:30, 9h30, 9h, 9am, 2:30pm)
  for (let idx = 0; idx < dedupedTimeCandidates.length; idx++) {
    const tc = dedupedTimeCandidates[idx];
    if (!tc || !isAvailable(tc) || hasOverlap(skippedClockSpans, tc)) continue;

    if (hasHalfUnitRangeBefore(tc.start)) {
      if (hasCleanRightBoundary(tc)) hasExplicitClockRange = true;
      continue;
    }
    if (!hasCleanLeftBoundary(tc)) continue;

    const resolvedClock = resolveClockPeriod(tc);
    let start = resolvedClock.start;
    const end = resolvedClock.end;
    const period = resolvedClock.period;
    if (resolvedClock.shortGBlocked || isDurationClock(tc, period)) continue;

    // Skip time ranges ("từ 9h đến 10h", "9h - 11h", "9h sáng-2h chiều", "9:00am - 11:00am") intact rather than stripping only one side.
    let rangeEndIdx = idx;
    let cursorEnd = end;
    while (rangeEndIdx + 1 < dedupedTimeCandidates.length) {
      const nextTc = dedupedTimeCandidates[rangeEndIdx + 1];
      if (!nextTc || !isAvailable(nextTc)) break;
      const nextResolved = resolveClockPeriod(nextTc);
      if (
        !isRangeBetweenClocks(cursorEnd, nextTc.start) &&
        !(nextResolved.start < nextTc.start && isRangeBetweenClocks(cursorEnd, nextResolved.start))
      ) {
        break;
      }
      rangeEndIdx += 1;
      cursorEnd = nextResolved.end;
    }
    if (rangeEndIdx > idx) {
      const lastTc = dedupedTimeCandidates[rangeEndIdx];
      if (lastTc && hasCleanRightBoundary(lastTc)) hasExplicitClockRange = true;
      idx = rangeEndIdx;
      continue;
    }

    if (hasHalfUnitRangeAfter(end)) {
      hasExplicitClockRange = true;
      continue;
    }
    if (!hasCleanRightBoundary(tc)) continue;

    const startBeforeAt = start;
    const connectorSequences =
      resolvedClock.start < tc.start
        ? ([['vào', 'buổi'], ['buổi'], ['vào'], ['lúc']] as const)
        : ([['vào', 'lúc'], ['vào'], ['lúc'], ['at']] as const);
    start = expandConnectorBefore(input, words, start, connectorSequences, occupied);
    const usedEnglishAt = start < startBeforeAt && /^at\b/i.test(input.slice(start));
    const adjustedHour = tc.hasAmPm ? tc.hour : adjustHourForPeriod(tc.hour, period);
    parsedTime = { hour: adjustedHour, minute: tc.minute, explicitClock: true, hasAmPm: tc.hasAmPm, period };
    claimToken('time', start, end);
    timeSpans.push({ start, end });
    if (tc.hasAmPm || usedEnglishAt) englishTimeSpans.push({ start, end });
    break;
  }

  // 7. Resolve explicit numeric & relative dates together in sentence order while keeping multi-date ranges intact
  suppressDefaultPeriodTime = hasExplicitClockRange || timeTokenDismissed;
  const dedupedDateCandidates = collectDateCandidates(englishTimeSpans);
  for (let idx = 0; idx < dedupedDateCandidates.length; idx++) {
    const dc = dedupedDateCandidates[idx];
    if (!dc) continue;
    const rangeEndIdx = findDateRangeEndIdx(dedupedDateCandidates, idx);
    if (rangeEndIdx > idx) {
      idx = rangeEndIdx;
      continue;
    }
    if (hasOverlap(skippedDateRangeSpans, dc)) continue;
    dc.apply();
    break;
  }

  // 8. Period adjacent to an already-matched explicit date, weekday recurrence, or dismissed date chip ("sáng mai", "tomorrow morning")
  const recurrenceAnchorSpans = recurrenceState.derivedDueOn !== null ? tokens.filter((t) => t.kind === 'recurrence') : [];
  const dismissedDateAnchorSpans = dismissedList.filter(
    (t) => t.kind === 'date' && t.raw.trim().toLowerCase() !== 'tonight',
  );
  for (const ds of [...dateSpans, ...recurrenceAnchorSpans, ...dismissedDateAnchorSpans]) {
    const beforeW = findAdjacentWordBefore(input, words, ds.start, occupied);
    const beforePeriod = beforeW && isWordSpanAvailable(beforeW) ? matchPeriodWord(beforeW, false) : null;
    if (beforeW && beforePeriod) {
      contextPeriod = beforePeriod;
      if (!parsedTime && !suppressDefaultPeriodTime) {
        const pStart = expandConnectorBefore(input, words, beforeW.start, [['vào', 'buổi'], ['buổi'], ['vào'], ['lúc']], occupied);
        parsedTime = { hour: PERIOD_DEFAULT_HOUR[beforePeriod], minute: 0, explicitClock: false, period: beforePeriod };
        claimToken('time', pStart, beforeW.end);
        timeSpans.push({ start: pStart, end: beforeW.end });
      } else if (parsedTime && !parsedTime.hasAmPm && dateSpans.includes(ds)) {
        const dateTok = tokens.find((t) => t.kind === 'date' && t.start === ds.start && t.end === ds.end);
        if (dateTok) {
          const pStart = expandConnectorBefore(input, words, beforeW.start, [['vào', 'buổi'], ['buổi'], ['vào']], occupied);
          dateTok.start = pStart;
          dateTok.raw = input.slice(pStart, dateTok.end);
          occupied.push({ start: pStart, end: beforeW.end });
        }
      }
      continue;
    }
    const afterW = findAdjacentWordAfter(input, words, ds.end, occupied);
    const afterPeriod = afterW && isWordSpanAvailable(afterW) ? matchPeriodWord(afterW, true) : null;
    if (afterW && afterPeriod) {
      contextPeriod = afterPeriod;
      if (!parsedTime && !suppressDefaultPeriodTime) {
        parsedTime = { hour: PERIOD_DEFAULT_HOUR[afterPeriod], minute: 0, explicitClock: false, period: afterPeriod };
        claimToken('time', afterW.start, afterW.end);
        timeSpans.push({ start: afterW.start, end: afterW.end });
      } else if (parsedTime && parsedTime.explicitClock && !parsedTime.hasAmPm && !parsedTime.period && dateSpans.includes(ds)) {
        const dateTok = tokens.find((t) => t.kind === 'date' && t.start === ds.start && t.end === ds.end);
        if (dateTok) {
          dateTok.end = afterW.end;
          dateTok.raw = input.slice(dateTok.start, dateTok.end);
          occupied.push({ start: afterW.start, end: afterW.end });
        }
      }
    }
  }

  // Standalone "[vào] buổi sáng/trưa/chiều/tối/đêm" or "vào sáng/trưa/chiều/tối/đêm": always capture period context, and set default time only if no clock/range exists.
  for (let i = 0; i < words.length - 1; i++) {
    const w0 = words[i];
    const w1 = words[i + 1];
    if (!w0 || !w1 || !spacesOnlyBetween(input, w0.end, w1.start)) continue;
    if (!vnMatchAny(w0, ['buổi', 'vào'])) continue;
    const p = matchPeriodWord(w1, false);
    if (!p) continue;
    const spanStart = vnMatch(w0, 'buổi') ? expandConnectorBefore(input, words, w0.start, [['vào']], occupied) : w0.start;
    const span = { start: spanStart, end: w1.end };
    if (!isWordSpanAvailable(span)) continue;
    if (!parsedTime && !suppressDefaultPeriodTime) {
      contextPeriod = p;
      parsedTime = { hour: PERIOD_DEFAULT_HOUR[p], minute: 0, explicitClock: false, period: p };
      claimToken('time', span.start, span.end);
      break;
    } else if (parsedTime && parsedTime.explicitClock && !parsedTime.hasAmPm && !parsedTime.period) {
      const adjacentTime = tokens.find(
        (t) => t.kind === 'time' && (spacesOnlyBetween(input, t.end, span.start) || spacesOnlyBetween(input, span.end, t.start)),
      );
      const adjacentDate = tokens.find(
        (t) => t.kind === 'date' && (spacesOnlyBetween(input, t.end, span.start) || spacesOnlyBetween(input, span.end, t.start)),
      );
      const hostTok = adjacentTime ?? adjacentDate;
      if (hostTok) {
        contextPeriod = p;
        if (spacesOnlyBetween(input, hostTok.end, span.start)) hostTok.end = span.end;
        else hostTok.start = span.start;
        hostTok.raw = input.slice(hostTok.start, hostTok.end);
        occupied.push(span);
        break;
      }
    }
  }

  // If the user dismissed a date chip that absorbed a period ("tối thứ sáu"), keep its period context for any remaining clock ("8h" -> 20:00).
  if (parsedTime && parsedTime.explicitClock && !parsedTime.hasAmPm && !parsedTime.period && !contextPeriod) {
    for (const tok of dismissedList) {
      if (tok.kind !== 'date') continue;
      for (let wi = 0; wi < words.length; wi++) {
        const w = words[wi];
        if (!w || w.start < tok.start || w.end > tok.end) continue;
        const p = w.nfcLower === 'tonight' ? 'evening' : matchPeriodWord(w, true);
        if (p && !hasOverlap(dismissedTimeSpans, w)) {
          contextPeriod = p;
          break;
        }
      }
      if (contextPeriod) break;
    }
  }

  // Reconcile contextual period with explicit clock time when separated by a date (e.g. "chiều thứ sáu 3h")
  if (parsedTime && parsedTime.explicitClock && !parsedTime.hasAmPm && !parsedTime.period && contextPeriod) {
    parsedTime = {
      ...parsedTime,
      hour: adjustHourForPeriod(parsedTime.hour, contextPeriod),
      period: contextPeriod,
    };
  }

  // Resolve bare clause-edge "daily"/"everyday"/"weekly"/"monthly" after dates & clocks are claimed
  // so "Send report daily tomorrow 9am" matches while pre-nominal "Daily report tomorrow" stays an adjective.
  for (let i = 0; i < words.length; i++) {
    const w0 = words[i];
    if (!w0) continue;
    if (w0.nfcLower !== 'daily' && w0.nfcLower !== 'everyday' && w0.nfcLower !== 'weekly' && w0.nfcLower !== 'monthly') {
      continue;
    }
    if (!isWordSpanAvailable(w0)) continue;
    const w1 = words[i + 1];
    const tail = input.slice(w0.end).trimStart();
    const atClauseEdge =
      /^(?:$|[,.;:)!#/\n]|(?:at|lúc|luc)\s+\d|\d{1,2}(?::\d{2}\b|\s*(?:am|pm|h|g|giờ|gio)\b))/i.test(tail) ||
      (w1 !== undefined && !isAvailable(w1));
    if (atClauseEdge || w0.nfcLower === 'everyday') {
      const freq = w0.nfcLower === 'weekly' ? 'weekly' : w0.nfcLower === 'monthly' ? 'monthly' : 'daily';
      recordRecurrence({ freq, interval: 1 }, today, w0.start, w0.end);
    }
  }
  const recurrence = recurrenceState.rule;
  const recurrenceDerivedDueOn = recurrenceState.derivedDueOn;

  // 9. Resolve final dueOn, dueTime, dueAt, remindAt
  let dueOn: string | null = explicitDueOn ?? recurrenceDerivedDueOn;
  const dueTime: string | null = parsedTime ? formatHHmm(parsedTime.hour, parsedTime.minute) : null;

  if (parsedTime && dueOn === null) {
    // Time-only input without a date word: today unless that wall time has already passed today.
    const candidateMs = zonedInstant(opts.timeZone, today, parsedTime.hour * 60 + parsedTime.minute);
    dueOn = candidateMs <= nowMs ? addLocalDays(today, 1) : today;
  } else if (parsedTime && !explicitTodaySpecified && explicitDueOn === null && recurrence !== null && dueOn === today) {
    // Daily/weekly recurrence starting today whose clock time already passed advances to its next occurrence.
    const candidateMs = zonedInstant(opts.timeZone, today, parsedTime.hour * 60 + parsedTime.minute);
    if (candidateMs <= nowMs) {
      if (recurrence.freq === 'daily') {
        dueOn = addLocalDays(today, recurrence.interval);
      } else if (recurrence.freq === 'weekly') {
        dueOn = addLocalDays(today, 7 * recurrence.interval);
      } else if (recurrence.freq === 'monthly') {
        dueOn = addCalendarMonthsForRecurrence(today, recurrence.interval, recurrence.byMonthDay);
      }
    }
  }

  let dueAt: string | null = null;
  let remindAt: string | null = null;
  if (dueOn !== null && parsedTime !== null) {
    const dueMs = zonedInstant(opts.timeZone, dueOn, parsedTime.hour * 60 + parsedTime.minute);
    dueAt = formatZonedIsoOffset(opts.timeZone, dueMs);
    remindAt = formatZonedIsoOffset(opts.timeZone, dueMs - remindBeforeMinutes * MINUTE_MS);
  }

  tokens.sort((a, b) => a.start - b.start);
  const title = buildTitleWithoutSpans(input, tokens);

  return {
    title,
    dueOn,
    dueTime,
    dueAt,
    remindAt,
    timeZone: opts.timeZone,
    recurrence,
    priority,
    tags,
    listName,
    tokens,
  };
}
