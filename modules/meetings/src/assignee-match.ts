// SPDX-License-Identifier: AGPL-3.0-only
// Who an action item's said name points at (#3921), by code and no model. "anh Minh", "chị Lan bên kế toán" and "nguyen van nam" are names a person said in a meeting; this finds the one
// attendee, else the one member of the org, they can mean, or nobody. It only suggests: the person who makes the task confirms it, and nothing is stored here.
import { plainName } from './plain-name.ts';

// Words that come before a name, as said ("chị") and folded ("chi"). A word written with marks must be the exact form ("Chí" and "Dương" are names, not "chị" and "dượng"); a word written with no marks
// is compared folded, because that is how many people type. A text that is only one of them ("chị", "anh") names no one: it is a pronoun, and Anh and Chi are given names too.
// Exported so that a test in the kernel app, which sees this module and the agent package, pins this list and ASSIGNEE_CONNECTORS as equal to the folded copies in the agent's naming check (#4089).
export const ASSIGNEE_HONORIFICS: readonly string[] = ['anh', 'chị', 'em', 'bác', 'cô', 'chú', 'ông', 'bà', 'bạn', 'thầy', 'cậu', 'mợ', 'dì', 'dượng', 'sếp', 'anh/chị', 'chị/anh'];
const HONORIFICS_PLAIN = new Set(ASSIGNEE_HONORIFICS.map(plainName));
const HONORIFICS_EXACT = new Set(ASSIGNEE_HONORIFICS);
// Words that start a description of the person and not a name ("chị Lan bên kế toán", "anh Nam của team bán hàng"). Words that are given names (Phong, Tú, Trọng) are not here; the cut is
// made only after the first word, so a name that starts with one is kept.
export const ASSIGNEE_CONNECTORS: readonly string[] = ['ben', 'cua', 'nhom', 'team', 'thuoc'];
const CONNECTOR_SET = new Set(ASSIGNEE_CONNECTORS);

/** One word of a name: as written (lower case, composed) and folded. It is compared exactly when it was written with marks, folded otherwise. */
interface Word {
  exact: string;
  plain: string;
  marked: boolean;
}

function wordsOf(text: string): Word[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/ ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((exact) => {
      const plain = plainName(exact);
      return { exact, plain, marked: plain !== exact };
    });
}
const same = (said: Word, name: Word) => (said.marked ? said.exact === name.exact : said.plain === name.plain);
const isHonorific = (w: Word) => (w.marked ? HONORIFICS_EXACT.has(w.exact) : HONORIFICS_PLAIN.has(w.plain));

/** The words of the name a said text holds: honorifics before it and the description after it dropped. Empty when it holds no name. */
export function saidNameWords(said: string): string[] {
  return nameWords(said).map((w) => w.exact);
}
function nameWords(said: string): Word[] {
  const words = wordsOf(said);
  if (words.length === 1 && isHonorific(words[0] as Word)) return [];
  let start = 0;
  while (start < words.length - 1 && isHonorific(words[start] as Word)) start += 1;
  const rest = words.slice(start);
  let end = rest.length;
  for (let i = 1; i < rest.length; i += 1) {
    const w = (rest[i] as Word).plain;
    if (CONNECTOR_SET.has(w) || (w === 'bo' && (rest[i + 1] as Word | undefined)?.plain === 'phan')) {
      end = i;
      break;
    }
  }
  return rest.slice(0, end);
}

// The name a display name holds: what comes before a bracket, a dash or a comma ("Nguyễn Văn Nam - Kế toán" is Nam, not Toán), in the same words as a said text.
function personWords(name: string): Word[] {
  return wordsOf(name.split(/[([|,]| [-\u2013\u2014] /)[0] as string);
}

// Whether the said words are this person: the whole name, a run of two or more words that ends with the given name (the last word), or the given name alone. A family name alone, a middle word alone and
// a run that leaves out the given name ("Trần Văn") are not enough.
function answersTo(said: readonly Word[], name: string): boolean {
  const words = personWords(name);
  if (said.length === 0 || words.length < said.length) return false;
  const tail = words.slice(words.length - said.length);
  return said.every((w, i) => same(w, tail[i] as Word));
}

export interface Person {
  userId: string;
  name: string;
}
export interface Suggested extends Person {
  source: 'attendee' | 'member';
}

/** What the code finds for a said name: one person, `ambiguous` (two or more answer to it), `none` (nobody does), or `no_name` (the text holds no name, as a bare "anh" does). */
export type Match = { kind: 'one'; person: Suggested } | { kind: 'ambiguous' } | { kind: 'none' } | { kind: 'no_name' };

/**
 * The people a said name may belong to. The attendees are tried first: exactly one hit is that person, two or more are `ambiguous` (the org is not tried, so a name that is ambiguous among the people in
 * the room never becomes a guess about someone outside it). With no attendee hit the other members of the org are tried the same way.
 */
export function matchAssignee(said: string, attendees: readonly Person[], members: readonly Person[]): Match {
  const words = nameWords(said);
  if (words.length === 0) return { kind: 'no_name' };
  const inRoom = attendees.filter((p) => answersTo(words, p.name));
  if (inRoom.length > 1) return { kind: 'ambiguous' };
  if (inRoom.length === 1) return { kind: 'one', person: { ...(inRoom[0] as Person), source: 'attendee' } };
  const seen = new Set(attendees.map((p) => p.userId));
  const others = members.filter((p) => !seen.has(p.userId) && answersTo(words, p.name));
  if (others.length > 1) return { kind: 'ambiguous' };
  return others.length === 1 ? { kind: 'one', person: { ...(others[0] as Person), source: 'member' } } : { kind: 'none' };
}

/** The one person a said name belongs to, or nobody (no name, no hit, or more than one). */
export function suggestAssignee(said: string, attendees: readonly Person[], members: readonly Person[]): Suggested | null {
  const found = matchAssignee(said, attendees, members);
  return found.kind === 'one' ? found.person : null;
}
