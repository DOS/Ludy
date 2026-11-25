// SPDX-License-Identifier: AGPL-3.0-only
// Finding the questions, the figures and the dates in a transcript (#4954): pure code, no model, nothing stored. A filter is a view over the lines the caller can already read, so it names no
// line the reader may not see. The detectors are rules over the words of one line (Vietnamese first, English too); they say "this line looks like a question / holds a figure / holds a date or a
// deadline", never more, and the screen says so. Amounts are only found here, never added up, so there is no money arithmetic (no JS number is made from an amount).

export const LINE_FILTERS = ['question', 'figure', 'date'] as const;
export type LineFilter = (typeof LINE_FILTERS)[number];

// A line's words, lower case, Unicode form C (the marks stay: "ai" is who, "ải" is not), punctuation read as a space, a space at each end so a whole word is found with its spaces.
function wordsOf(text: string): string {
  return ` ${text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

const has = (words: string, phrase: string): boolean => words.includes(` ${phrase} `);
const hasAny = (words: string, phrases: readonly string[]): boolean => phrases.some((p) => has(words, p));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Questions

// A sentence ends at . ! ? … followed by a space (so "3.5" and "9:30" stay whole).
function sentences(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// Phrases that ask by themselves in Vietnamese.
const VI_ASKING = [
  'bao nhiêu',
  'bao giờ',
  'bao lâu',
  'bao xa',
  'khi nào',
  'lúc nào',
  'ở đâu',
  'cái gì',
  'làm gì',
  'là gì',
  'việc gì',
  'chuyện gì',
  'thế nào',
  'như thế nào',
  'ra sao',
  'tại sao',
  'vì sao',
  'làm sao',
  'mấy giờ',
  'có phải',
  'phải không',
  'đúng không',
  'được không',
  'ai',
];
// The last word of a sentence that turns it into a question: "anh gửi báo giá chưa", "chị có đi không".
const VI_LAST_WORD = ['không', 'chưa', 'nhỉ', 'hả', 'hử'];
// "bao nhiêu cũng được", "ở đâu cũng", "ai cũng biết": the same words said as "any", not as a question.
const ANY_AFTER = ['cũng', 'nấy', 'đó', 'đấy', 'mà'];
// "không ai", "bất cứ ai", "dù thế nào": said as "nobody", "anyone", "however".
const NOT_ASKING_BEFORE = ['không', 'bất cứ', 'bất kỳ', 'bất kể', 'mọi', 'dù', 'cho dù', 'bất luận', 'dẫu'];

// English: a question word that opens a sentence, or an auxiliary and its subject.
const EN_OPENING = ['what', 'when', 'where', 'why', 'how', 'who', 'whom', 'whose', 'which'];
const EN_AUX = ['do you', 'does it', 'does he', 'does she', 'did you', 'can you', 'could you', 'would you', 'will you', 'are you', 'is it', 'is there', 'are there', 'have you', 'should we', 'shall we'];

function viAsks(words: string): boolean {
  for (const phrase of VI_ASKING) {
    let from = 0;
    for (;;) {
      const at = words.indexOf(` ${phrase} `, from);
      if (at === -1) break;
      from = at + 1;
      const before = words.slice(0, at + 1);
      const after = words.slice(at + phrase.length + 1);
      if (ANY_AFTER.some((w) => after.startsWith(` ${w} `))) continue;
      if (NOT_ASKING_BEFORE.some((w) => before.endsWith(` ${w} `))) continue;
      // Earlier "dù"/"bất kể" in the sentence makes "thế nào" a "however".
      if (phrase.endsWith('thế nào') && (has(before, 'dù') || has(before, 'bất kể') || has(before, 'bất luận'))) continue;
      return true;
    }
  }
  const last = words.trim().split(' ').at(-1);
  return last !== undefined && VI_LAST_WORD.includes(last);
}

function enAsks(words: string): boolean {
  const trimmed = words.trimStart();
  return EN_OPENING.some((w) => trimmed.startsWith(`${w} `)) || EN_AUX.some((p) => trimmed.startsWith(`${p} `));
}

/** True when a sentence of the line asks something: it ends with a question mark, or it holds a question word or phrase and is not one of the "any" or "nobody" uses of them. */
export function looksLikeQuestion(text: string): boolean {
  return sentences(text).some((sentence) => {
    // A closing quote or bracket after the mark: "...đúng không?"
    if (/\?[\s"'”’)\]»]*$/u.test(sentence)) return true;
    const words = wordsOf(sentence);
    return viAsks(words) || enAsks(words);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Figures: money, percentages, quantities

const NUMBER_WORDS = '(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười|mươi|vài|trăm|rưỡi)';
const AMOUNT = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const CURRENCY_UNIT = String.raw`(?:đ|₫|vnd|vnđ|đồng|usd|đô la|đô|dollars?|euros?|eur)`;
const MAGNITUDE = String.raw`(?:triệu|tỷ|tỉ|nghìn|ngàn|k|tr)`;
const QUANTITY_UNIT = String.raw`(?:cái|chiếc|người|bộ|hộp|thùng|gói|suất|lô|đơn|hợp đồng|khách|nhân viên|kg|kí|ký|gam|lít|mét|cm|km|m2|m²|users?|seats?|licen[cs]es?|items?|units?|pieces?|pcs|orders?|people|hours?|minutes?|days?|weeks?|months?|giờ|phút|ngày|tuần|tháng(?!\s*\d))`;

const FIGURE_RULES: readonly RegExp[] = [
  // 15%, 12,5 %, "mười phần trăm", "15 percent"
  new RegExp(String.raw`(?:${AMOUNT})\s*(?:%|phần trăm|percent)`, 'iu'),
  new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${NUMBER_WORDS}\s+phần trăm(?![\p{L}\p{N}])`, 'iu'),
  // $500, 500$, 2.500.000đ, 2tr5, 500k, 3 triệu, 1.2 tỷ, 50 usd
  new RegExp(String.raw`\$\s*(?:${AMOUNT})`, 'iu'),
  new RegExp(String.raw`(?:${AMOUNT})\s*(?:\$|${CURRENCY_UNIT}(?![\p{L}\p{N}]))`, 'iu'),
  new RegExp(String.raw`(?:${AMOUNT})\s*${MAGNITUDE}(?![\p{L}])`, 'iu'),
  // two million: a number word, then a magnitude ("hai triệu rưỡi", "năm trăm nghìn")
  new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${NUMBER_WORDS}(?:\s+${NUMBER_WORDS})*\s+(?:triệu|tỷ|tỉ|nghìn|ngàn)(?![\p{L}])`, 'iu'),
  // 50 người, 3 tháng, 20 cái
  new RegExp(String.raw`(?<![\p{L}\p{N}/:.,-])(?:${AMOUNT})\s*${QUANTITY_UNIT}(?![\p{L}\p{N}])`, 'iu'),
];

// A bare number that is clearly a figure: a thousands or decimal separator, or at least three digits; not a date, a time, or a year after "năm".
const DATE_LIKE = /\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}/gu;
const TIME_LIKE = /\d{1,2}(?::\d{2}){1,2}|\d{1,2}h\d{0,2}/giu;
function bareFigure(text: string): boolean {
  const scrubbed = text.replace(DATE_LIKE, ' ').replace(TIME_LIKE, ' ');
  const numbers = scrubbed.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])(${AMOUNT})(?![\p{L}\p{N}])`, 'gu'));
  for (const match of numbers) {
    const value = match[1] as string;
    const at = match.index ?? 0;
    const before = scrubbed.slice(0, at).toLowerCase().trimEnd();
    const isYear = /^\d{4}$/u.test(value) && /(?:năm|in|since|until|đến|từ|vào)$/u.test(before);
    if (isYear) continue;
    if (/[.,]/u.test(value) || value.length >= 3) return true;
  }
  return false;
}

/** True when the line holds a money amount, a percentage, a quantity with its unit, or a plain figure. Amounts are found, never calculated. */
export function hasFigure(text: string): boolean {
  const flat = text.normalize('NFC');
  return FIGURE_RULES.some((rule) => rule.test(flat)) || bareFigure(flat);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Dates and deadlines

const WEEKDAYS = [
  'thứ hai',
  'thứ ba',
  'thứ tư',
  'thứ năm',
  'thứ sáu',
  'thứ bảy',
  'chủ nhật',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const RELATIVE = [
  'hôm nay',
  'hôm qua',
  'hôm kia',
  'ngày mai',
  'ngày kia',
  'sáng mai',
  'chiều mai',
  'tối mai',
  'sáng nay',
  'chiều nay',
  'tối nay',
  'tuần sau',
  'tuần tới',
  'tuần này',
  'tuần trước',
  'tháng sau',
  'tháng tới',
  'tháng này',
  'tháng trước',
  'cuối tuần',
  'cuối tháng',
  'đầu tháng',
  'cuối quý',
  'cuối năm',
  'năm sau',
  'năm tới',
  'today',
  'tomorrow',
  'yesterday',
  'tonight',
  'next week',
  'next month',
  'next quarter',
  'last week',
  'last month',
  'end of the week',
  'end of the month',
  'end of the quarter',
  'end of the year',
  'this week',
  'this month',
];
const DEADLINE = ['hạn chót', 'hạn cuối', 'hạn nộp', 'hạn thanh toán', 'đến hạn', 'quá hạn', 'trước hạn', 'deadline', 'due date', 'due by', 'due on'];
const MONTHS_EN = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

const DATE_RULES: readonly RegExp[] = [
  // 15/12, 15/12/2026, 15-12-2026, 2026-12-15
  /(?<![\p{L}\p{N}/.:-])(?:[0-3]?\d[/-][01]?\d(?:[/-](?:\d{4}|\d{2}))?|\d{4}-[01]\d-[0-3]\d)(?![\p{L}\p{N}/:-])/u,
  // ngày 15, ngày 15 tháng 12, ngày 15/12, mùng 5, mồng 5
  /(?<![\p{L}\p{N}])(?:ngày|mùng|mồng)\s+[0-3]?\d(?![\p{L}\p{N}])/iu,
  // 15 tháng 12, tháng 12, quý 3
  /(?<![\p{L}\p{N}])(?:tháng|quý)\s+(?:\d{1,2}|một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])[0-3]?\d\s+tháng\s+[01]?\d(?![\p{L}\p{N}])/iu,
  // 15 December, December 15, Dec 15th
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:[0-3]?\d(?:st|nd|rd|th)?\s+${MONTHS_EN}|${MONTHS_EN}\s+[0-3]?\d(?:st|nd|rd|th)?)(?![\p{L}\p{N}])`, 'iu'),
  // thứ 2 .. thứ 7
  /(?<![\p{L}\p{N}])thứ\s+[2-7](?![\p{L}\p{N}])/iu,
  // 9h, 9h30, 9:30 only count with a day word (handled by RELATIVE and WEEKDAYS), so no rule for a clock time alone
];

/** True when the line names a day, a date or a deadline: a weekday, "ngày mai", "15/12", "ngày 15", "cuối tháng", "hạn chót", "next week". */
export function hasDate(text: string): boolean {
  // "24/7" is a round-the-clock service, not the 24th of July.
  const flat = text.normalize('NFC').replace(/(?<![\p{L}\p{N}/])24\/7(?![\p{L}\p{N}/])/gu, ' ');
  if (DATE_RULES.some((rule) => rule.test(flat))) return true;
  const words = wordsOf(flat);
  return hasAny(words, WEEKDAYS) || hasAny(words, RELATIVE) || hasAny(words, DEADLINE);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DETECTORS: Record<LineFilter, (text: string) => boolean> = {
  question: looksLikeQuestion,
  figure: hasFigure,
  date: hasDate,
};

/** True when the line text passes the filter. */
export function lineMatches(filter: LineFilter, text: string): boolean {
  return DETECTORS[filter](text);
}

/** How many of the lines pass each filter. */
export function filterCounts(lines: readonly { text: string }[]): Record<LineFilter, number> {
  const counts: Record<LineFilter, number> = { question: 0, figure: 0, date: 0 };
  for (const line of lines) {
    for (const filter of LINE_FILTERS) if (DETECTORS[filter](line.text)) counts[filter] += 1;
  }
  return counts;
}
