// SPDX-License-Identifier: AGPL-3.0-only
// Spoken cues to Vy (#4807, plan docs/plan/meetings.md L19). "Vy ơi, ghi lại việc này cho anh Nam, hạn thứ Sáu" said in a meeting lands in the transcript, and until now the summary may or may not pick it
// up. Here CODE (no model, no AI budget) finds the explicit cues in the transcript lines the recorder reads and the recorder's own click turns each into a DRAFT action item.
//
// meetings.voice_cue.draft   the recorder's click: Vietnamese "Vy ơi, ghi lại / ghi chú / ghi nhớ / lưu lại / nhắc (việc, nhở)" (with or without marks and capitals) and English "Vy, note / remind (me, us)" (also "hey
//                            Vy, ..."). The name must be addressed: "Vy ơi", or "Vy" followed by a comma, colon or dash, so "anh Vy ghi lại biên bản" (a person called Vy) is no cue. Each cue gives ONE item:
//                              title    what follows the cue, up to the end of its sentence, without the owner and the due clause; "việc này", "cái này", "this" with nothing more takes the line before as the title
//                              owner    the name after "cho", "giao cho" or "for" (or right after "nhắc"), matched by the same code as an assignee (matchAssignee: an honorific and a connector are not part of the name)
//                                       to exactly one attendee; a name nobody answers to stays as said text for a person to read
//                              due      the phrase after "hạn", "hạn chót", "trước", "deadline", "due", "by", "before", read by parseWhen against the meeting's own day; without a keyword the whole cue is read
//                            and it cites the whole second of the cue's line.
// The item is a DRAFT, born tainted like every item Vy suggests (anyone in the room may have spoken it), marked 'asked_aloud' in its flags (so it is never "clean": the bulk accept leaves it, and the recorder confirms
// it by hand), and nothing is published or made a task by this. A new summary run does not delete it (its replace step skips the flag). Running the click again adds only the cues that have no item yet (same
// second). The audit row holds counts, never text. The pure finder is exported for the tests.
import { sql } from 'kysely';
import { ITEMS_PER_MEETING_MAX, VOICE_CUES_MAX, cleanTemplateText, zVoiceCueDraft, zVoiceCueDrafted, ITEM_TEXT_MAX, ITEM_TITLE_MAX } from '@ludy/kernel-contract';
import { DomainError, defineCommand } from '@ludy/kernel-runtime';
import { matchAssignee, type Person } from './assignee-match.ts';
import { itemFlags } from './results.ts';
import { vnDay } from './retention.ts';
import { attendeeNames } from './speaker.ts';
import { parseWhen } from './summary.ts';
import { ROLES, lockMeeting, openMeeting, userOf } from './transcript.ts';

export const VOICE_CUE_FLAG = 'asked_aloud';

/** A transcript line, as the finder reads it. */
export interface CueLine {
  seconds: number;
  text: string;
}
/** One draft item a cue makes. */
export interface VoiceCue {
  // The whole second of the cue's line.
  seconds: number;
  title: string;
  // The owner as said (empty when none was said), and the one attendee code matched to it.
  who: string;
  whoUserId: string | null;
  // The due clause as said, and the day code read from it.
  when: string;
  whenDate: string | null;
}
export interface FoundCues {
  cues: VoiceCue[];
  // Cues that said nothing to write down and had no line before them to take it from.
  empty: number;
}

// Each character of a text folded to one character: no marks, lower case, "đ" as "d", a character outside the basic plane as "##" (two units, as in the original, and no punctuation). The folded text has the same length as the original, so a position found in it
// is the same position in the text as said.
function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch.length > 1) {
      out += '##';
      continue;
    }
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase();
    out += base.length === 0 ? ' ' : (base[0] as string);
  }
  return out;
}

const FILLER = '(?:lam on |giup(?: anh| chi| em| minh)? |please )?';
const VERB = '(ghi lai|ghi chu|ghi nho|luu lai|nhac nho|nhac viec|nhac|note|remind(?: me| us)?)';
// "Vy" addressed: followed by "ơi", or by a comma, a semicolon, a colon, an exclamation mark or a dash; and not the tail of a longer word.
const CUE = new RegExp(`(?:^|[^a-z0-9])vy(?:\\s+oi(?![a-z0-9])[\\s,;:!.\\-]*|\\s*[,;:!\\-]+\\s*)${FILLER}${VERB}(?![a-z0-9])`, 'u');
const PRONOUN = /^\s*(?:viec nay|cai nay|dieu nay|noi dung nay|viec do|cai do|this|that|it)(?![a-z0-9])/u;
const LEAD_IN = /^[\s,;:-]*(?:(?:rang|la|that|to|nhe|nha)(?![a-z0-9])[\s,;:-]*)*/u;
const DUE = /(?:^|[\s,;])(han chot|han|deadline|due|truoc|before|by)\s+([^,;]*)/dgu;
const OWNER = /(?:^|[\s,;])(giao cho|cho|for)\s+([^,;]*)/dgu;
// The spellings, as said, that the keywords mean: "hạn" and "han", not "hàn" (Korea) or "hán"; "cho", not "chó", "chở" or "chợ"; "trước", not "trúc".
const DUE_WORDS: ReadonlySet<string> = new Set(['hạn chót', 'han chot', 'hạn', 'han', 'deadline', 'due', 'trước', 'truoc', 'before', 'by']);
const OWNER_WORDS: ReadonlySet<string> = new Set(['giao cho', 'cho', 'for']);
// A phrase after a due keyword that reads like a time even when code cannot name the day ("tuần sau", "cuối tháng", "next week", a number); "by phone" and "trước cho chị Lan" are not.
const DATELIKE = /(?:^|\s)(?:tuan|thang|ngay|thu|cuoi|som|asap|week|month|day|next|end|today|tonight|tomorrow|morning|afternoon|sang|chieu|toi|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?![a-z0-9])|\d/u;
const SENTENCE_END = /[.!?](?=\s|$)/u;
const WORDS_MAX = 4;
const HONORIFIC = /^(?:anh|chi|em|bac|co|chu|ong|ba|ban|mr|ms|mrs)$/u;

const squash = (s: string) => cleanTemplateText(s).replace(/^[\s,;:-]+|[\s,;:-]+$/gu, '').trim();
const cut = (s: string, max: number) => Array.from(s).slice(0, max).join('').trim();
const isCue = (text: string) => CUE.test(fold(text));

// The words of a phrase (as said) with where each starts, so a prefix of them can be taken out of the text.
function wordSpans(phrase: string): Array<{ word: string; from: number; to: number }> {
  return [...phrase.matchAll(/\S+/gu)].map((m) => ({ word: m[0], from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));
}

// The shortest prefix of a phrase's words that names exactly one attendee, with its end position: "anh Nam gửi báo giá" is "anh Nam" when exactly one attendee is called Nam.
function ownerPrefix(phrase: string, people: readonly Person[]): { said: string; to: number; userId: string } | null {
  const words = wordSpans(phrase).slice(0, WORDS_MAX);
  for (let n = 1; n <= words.length; n++) {
    const said = phrase.slice(words[0]?.from ?? 0, words[n - 1]?.to ?? 0);
    const found = matchAssignee(said, people, []);
    if (found.kind === 'one') return { said, to: words[n - 1]?.to ?? 0, userId: found.person.userId };
  }
  return null;
}

/**
 * The cues in the lines, in the order they were said, each as one draft item. `people` are the attendees an owner may be matched to and `meetingDay` (YYYY-MM-DD, Vietnam time) the day a said date is read
 * against. At most VOICE_CUES_MAX cues are read. Pure.
 */
export function findVoiceCues(lines: readonly CueLine[], people: readonly Person[], meetingDay: string): FoundCues {
  const cues: VoiceCue[] = [];
  let empty = 0;
  for (let i = 0; i < lines.length && cues.length + empty < VOICE_CUES_MAX; i++) {
    // The text in its composed form, so a mark typed apart from its letter is not a character of its own.
    const line = { seconds: (lines[i] as CueLine).seconds, text: (lines[i] as CueLine).text.normalize('NFC') };
    const folded = fold(line.text);
    const hit = CUE.exec(folded);
    if (!hit) continue;
    const verb = hit[1] as string;
    const remind = verb.startsWith('nhac') || verb.startsWith('remind');
    // What follows the verb, to the end of its sentence, as said and folded (the same length).
    let at = hit.index + hit[0].length;
    let restFolded = folded.slice(at);
    const stop = SENTENCE_END.exec(restFolded);
    if (stop) restFolded = restFolded.slice(0, stop.index);
    let rest = line.text.slice(at, at + restFolded.length);
    // A range taken out of the text is blanked with spaces of the same length in both copies, so every position found before stays valid.
    const take = (from: number, to: number) => {
      const blank = ' '.repeat(to - from);
      rest = `${rest.slice(0, from)}${blank}${rest.slice(to)}`;
      restFolded = `${restFolded.slice(0, from)}${blank}${restFolded.slice(to)}`;
    };
    // The first match of a keyword whose spelling, as said, is one the cue means.
    const keywordMatch = (pattern: RegExp, spellings: ReadonlySet<string>) => {
      // A match runs to the end of its phrase, so the search restarts one character after each start: a keyword inside an earlier match ("chó cho anh Nam") is found as well.
      const re = new RegExp(pattern.source, pattern.flags);
      for (let m = re.exec(restFolded); m !== null; m = re.exec(restFolded)) {
        const at = m.indices?.[1];
        if (at && spellings.has(rest.slice(at[0], at[1]).toLowerCase())) return m;
        re.lastIndex = m.index + 1;
      }
      return null;
    };
    const due = keywordMatch(DUE, DUE_WORDS);
    const dueKeyword = due?.indices?.[1];
    const duePhrase = due?.indices?.[2];
    const owner = keywordMatch(OWNER, OWNER_WORDS);
    const ownerKeyword = owner?.indices?.[1];
    const ownerPhrase = owner?.indices?.[2];
    // Each clause stops where the other starts: "hạn thứ Sáu cho anh Nam" is a date and then an owner, and "cho anh Nam hạn thứ Sáu" an owner and then a date.
    let dueEnd = duePhrase?.[1] ?? 0;
    let ownerEnd = ownerPhrase?.[1] ?? 0;
    if (dueKeyword && ownerKeyword) {
      if (ownerKeyword[0] > dueKeyword[0] && ownerKeyword[0] < dueEnd) dueEnd = ownerKeyword[0];
      if (dueKeyword[0] > ownerKeyword[0] && dueKeyword[0] < ownerEnd) ownerEnd = dueKeyword[0];
    }
    // The due clause: a keyword and a short phrase, read against the meeting's own day.
    let when = '';
    let whenDate: string | null = null;
    if (dueKeyword && duePhrase) {
      const phrase = rest.slice(duePhrase[0], dueEnd).trim();
      const day = parseWhen(phrase, meetingDay);
      if (phrase !== '' && (day !== null || (phrase.split(/\s+/u).length <= WORDS_MAX && DATELIKE.test(fold(phrase))))) {
        when = cut(phrase, ITEM_TEXT_MAX);
        whenDate = day;
        take(dueKeyword[0], dueEnd);
      }
    }
    if (whenDate === null) whenDate = parseWhen(rest, meetingDay);
    // The owner: after "cho", "giao cho" or "for"; or, for a reminder, right after the verb.
    let who = '';
    let whoUserId: string | null = null;
    if (ownerKeyword && ownerPhrase) {
      const phrase = rest.slice(ownerPhrase[0], ownerEnd);
      const matched = ownerPrefix(phrase, people);
      const spans = wordSpans(phrase);
      if (matched) {
        who = matched.said;
        whoUserId = matched.userId;
        take(ownerKeyword[0], ownerPhrase[0] + matched.to);
      } else if (spans.length > 1 && spans.length <= WORDS_MAX - 1 && HONORIFIC.test(restFolded.slice(ownerPhrase[0], ownerPhrase[0] + (spans[0]?.word.length ?? 0)))) {
        // An honorific and a name nobody answers to ("anh Tuấn") is the said name, kept as text for a person to read; "cho khách" is no name and stays in the title.
        who = cut(phrase.trim(), ITEM_TEXT_MAX);
        take(ownerKeyword[0], ownerEnd);
      }
    } else if (remind) {
      const start = restFolded.length - restFolded.trimStart().length;
      const words = wordSpans(rest.slice(start));
      if (words.length > 1 && HONORIFIC.test(restFolded.slice(start, start + (words[0]?.word.length ?? 0)))) {
        const matched = ownerPrefix(rest.slice(start), people);
        if (matched) {
          who = matched.said;
          whoUserId = matched.userId;
          take(start, start + matched.to);
        }
      }
    }
    // The title: what is left, without a lead-in ("rằng", "là", "nhé") and without a bare "việc này" that points at the line before.
    let tail = LEAD_IN.exec(restFolded)?.[0].length ?? 0;
    const pronoun = PRONOUN.exec(restFolded.slice(tail));
    if (pronoun) {
      tail += pronoun[0].length;
      tail += LEAD_IN.exec(restFolded.slice(tail))?.[0].length ?? 0;
    }
    let title = squash(rest.slice(tail));
    if (title === '') {
      const before = lines[i - 1];
      title = before && !isCue(before.text) ? squash(before.text) : '';
    }
    title = cut(title, ITEM_TITLE_MAX);
    if (title === '') {
      empty += 1;
      continue;
    }
    cues.push({ seconds: Math.max(0, Math.floor(line.seconds)), title, who, whoUserId, when, whenDate });
  }
  return { cues, empty };
}

export const voiceCueDraft = defineCommand({
  name: 'meetings.voice_cue.draft',
  input: zVoiceCueDraft,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can draft items from spoken cues');
    // The meeting row is held first, in the order a publish and a re-transcription take it, so the lines read here are not replaced under this click.
    await lockMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const row = await ctx.trx.selectFrom('ludy_meetings.meeting').select(['started_at']).where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirstOrThrow();
    const segments = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select(['stage', sql<string>`start_seconds::text`.as('start_seconds'), 'text'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .execute();
    // The lines the recorder reads: their draft, else what is published (a draft replaces the published lines it was made from, so the two are not read together).
    const stage = segments.some((s) => s.stage === 'draft') ? 'draft' : 'published';
    const lines = segments.filter((s) => s.stage === stage).map((s) => ({ seconds: Number(s.start_seconds), text: s.text }));
    const people = await attendeeNames(ctx, input.meetingId, userId);
    const found = findVoiceCues(lines, people, vnDay(row.started_at ?? new Date()));

    // One item for a cue: a line that already had an item of this kind before this click is not made again (two cues that start in the same second are both made).
    const have = await ctx.trx
      .selectFrom('ludy_meetings.action_item')
      .select('transcript_seconds')
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .where(sql<boolean>`flags @> ${JSON.stringify([VOICE_CUE_FLAG])}::jsonb`)
      .execute();
    const seen = new Set(have.map((r) => r.transcript_seconds));
    const kept = await ctx.trx.selectFrom('ludy_meetings.action_item').select(sql<number>`count(*)::int`.as('n')).where('org_id', '=', ctx.orgId).where('meeting_id', '=', input.meetingId).executeTakeFirstOrThrow();
    let room = Math.max(0, ITEMS_PER_MEETING_MAX - kept.n);
    let created = 0;
    let duplicate = 0;
    let full = 0;
    for (const cue of found.cues) {
      if (seen.has(cue.seconds)) {
        duplicate += 1;
        continue;
      }
      if (room === 0) {
        full += 1;
        continue;
      }
      const flags = [...new Set<string>([...itemFlags(cue.title), VOICE_CUE_FLAG])];
      await ctx.trx
        .insertInto('ludy_meetings.action_item')
        .values({
          org_id: ctx.orgId,
          meeting_id: input.meetingId,
          title: cue.title,
          who_drafted: itemFlags(cue.who).length > 0 ? '' : cue.who,
          who_parsed: cue.whoUserId,
          when_drafted: itemFlags(cue.when).length > 0 ? '' : cue.when,
          when_parsed: cue.whenDate,
          transcript_seconds: cue.seconds,
          stage: 'draft',
          flags: sql`${JSON.stringify(flags)}::jsonb`,
          tainted: true,
        })
        .execute();
      room -= 1;
      created += 1;
    }
    const answer = { meetingId: input.meetingId, found: found.cues.length + found.empty, created, duplicate, empty: found.empty, full };
    ctx.audit({ meetingId: input.meetingId, found: answer.found, created, duplicate, empty: found.empty, full });
    return zVoiceCueDrafted.parse(answer);
  },
});

export const voiceCueCommands = [voiceCueDraft];
