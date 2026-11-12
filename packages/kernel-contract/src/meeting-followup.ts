// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, issue #2590, plan docs/plan/meetings.md section 11 and 15, ADR-0047): the recorder, with a published summary, opens a draft, edits the
// words around the facts and the recipients, and sends it. The meetings module decides every rule: the facts (the published summary, decisions and action items) are rebuilt from
// the published result at the moment of the send, the recipients are checked, and nothing is sent without the recorder's own send command. Vy only words the lead-in and the
// closing (apps/kernel followup-ai.ts, packages/agent followup.ts), told none of the meeting's facts; with AI off the same draft is built from fixed words.
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
// The mail's source (mail_message.source): the follow-up of a meeting, source_id the meeting.
export const FOLLOWUP_MAIL_SOURCE = 'meetings.followup';
export const FOLLOWUP_MAIL_TEMPLATE = 'meetings.followup';

export type FollowupTextProblem = 'EMPTY' | 'TOO_LONG' | 'FIGURES' | 'LINK';

// Text as it is checked and stored: Unicode NFKC, no format characters (bidi marks, zero-width joiners: they would hide a digit or a dot from the checks below) and no control
// characters other than a line break, no carriage returns, blank lines folded. The server stores and sends this form, never what the client sent.
export function followupClean(text: string, oneLine: boolean): string {
  const flat = text
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
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
  if (ADDRESS.test(clean)) return 'LINK';
  return null;
}

export const zFollowupWords = z.strictObject({
  subject: z.string(),
  greeting: z.string(),
  lead: z.string(),
  closing: z.string(),
});
export type FollowupWords = z.infer<typeof zFollowupWords>;

// The facts of the mail: the meeting's published summary, decisions and action items, as the readers of the meeting read them.
export const zFollowupItem = z.strictObject({ title: z.string(), who: z.string(), when: z.string() });
export const zFollowupFacts = z.strictObject({
  summary: z.string(),
  decisions: z.array(z.string()),
  items: z.array(zFollowupItem),
});
export type FollowupFacts = z.infer<typeof zFollowupFacts>;

// Who the draft suggests: the meeting's attendees (the recorder and the readers that are members) and the contacts linked to the meeting (L1), each with an email address.
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

export const zFollowupDraft = z.strictObject({
  meetingId: zId,
  lang: zMeetingLanguage,
  org: z.string(),
  // What the recorder reviewed: a key over the facts. The send rebuilds the facts and refuses (STALE_FOLLOWUP) when the published result changed since.
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
export const zFollowupWordingAsk = zMeetingRef.extend({ hint: z.string().trim().max(FOLLOWUP_HINT_MAX).optional() });
export const zFollowupWording = z.strictObject({
  ai: z.enum(FOLLOWUP_AI_STATES),
  words: z.strictObject({ lead: z.string(), closing: z.string() }).nullable(),
});
export type FollowupWording = z.infer<typeof zFollowupWording>;

const zAddress = z.string().trim().max(254);
export const zFollowupSend = zMeetingRef.extend({
  factsKey: z.string().min(1).max(100),
  subject: z.string().max(1000),
  greeting: z.string().max(2000),
  lead: z.string().max(5000),
  closing: z.string().max(3000),
  // The addresses the recorder chose (the suggestions they kept and any they added), at most FOLLOWUP_RECIPIENTS_MAX.
  recipients: z.array(zAddress).min(1).max(FOLLOWUP_RECIPIENTS_MAX),
  // Addresses that are neither an attendee nor a contact linked to the meeting, ticked one by one by the recorder: without the tick the send is refused.
  confirmedOutsiders: z.array(zAddress).max(FOLLOWUP_RECIPIENTS_MAX),
  // The recorder's tick that a mail already went to an address for this meeting and they mean to send again.
  confirmRepeat: z.boolean(),
  // The lead-in or the closing came from Vy, and "Tôi đã đọc" is ticked. The server cannot know where a text came from, so it checks every text the same way whatever this says;
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

// The merge data of one queued mail (mail_message.payload), validated at the send and again by the worker's template: the cleaned words and the facts as the published result
// held them at the moment of the send, and the id of the send (the cap counts these).
export const zFollowupMail = z.strictObject({
  lang: zMeetingLanguage,
  org: z.string().max(200),
  batch: zId,
  greeting: z.string().max(FOLLOWUP_GREETING_MAX),
  lead: z.string().max(FOLLOWUP_LEAD_MAX),
  closing: z.string().max(FOLLOWUP_CLOSING_MAX),
  facts: zFollowupFacts,
});
export type FollowupMail = z.infer<typeof zFollowupMail>;

/** An address as the checks read it: trimmed and lower-cased, one valid mailbox, or null. */
export function followupAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return isMailAddress(address) ? address : null;
}
