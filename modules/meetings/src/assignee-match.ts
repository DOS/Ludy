// SPDX-License-Identifier: AGPL-3.0-only
// Who an action item's said name points at (#3921), by code and no model. "anh Minh", "chị Lan bên kế toán" and "nguyen van nam" are names a person said in a meeting; this finds the one
// attendee, else the one member of the org, they can mean, or nobody. It only suggests: the person who makes the task confirms it, and nothing is stored here.
import { plainName } from './plain-name.ts';

// Words that come before a name (folded, so "chị" is "chi"): said, not part of the name. Stripped only while another word remains, because "Chi", "Ba" and "Cô" are given names too.
const HONORIFICS = new Set(['anh', 'chi', 'em', 'bac', 'co', 'chu', 'ong', 'ba', 'ban', 'thay', 'cau', 'mo', 'di', 'duong', 'sep', 'anh/chi', 'chi/anh']);
// Words that start a description of the person and not a name ("chị Lan bên kế toán", "anh Nam của team bán hàng"). Words that are given names (Phong, Tú, Trọng) are not here; the cut is
// made only after the first word, so a name that starts with one is kept.
const CONNECTORS = new Set(['ben', 'cua', 'nhom', 'team', 'thuoc']);

/** The words of the name a said text holds: folded, honorifics before it and the description after it dropped. Empty when it holds no name. */
export function saidNameWords(said: string): string[] {
  const words = plainName(said)
    .replace(/[^\p{L}\p{N}/ ]+/gu, ' ')
    .split(' ')
    .filter((w) => w !== '');
  let start = 0;
  while (start < words.length - 1 && HONORIFICS.has(words[start] as string)) start += 1;
  const rest = words.slice(start);
  let end = rest.length;
  for (let i = 1; i < rest.length; i += 1) {
    const w = rest[i] as string;
    if (CONNECTORS.has(w) || (w === 'bo' && rest[i + 1] === 'phan')) {
      end = i;
      break;
    }
  }
  return rest.slice(0, end);
}

// Whether the said words are this person: the whole name, a run of two or more of its words, or the given name (the last word) alone. A family name alone or a middle word alone is not enough.
function answersTo(said: readonly string[], name: string): boolean {
  const words = plainName(name).split(' ').filter((w) => w !== '');
  if (said.length === 0 || words.length === 0) return false;
  if (said.length === 1) return said[0] === words[words.length - 1];
  for (let i = 0; i + said.length <= words.length; i += 1) if (said.every((w, j) => w === words[i + j])) return true;
  return false;
}

export interface Person {
  userId: string;
  name: string;
}
export interface Suggested extends Person {
  source: 'attendee' | 'member';
}

/**
 * The one person a said name belongs to. The attendees are tried first: exactly one hit suggests them, two or more suggest nobody (the org is not tried, so a name that is ambiguous among the people
 * in the room never becomes a guess about someone outside it). With no attendee hit the other members of the org are tried the same way. Nobody when the text holds no name or the answer is not one person.
 */
export function suggestAssignee(said: string, attendees: readonly Person[], members: readonly Person[]): Suggested | null {
  const words = saidNameWords(said);
  if (words.length === 0) return null;
  const inRoom = attendees.filter((p) => answersTo(words, p.name));
  if (inRoom.length > 1) return null;
  if (inRoom.length === 1) return { ...(inRoom[0] as Person), source: 'attendee' };
  const seen = new Set(attendees.map((p) => p.userId));
  const others = members.filter((p) => !seen.has(p.userId) && answersTo(words, p.name));
  return others.length === 1 ? { ...(others[0] as Person), source: 'member' } : null;
}
