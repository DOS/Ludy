// SPDX-License-Identifier: AGPL-3.0-only
// The second-language version of a meeting's published minutes (Meetings, #4777). The member's Vy translates the published summary through the translation run (translate-run.ts: the same
// meter, the same checks and number guard) and the result is the recorder's private row (translate.ts). These commands are what the recorder does with it next:
//   meetings.minutes_version.publish     the recorder's click: the text they reviewed and edited, per segment of the published original, kept as the version of that language the readers
//                                        of the meeting read beside the original. A replacement of the one before. The original is never touched.
//   meetings.minutes_version.unpublish   the recorder takes the version down.
//   meetings.minutes_version.get         what the caller may read: every version of the meeting (the readers read them all; the table's row security says who).
// Nothing is published without the click, and the text is what the recorder sent, never what a run holds: a model's answer reaches readers only as a person's approved words. Code checks it
// again (the published original is the same one it was made from, the segments are the original's, no figure, link, address or phone number appears that the original does not hold). The
// database drops a version the moment the published original changes, is replaced, unpublished or redacted (ludy_meetings.minutes_version_drop_stale), so redaction and retention apply to both.
// The audit row carries ids, the language and counts, never a word of either text.
import { sql } from 'kysely';
import {
  zMeetingRef,
  zMinutesVersionPublish,
  zMinutesVersionPublished,
  zMinutesVersionUnpublish,
  zMinutesVersionUnpublished,
  zMinutesVersions,
  type MinutesVersions,
  type TranslationTarget,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { hasLink, recorderMeeting } from './results.ts';
import { readTranslationSource } from './translate-run.ts';
import { ROLES, lockMeeting, openMeeting, userOf } from './transcript.ts';

// The most a version's segments may hold, in UTF-8 bytes of their JSON (the table allows 400000 bytes of jsonb).
const VERSION_BYTES_MAX = 300_000;
const notPublished = () => new DomainError('MINUTES_NOT_PUBLISHED', 409, 'The minutes are not published, so there is nothing to put a second version beside');

// The ways to reach someone that a text writes, each one named, not only the kinds: a version may hold an address, a link or a number that identifies someone (a phone number, a tax code, an ID,
// an account: 8 digits or more) only if THE ORIGINAL holds that very one. A kind-by-kind check ("the original has an address, so any address may be written") would let the recorder put another
// person's address or number into a version, where the personal-data erasure (which finds a person in the original's rows, never in a version: personal-data.ts) could not reach it. So the rule
// is the database's own matching (ludy_kernel.text_mention_pattern), taken from the safe side: whatever that pattern could find in a version, it also finds in the original.
//   - Both texts are folded to NFKC first (a full-width "＠" or "０９１２" is the same character as its plain form for a reader).
//   - Address: a word of the text (cut at white space, in lower case) that holds an "@" is an address, and the version may hold only a word the original holds. Only wrappers are taken off its
//     edges (an opening bracket or quote before; a closing bracket, quote or sentence punctuation after): the characters an address's local part may hold, and what the database's pattern
//     refuses next to an address (letters, digits, "_", "-", a dot before another letter), stay, so "_alice@example.com" is not "alice@example.com".
//   - Link: the same, for a word that holds "http://", "https://" or "www.".
//   - Number: a span is the digits of a text with up to three separators between two of them (space, tab, line break, no-break spaces, ".", "(", ")", "-", and "," between two digits: 1.250.000.000
//     and 1,250,000,000 are one span of the same digits); a span of 8 digits or more is what the database's probe finds (leading zeros count: 01234567 is not 1234567). The version may hold only
//     the very spans the original holds, compared by their digits ("0912 345 678" = "0912-345-678"; Vietnam's "+84 912 345 678" is another run of digits than "0912 345 678", so a recorder writes the number as the original does), so a number built from digit runs the original writes apart is refused.
// Linear scans only, no regular expression over the whole text that could backtrack: a version holds up to VERSION_BYTES_MAX bytes.
const OPENERS = '([{<"«“‘';
const CLOSERS = ['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', "'", '»', '”', '’'];
function trimWrappers(word: string): string {
  let from = 0;
  let to = word.length;
  while (from < to && OPENERS.includes(word[from] as string)) from += 1;
  while (to > from && CLOSERS.includes(word[to - 1] as string)) to -= 1;
  return word.slice(from, to);
}
const SEPARATORS = ' \t\n\r   ﻿.()-';
const NUMBER_DIGITS_MIN = 8;
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
function numberSpans(text: string): Set<string> {
  const spans = new Set<string>();
  let digits = '';
  let gap = 0;
  const flush = () => {
    if (digits.length >= NUMBER_DIGITS_MIN) spans.add(digits);
    digits = '';
    gap = 0;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (isDigit(c)) {
      if (digits !== '' && gap > 3) flush();
      digits += c;
      gap = 0;
    } else if (digits !== '' && (SEPARATORS.includes(c) || (c === ',' && isDigit(text[i - 1]) && isDigit(text[i + 1])))) {
      gap += 1;
    } else flush();
  }
  flush();
  return spans;
}

interface Contacts {
  links: Set<string>;
  emails: Set<string>;
  numbers: Set<string>;
}
function contactsOf(text: string): Contacts {
  const links = new Set<string>();
  const emails = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/u)) {
    const word = trimWrappers(raw);
    if (word === '') continue;
    if (hasLink(word)) links.add(word);
    if (word.includes('@')) emails.add(word);
  }
  return { links, emails, numbers: numberSpans(text) };
}

// The digit runs of a text, thousands separators and leading zeros of a short figure set aside ("1.500.000" and "1,500,000" are the same three runs). A run of 8 digits or more keeps its zeros.
function digitRuns(text: string): Set<string> {
  const runs = new Set<string>();
  for (const run of text.match(/\d+/g) ?? []) runs.add(run.length >= NUMBER_DIGITS_MIN ? run : run.replace(/^0+(?=\d)/, ''));
  return runs;
}

/** What code finds wrong with a segment's reviewed text against the original it is beside: a figure, link, address or number that identifies someone that the original does not hold. Null when nothing. */
export function versionTextProblem(original: string, text: string): 'INVENTED_NUMBER' | 'CONTACT_ADDED' | null {
  const was = original.normalize('NFKC');
  const now = text.normalize('NFKC');
  const known = digitRuns(was);
  for (const run of digitRuns(now)) if (!known.has(run)) return 'INVENTED_NUMBER';
  const had = contactsOf(was);
  const has = contactsOf(now);
  for (const kind of ['links', 'emails', 'numbers'] as const) for (const one of has[kind]) if (!had[kind].has(one)) return 'CONTACT_ADDED';
  return null;
}

export const minutesVersionPublish = defineCommand({
  name: 'meetings.minutes_version.publish',
  input: zMinutesVersionPublish,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const { userId } = await recorderMeeting(ctx, input.meetingId, 'publish a translated version of its minutes');
    // The meeting row is held first, in the order the publish of a result and the erasure take, so this and a republish or a redaction of the original are one after the other.
    await lockMeeting(ctx.trx, ctx.orgId, input.meetingId);
    // The published original as the recorder reads it now (the published stage, so a draft is never what a version sits beside), in the meeting's own language.
    const source = await readTranslationSource(ctx.trx, ctx.orgId, userId, input.meetingId, 'published', input.language).catch((error: unknown) => {
      if (error instanceof DomainError && (error.code === 'TRANSLATION_NOT_FOUND' || error.code === 'TRANSLATION_NOTHING')) throw notPublished();
      throw error;
    });
    const to: TranslationTarget = source.to;
    if (source.hash !== input.hash) throw new DomainError('MINUTES_VERSION_STALE', 409, 'The published minutes changed while the version was reviewed; translate and review again');
    // The segments are the original's, once each, in the original's order: a key the original does not have is a text with nothing to sit beside.
    const originalOf = new Map(source.segments.map((s) => [s.key, s.text]));
    const order = new Map(source.segments.map((s, i) => [s.key, i]));
    let last = -1;
    for (const segment of input.segments) {
      const at = order.get(segment.key);
      if (at === undefined || at <= last) throw new DomainError('MINUTES_VERSION_SEGMENTS_INVALID', 422, 'A segment is not one of the published minutes, or is listed twice or out of order');
      last = at;
      const problem = versionTextProblem(originalOf.get(segment.key) as string, segment.text);
      if (problem !== null) throw new DomainError('MINUTES_VERSION_TEXT_REJECTED', 422, `The text of segment ${segment.key} adds a figure or a contact that the original does not have (${problem})`);
    }
    // The row holds at most this many bytes of text (the table's own CHECK is wider: jsonb overhead): refused whole, never cut.
    if (Buffer.byteLength(JSON.stringify(input.segments), 'utf8') > VERSION_BYTES_MAX) throw new DomainError('MINUTES_VERSION_TOO_LARGE', 422, 'The translated text is larger than a version holds');
    // One version a language: a new one replaces the one before (the recorder published again).
    await ctx.trx.deleteFrom('ludy_meetings.minutes_version').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('language', '=', to).execute();
    await ctx.trx
      .insertInto('ludy_meetings.minutes_version')
      .values({
        org_id: ctx.orgId,
        meeting_id: input.meetingId,
        language: to,
        source_hash: source.hash,
        body: sql`${JSON.stringify(input.segments)}::jsonb`,
        published_by: userId,
        source_run_id: input.runId ?? null,
      })
      .execute();
    ctx.audit({ meetingId: input.meetingId, language: to, segments: input.segments.length, runId: input.runId ?? null });
    return zMinutesVersionPublished.parse({ meetingId: input.meetingId, language: to, segments: input.segments.length });
  },
});

export const minutesVersionUnpublish = defineCommand({
  name: 'meetings.minutes_version.unpublish',
  input: zMinutesVersionUnpublish,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    await recorderMeeting(ctx, input.meetingId, 'take down a translated version of its minutes');
    await lockMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const res = await ctx.trx.deleteFrom('ludy_meetings.minutes_version').where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).where('language', '=', input.language).executeTakeFirst();
    const removed = Number(res.numDeletedRows ?? 0) > 0;
    ctx.audit({ meetingId: input.meetingId, language: input.language, removed });
    return zMinutesVersionUnpublished.parse({ meetingId: input.meetingId, language: input.language, removed });
  },
});

// A read of the meeting's published text, so a sensitive read like meetings.result.get (each read leaves an audit row naming the meeting).
export const minutesVersionGet = defineQuery({
  name: 'meetings.minutes_version.get',
  input: zMeetingRef,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<MinutesVersions> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const meeting = await ctx.trx.selectFrom('ludy_meetings.meeting').select('language').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.minutes_version')
      .select(['language', 'body', 'published_at'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('language')
      .execute();
    return zMinutesVersions.parse({
      meetingId: input.meetingId,
      from: meeting.language,
      versions: rows.map((r) => ({ language: r.language, publishedAt: r.published_at.toISOString(), segments: r.body })),
    });
  },
});

export const minutesVersionCommands = [minutesVersionPublish, minutesVersionUnpublish];
export const minutesVersionQueries = [minutesVersionGet];
