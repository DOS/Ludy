// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, issue #2590, plan docs/plan/meetings.md section 11 and 15, ADR-0047; personal note & unpublished draft #4292):
// the recorder of a meeting with a published summary (or, for the recorder alone, an unpublished draft) opens a follow-up draft, picks either the structured minutes layout or
// a personal note prose style (optionally drafted by their own member-scoped Vy under meetings.followup_note), edits it and the recipients, and sends it.
// Every text is cleaned and checked by code on send, and facts are rebuilt from the chosen stage at send time (refusing STALE_FOLLOWUP if the result changed).
import { z } from 'zod';
import { isMailAddress } from './mail-address.ts';
import { zMeetingLanguage, zMeetingRef } from './meetings.ts';
import { zId } from './schemas.ts';

// Most addresses one send goes to, and most sends (batches) per meeting in a rolling 24 hours, on top of the mail pipeline's own limits.
export const FOLLOWUP_RECIPIENTS_MAX = 20;
export const FOLLOWUP_SENDS_PER_MEETING_PER_DAY = 3;
// What a person (or Vy) may write around the facts: a follow-up is not a letter.
export const FOLLOWUP_GREETING_MAX = 200;
export const FOLLOWUP_LEAD_MAX = 600;
export const FOLLOWUP_CLOSING_MAX = 300;
export const FOLLOWUP_SUBJECT_MAX = 200;
export const FOLLOWUP_HINT_MAX = 200;
export const FOLLOWUP_NOTE_MAX = 4000;
// The mail's source (mail_message.source): the follow-up of a meeting, source_id the meeting.
export const FOLLOWUP_MAIL_SOURCE = 'meetings.followup';
export const FOLLOWUP_MAIL_TEMPLATE = 'meetings.followup';

export const FOLLOWUP_STYLES = ['structured', 'personal_note'] as const;
export type FollowupStyle = (typeof FOLLOWUP_STYLES)[number];
export const FOLLOWUP_STAGES = ['published', 'draft'] as const;
export type FollowupStage = (typeof FOLLOWUP_STAGES)[number];

export type FollowupTextProblem = 'EMPTY' | 'TOO_LONG' | 'FIGURES' | 'LINK' | 'CONTACT';

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const EXTRA_INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]|\u034f/gu;

// Text as it is checked and stored: Unicode NFKC, no format or invisible characters (bidi marks, zero-width joiners, fillers: they would hide a digit or a dot from the checks below) and no control
// characters other than a line break, no carriage returns, blank lines folded. The server stores and sends this form, never what the client sent.
export function followupClean(text: string, oneLine: boolean): string {
  const flat = text
    .replace(LONE_SURROGATE, '')
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
    .replace(EXTRA_INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n]/gu, ' ')
    .replace(/\p{Zl}|\p{Zp}/gu, '\n');
  const lines = oneLine ? flat.replace(/\n+/g, ' ') : flat.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return lines.replace(/[ \t]{2,}/g, ' ').trim();
}

// The rules of packages/agent reminder.ts (the same words checks the payment reminder's model text goes through), kept here, in the contract, because the module's send command
// applies them to whatever the client sends: "this text came from Vy" is something the server cannot trust (a client can send anything), so the checks, not the flag, are the gate.
// A digit of any script, a currency sign and a number said in words are figures: the facts of the mail are the summary's, and the words around them state none.
const NUMBER_WORD = new RegExp(
  '(?<![\\p{L}])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?![\\p{L}])',
  'iu',
);
const VI_NUMBER_BEFORE_UNIT = new RegExp(
  '(?<![\\p{L}])(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười|mươi|mốt|lăm|mấy)(?:\\s+(?:mươi|mốt|lăm|mười))?\\s+(?:ngày|tuần|tháng|quý|năm|đồng|đô|giờ|phút)(?![\\p{L}])',
  'iu',
);
const VI_MAGNITUDE = /(?<![\p{L}])(?:trăm|nghìn|ngàn|triệu|tỷ|tỉ)(?![\p{L}])/iu;
const CURRENCY_SIGN = /[$€£¥₫₩₹]/u;
// Anything that reads as an address: a dot between letters, an obfuscated dot or at sign, a scheme, "www", "@".
const ADDRESS = /\p{L}\p{M}*[.。．｡]\p{L}|\p{L}\s*[[(]\s*(?:\.|dot)\s*[\])]\s*\p{L}|\p{L}\s+dot\s+\p{L}|[[(]\s*at\s*[\])]|@|:\/\/|(?<![\p{L}])www(?![\p{L}])/iu;

const BARE_TLDS = new Set([
  'com', 'net', 'org', 'vn', 'io', 'co', 'me', 'ly', 'app', 'info', 'biz', 'edu', 'gov', 'xyz', 'site', 'link', 'shop', 'online',
  'cc', 'tv', 'ai', 'dev', 'ink', 'top', 'club', 'live', 'store', 'page', 'click', 'to', 'gl', 'cn', 'ru', 'us', 'uk', 'jp', 'kr', 'test',
]);
const IS_WORD_CHAR = /^[\p{L}\p{N}]$/u;
function trimToWord(token: string): string {
  const chars = [...token];
  let from = 0;
  let to = chars.length;
  while (from < to && !IS_WORD_CHAR.test(chars[from] as string)) from += 1;
  while (to > from && !IS_WORD_CHAR.test(chars[to - 1] as string)) to -= 1;
  return chars.slice(from, to).join('');
}

// Any ASCII punctuation but the dot and the hyphen, and spaces, end a word: so does what is glued to a domain (a,123.com, a|x.com, a/x.com, a_x.com). Letters and digits of any
// script stay in the word, so "chốt.Co" is one word with a non-ASCII letter and is not a domain.
const WORD_BREAK = /[\s!-,/:-@[-`{-~]+/u;
// Spaces around a dot between two ASCII words (abc . com) read as the dot they hide (#4553). A capital after the dot is a new sentence ("Xong . Ai làm"), not a domain.
const SPACED_DOT = /(?<=[A-Za-z0-9-])[ \t]+\.[ \t]+(?=[a-z0-9-])/gu;

/**
 * Whether a text carries a bare domain link (including numeric-prefix domains such as 123.com or 1.ai). Punctuation glued to a domain (a,123.com, a|x.com) does not hide one, an
 * ideographic full stop (123。com) and spaces around a dot (abc . com) read as the dot they stand for (#4479, #4553).
 */
export function followupHasBareLink(text: string): boolean {
  const base = text.normalize('NFKC').replace(/[。｡]/gu, '.');
  // The text as it is and with the spaced dots closed: closing them can join two words into one that is no domain, so a link seen before is still seen.
  for (const form of [base, base.replace(SPACED_DOT, '.')]) {
    for (const raw of form.split(WORD_BREAK)) {
      const token = trimToWord(raw).toLowerCase();
      if (token === '') continue;
      const labels = token.split('.');
      if (labels.length < 2 || labels.some((l) => l === '')) continue;
      const tld = labels[labels.length - 1] as string;
      if (BARE_TLDS.has(tld) && labels.every((l) => [...l].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-'))) return true;
    }
  }
  return false;
}

const GROUPED_INTEGER = /^[1-9]\d{0,2}(?:\.\d{3})+$/;
const DASH_DATE = /^(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])-(?:0[1-9]|1[0-2])-\d{4})$/;
// A day written with dots (28.11.2026): eight digits that are not a contact. The year is 19xx or 20xx, so a phone such as 09.12.4567 is not let through as one.
const DOT_DATE = /^(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}$/;
// A hyphen with spaces around it, then a digit group: how a phone number is sometimes typed by hand (090 - 123 - 4567). The group is captured to see whether it holds a dot.
const SPACED_DASH_DIGITS = /^[ \t]*-[ \t]*(\d+(?:\.\d+)*)/;
// One dot or several, then a digit: the dot joins the digits on both sides of it (090.123.4567, 15.000.000).
const DOTS_DIGIT = /^\.+\d/;
// A dot, spaces, then a digit: a phone typed as "090. 123. 4567".
const DOT_SPACE_DIGIT = /^\.[ \t]+\d/;
const UNSPACED_DASH = /\d-\d/;
// A run joined through a hyphen with spaces needs nine digits (a Vietnamese mobile has ten, eleven with 84): shorter ones are times (0900 - 1700), days (05 - 10 - 2026) and ranges.
const SPACED_RUN_DIGITS_MIN = 9;
// The dashes NFKC leaves alone (hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar, minus sign) read as the hyphen they stand for (#4553).
const OTHER_DASHES = /[\u2010-\u2015\u2212]/gu;
// A run that opens like a phone number (0, 84 or +country digit) and goes on through groups of two digits or more split by a hyphen, a slash or an underscore (spaces allowed around it),
// a comma with no space after it, a single line break, or spaces: 090/123/4567, 090_123_4567, 090,123,4567, 090-123 - 4567, 090 on one line and 123 4567 on the next. A comma and a
// space, and a group of one digit, are a list (01, 02, 03; 0/1/2), not a number. A run does not start inside a date or number (right after a digit and a hyphen or slash).
const PHONE_LEAD_RUN = /(?<![\d.]|\d[-/])(?:\+[ \t]?\d|0|84)\d*(?:(?:[ \t]*[-/_][ \t]*(?:\r?\n[ \t]*)?|,|[ \t]*\r?\n[ \t]*|[ \t]+)\d{2,})+/g;
// A run that does not open like a phone number but is short groups split by spaced hyphens and ends in a group of four digits: 90 - 123 - 4567, 415 - 555 - 2671. A range, or tiers
// of figures (100 - 200 - 300), are not one.
const PHONE_LEADLESS_RUN = /(?<![\d.]|\d[-/])\d{1,3}(?:[ \t]+-[ \t]+\d{1,4})+[ \t]+-[ \t]+\d{4}(?!\d)/g;
// A day that opens a run (28/11/2026, 05 - 10 - 2026, 2026-11-28, or only a day and a month: 08/12) is a date. What follows it may still be a contact: see hasLoosePhone.
const DATE_START = /^(?:\d{4}-\d{2}-\d{2}|(?:0?[1-9]|[12]\d|3[01])[ \t]*[-/.][ \t]*(?:0?[1-9]|1[0-2])(?:[ \t]*[-/.][ \t]*(?:19|20)\d{2})?(?!\d|[-/.]\d))/;

// The phone shapes the run scan below does not join: other separators, a line break, a number typed without its leading 0. Nine digits or more, as a Vietnamese mobile has ten
// (eleven with 84) and a time (0900 - 1700) or a day has eight. These only add refusals: the run scan still decides everything it decided before.
function hasLoosePhone(normalized: string): boolean {
  for (const pattern of [PHONE_LEAD_RUN, PHONE_LEADLESS_RUN]) {
    for (const found of normalized.matchAll(pattern)) {
      const date = DATE_START.exec(found[0]);
      // A date opens the run: the date is not a contact, but what follows it may be (05/12/2026, 090_123_4567).
      if (date !== null) {
        if (hasLoosePhone(found[0].slice(date[0].length))) return true;
        continue;
      }
      if (found[0].replace(/\D/gu, '').length >= SPACED_RUN_DIGITS_MIN) return true;
    }
  }
  return false;
}

/** Whether a cleaned text holds a phone number or an 8+-digit contact/ID run (allowing grouped thousands integers like 15.000.000, dash dates like 2026-11-15 and dot dates like 28.11.2026). */
export function followupHasPhoneOrLongDigits(text: string): boolean {
  const normalized = text.normalize('NFKC');
  const dashed = normalized.replace(OTHER_DASHES, '-');
  // The run scan reads the text as typed and with the other dashes as hyphens, so a text it refused before is refused still; the loose shapes read the second.
  return hasLongDigitRun(normalized) || (dashed !== normalized && hasLongDigitRun(dashed)) || hasLoosePhone(dashed);
}

function hasLongDigitRun(normalized: string): boolean {
  let start = -1;
  let last = -1;
  let digitCount = 0;
  let spacedRun = false;
  const standsAlone = (span: string): boolean => GROUPED_INTEGER.test(span) || DASH_DATE.test(span) || DOT_DATE.test(span);
  const flush = () => {
    if (start >= 0) {
      const span = normalized.slice(start, last + 1);
      if (digitCount >= (spacedRun ? SPACED_RUN_DIGITS_MIN : 8) && !standsAlone(span)) return true;
    }
    start = -1;
    last = -1;
    digitCount = 0;
    spacedRun = false;
    return false;
  };
  for (let i = 0; i <= normalized.length; i += 1) {
    const c = i < normalized.length ? (normalized[i] as string) : '';
    const digit = c >= '0' && c <= '9';
    if (digit) {
      if (start < 0) start = i;
      last = i;
      digitCount += 1;
      continue;
    }
    const span = start >= 0 ? normalized.slice(start, last + 1) : '';
    const joinSpace = start >= 0 && (c === ' ' || c === '\t') && normalized[i + 1] !== '-' && !standsAlone(span);
    const joinDash = start >= 0 && c === '-' && normalized[i - 1] !== ' ' && normalized[i + 1] !== ' ';
    // A phone typed with spaces around its hyphens (090 - 123 - 4567) or after its dots (090. 123. 4567) is one run. Only a run that opens like a phone number (0, 84 or +) is joined
    // this way, so a range of figures (1000 - 2000, 2025 - 2026) or a sentence ("Năm 2025. 2026 ...") is not read as one; a run that holds a date, a grouped number or a dotted
    // time (08.30 - 11.30) stands alone, and so does a group that follows a hyphen with a dot in it (0 - 15.000.000).
    const phoneLead = normalized[start] === '0' || normalized.startsWith('84', start) || normalized[start - 1] === '+';
    const phoneRun = start >= 0 && phoneLead && !standsAlone(span);
    const dashed = start >= 0 && (c === ' ' || c === '\t' || c === '-') ? SPACED_DASH_DIGITS.exec(normalized.slice(i)) : null;
    const joinSpacedDash = phoneRun && !joinDash && dashed !== null && !(dashed[1] ?? '').includes('.') && !span.includes('.') && !UNSPACED_DASH.test(span);
    const joinDotSpace = phoneRun && c === '.' && DOT_SPACE_DIGIT.test(normalized.slice(i));
    const joinParen = start >= 0 && (c === ')' || (c === '(' && digitCount <= 3));
    // A dot joins two digits (090.123.4567, 15.000.000), not a full stop that ends a sentence ("Năm 2025. 2026 ...").
    const joinDot = start >= 0 && c === '.' && DOTS_DIGIT.test(normalized.slice(i));
    if (joinSpacedDash) spacedRun = true;
    if (joinSpace || joinDash || joinSpacedDash || joinDotSpace || joinParen || joinDot) continue;
    if (flush()) return true;
  }
  return false;
}

const lengthOf = (text: string): number => Array.from(text).length;

/** Why a piece of words (greeting, lead, closing) may not be sent, or null. The text is the cleaned one (followupClean). */
export function followupWordsProblem(clean: string, max: number): FollowupTextProblem | null {
  if (clean === '') return 'EMPTY';
  if (lengthOf(clean) > max) return 'TOO_LONG';
  if (/\p{N}/u.test(clean) || CURRENCY_SIGN.test(clean) || NUMBER_WORD.test(clean) || VI_NUMBER_BEFORE_UNIT.test(clean) || VI_MAGNITUDE.test(clean)) return 'FIGURES';
  if (ADDRESS.test(clean)) return 'LINK';
  return null;
}

/** Why a subject may not be sent, or null: one line, a length, and no address or link. A subject may hold a digit (the default names the meeting, "Họp 15/11"), so no figures rule. */
export function followupSubjectProblem(clean: string): FollowupTextProblem | null {
  if (clean === '') return 'EMPTY';
  if (lengthOf(clean) > FOLLOWUP_SUBJECT_MAX) return 'TOO_LONG';
  if (ADDRESS.test(clean) || followupHasBareLink(clean)) return 'LINK';
  return null;
}

/**
 * Why a personal note body sent by the recorder may not be sent, or null.
 * Intentionally allows the recorder to keep grounded figures from the meeting facts or edit dates/counts in their own voice, while strictly blocking
 * empty/overlong notes, links/domains, email addresses, and phone numbers / 8+-digit contact runs (Vy's generated note is additionally held to exact numeric grounding in packages/agent).
 */
export function followupNoteProblem(clean: string): FollowupTextProblem | null {
  if (clean === '') return 'EMPTY';
  if (lengthOf(clean) > FOLLOWUP_NOTE_MAX) return 'TOO_LONG';
  if (ADDRESS.test(clean) || followupHasBareLink(clean)) return 'LINK';
  if (followupHasPhoneOrLongDigits(clean)) return 'CONTACT';
  return null;
}

export const zFollowupWords = z.strictObject({
  subject: z.string(),
  greeting: z.string(),
  lead: z.string(),
  closing: z.string(),
});
export type FollowupWords = z.infer<typeof zFollowupWords>;

// The facts of the mail: the meeting's summary, decisions and action items from the chosen stage.
export const zFollowupItem = z.strictObject({ title: z.string(), who: z.string(), when: z.string() });
export const zFollowupFacts = z.strictObject({
  summary: z.string(),
  decisions: z.array(z.string()),
  items: z.array(zFollowupItem),
});
export type FollowupFacts = z.infer<typeof zFollowupFacts>;

// Who the draft suggests: on published, the meeting's attendees (readers that are members) and linked contacts; on unpublished draft, only linked external contacts.
export const FOLLOWUP_RECIPIENT_KINDS = ['attendee', 'party'] as const;
export const zFollowupRecipient = z.strictObject({
  kind: z.enum(FOLLOWUP_RECIPIENT_KINDS),
  id: zId,
  name: z.string(),
  email: z.string(),
  // A mail for this meeting already went to this address (queued, sent or delivered): sending again needs the recorder's tick.
  alreadySent: z.boolean(),
});
export type FollowupRecipient = z.infer<typeof zFollowupRecipient>;

export const zFollowupDraftAsk = zMeetingRef.extend({
  stage: z.enum(FOLLOWUP_STAGES).optional(),
});
export type FollowupDraftAsk = z.infer<typeof zFollowupDraftAsk>;

export const zFollowupDraft = z.strictObject({
  meetingId: zId,
  lang: zMeetingLanguage,
  org: z.string(),
  // Which stage these facts and recipients came from ('published' by default when available, else 'draft').
  stage: z.enum(FOLLOWUP_STAGES).optional(),
  hasPublished: z.boolean().optional(),
  hasDraft: z.boolean().optional(),
  // What the recorder reviewed: a key over the stage + facts + ids + updated_at timestamps. The send rebuilds the facts and refuses (STALE_FOLLOWUP) when the stage changed since.
  factsKey: z.string(),
  facts: zFollowupFacts,
  // The fixed words, the same whether or not a model is on.
  words: zFollowupWords,
  recipients: z.array(zFollowupRecipient).max(FOLLOWUP_RECIPIENTS_MAX),
  // The sends this meeting may still have in the rolling 24 hours.
  sendsLeft: z.number().int().min(0),
});
export type FollowupDraft = z.infer<typeof zFollowupDraft>;

// Vy's words for the lead-in and the closing (ask, then answer): a read, nothing stored. `ai` names what happened; `words` is null unless it is 'used'.
export const FOLLOWUP_AI_STATES = ['used', 'off', 'busy', 'budget', 'failed'] as const;
export const zFollowupWordingAsk = zMeetingRef.extend({
  stage: z.enum(FOLLOWUP_STAGES).optional(),
  hint: z.string().trim().max(FOLLOWUP_HINT_MAX).optional(),
});
export const zFollowupWording = z.strictObject({
  ai: z.enum(FOLLOWUP_AI_STATES),
  words: z.strictObject({ lead: z.string(), closing: z.string() }).nullable(),
});
export type FollowupWording = z.infer<typeof zFollowupWording>;

// Member-scoped Vy generating a personal-note follow-up body from the recorder's minutes facts (#4292, ADR-0049 stage A).
export const FOLLOWUP_NOTE_STATES = ['used', 'none', 'off', 'busy', 'budget', 'failed'] as const;
export const zFollowupNoteStatus = z.strictObject({
  meetingId: zId,
  enabled: z.boolean(),
  reason: z.enum(['off', 'forbidden', 'paused', 'budget', 'not_recorder']).nullable(),
});
export type FollowupNoteStatus = z.infer<typeof zFollowupNoteStatus>;

export const zFollowupNoteStart = zMeetingRef.extend({
  stage: z.enum(FOLLOWUP_STAGES).optional(),
});
export const zFollowupNoteStarted = z.strictObject({
  meetingId: zId,
  runId: zId,
  stage: z.enum(FOLLOWUP_STAGES),
});
export type FollowupNoteStarted = z.infer<typeof zFollowupNoteStarted>;

export const zFollowupNoteAsk = zMeetingRef.extend({
  stage: z.enum(FOLLOWUP_STAGES).optional(),
  hint: z.string().trim().max(FOLLOWUP_HINT_MAX).optional(),
});
export type FollowupNoteAsk = z.infer<typeof zFollowupNoteAsk>;

export const zFollowupNoteAnswer = z.strictObject({
  ai: z.enum(FOLLOWUP_NOTE_STATES),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  note: z.string().nullable(),
  dropped: z.number().int().min(0).max(100),
});
export type FollowupNoteAnswer = z.infer<typeof zFollowupNoteAnswer>;

const zAddress = z.string().trim().max(254);
export const zFollowupSend = zMeetingRef.extend({
  style: z.enum(FOLLOWUP_STYLES).default('structured'),
  stage: z.enum(FOLLOWUP_STAGES).default('published'),
  factsKey: z.string().min(1).max(100),
  subject: z.string().max(1000),
  greeting: z.string().max(2000).default(''),
  lead: z.string().max(5000).default(''),
  closing: z.string().max(3000).default(''),
  body: z.string().max(12_000).optional(),
  // Required true when sending from an unpublished draft (`stage: 'draft'`).
  confirmUnpublished: z.boolean().default(false),
  // The addresses the recorder chose (the suggestions they kept and any they added), at most FOLLOWUP_RECIPIENTS_MAX.
  recipients: z.array(zAddress).min(1).max(FOLLOWUP_RECIPIENTS_MAX),
  // Addresses that are neither a suggested recipient nor the recorder, ticked one by one by the recorder: without the tick the send is refused.
  confirmedOutsiders: z.array(zAddress).max(FOLLOWUP_RECIPIENTS_MAX),
  // The recorder's tick that a mail already went to an address for this meeting and they mean to send again.
  confirmRepeat: z.boolean(),
  // The text came from Vy, and "Tôi đã đọc" is ticked. The server cannot know where a text came from, so it checks every text;
  // the flag is the recorder's own statement that they read it, and a send that says the words are Vy's without the tick is refused.
  fromVy: z.boolean(),
  reviewed: z.boolean(),
});
export type FollowupSend = z.infer<typeof zFollowupSend>;
export const zFollowupSendCall = zFollowupSend.extend({ idempotencyKey: zId });

export const zFollowupSent = z.strictObject({
  meetingId: zId,
  // One id for the mails of this send: the cap counts these.
  batchId: zId,
  queued: z.number().int(),
  // Addresses the mail pipeline refused to send to (a hard bounce or a complaint earlier): recorded, never sent.
  suppressed: z.number().int(),
});
export type FollowupSent = z.infer<typeof zFollowupSent>;

// The merge data of one queued mail (mail_message.payload), validated at the send and again by the worker's template:
// keeps structured payloads 100% backward-compatible for any already-queued mail rows, and supports personal_note payloads.
const zFollowupStructuredMail = z.strictObject({
  style: z.literal('structured').optional(),
  lang: zMeetingLanguage,
  org: z.string().max(200),
  batch: zId,
  greeting: z.string().max(FOLLOWUP_GREETING_MAX),
  lead: z.string().max(FOLLOWUP_LEAD_MAX),
  closing: z.string().max(FOLLOWUP_CLOSING_MAX),
  facts: zFollowupFacts,
});
const zFollowupPersonalNoteMail = z.strictObject({
  style: z.literal('personal_note'),
  lang: zMeetingLanguage,
  org: z.string().max(200),
  batch: zId,
  body: z.string().min(1).max(FOLLOWUP_NOTE_MAX),
});
export const zFollowupMail = z.union([zFollowupStructuredMail, zFollowupPersonalNoteMail]);
export type FollowupMail = z.infer<typeof zFollowupMail>;
export type FollowupStructuredMail = z.infer<typeof zFollowupStructuredMail>;
export type FollowupPersonalNoteMail = z.infer<typeof zFollowupPersonalNoteMail>;

/** An address as the checks read it: trimmed and lower-cased, one valid mailbox, or null. */
export function followupAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return isMailAddress(address) ? address : null;
}
