// SPDX-License-Identifier: AGPL-3.0-only
// One character class for a chapter title (#3882): the database's CHECK on meeting_chapter (20270117210000), the minutes templates' CHECK it copies (20270109090000), the contract's
// chapterTitleProblem and the AI run's cleanChapterTitle must agree, and since #4137 the class is the one that 20270122100000 widened (the four ranges the first one missed), so a title one of them lets in is never refused by another (a run's chapter that the database would reject, a typed title the
// model path would strip). Pure file and function checks: no database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chapterTitleProblem } from '@crove/kernel-contract';
import { cleanChapterTitle } from '@crove/agent/member-vy';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${name}`, import.meta.url)), 'utf8');
const CLASS = /'(\[\\u0001-[^']*\])'/;
const classOf = (sql: string): string => CLASS.exec(sql)?.[1] ?? '';

// The code points of a class written in SQL escapes: the first and the last of each range, which is where a class goes wrong.
function edges(cls: string): number[] {
  const points: number[] = [];
  for (const part of cls.slice(1, -1).match(/\\U[0-9a-f]{8}-\\U[0-9a-f]{8}|\\u[0-9a-f]{4}-\\u[0-9a-f]{4}|\\U[0-9a-f]{8}|\\u[0-9a-f]{4}/g) ?? []) {
    for (const hex of part.split('-')) points.push(Number.parseInt(hex.slice(2), 16));
  }
  return points;
}

// Every code point a class written in SQL escapes holds.
function members(cls: string): Set<number> {
  const set = new Set<number>();
  for (const part of cls.slice(1, -1).match(/\\U[0-9a-f]{8}-\\U[0-9a-f]{8}|\\u[0-9a-f]{4}-\\u[0-9a-f]{4}|\\U[0-9a-f]{8}|\\u[0-9a-f]{4}/g) ?? []) {
    const [from, to] = part.split('-').map((hex) => Number.parseInt(hex.slice(2), 16)) as [number, number | undefined];
    for (let point = from; point <= (to ?? from); point += 1) set.add(point);
  }
  return set;
}

// Every spelling of the class in a migration file, in the order of the file.
const classesOf = (sql: string): string[] => [...sql.matchAll(new RegExp(CLASS.source, 'g'))].map((m) => m[1] as string);

describe('the character class of a chapter title (#3882)', () => {
  const chapters = classOf(read('20270117210000_crove_meetings_chapters_run.sql'));
  const templates = classOf(read('20270109090000_crove_meetings_minutes_template.sql'));
  const widened = classesOf(read('20270122100000_crove_meetings_invisible_chars_widen.sql'));

  it('is the minutes templates\' class, written once in the same way', () => {
    expect(chapters).not.toBe('');
    expect(chapters).toBe(templates);
  });

  it('is spelled the same way everywhere in the widening migration (the function, the scrub and both CHECKs)', () => {
    expect(widened.length).toBeGreaterThanOrEqual(6);
    expect(new Set(widened).size).toBe(1);
  });

  it('is the old class and exactly the four ranges it missed (#4137)', () => {
    const old = members(chapters);
    const now = members(widened[0] as string);
    for (const point of old) expect(now.has(point), `U+${point.toString(16)}`).toBe(true);
    const added = [...now].filter((point) => !old.has(point)).sort((x, y) => x - y);
    const expected: number[] = [];
    for (const [from, to] of [[0x180b, 0x180d], [0x206a, 0x206f], [0xffa0, 0xffa0], [0x1d173, 0x1d17a]] as const) for (let point = from; point <= to; point += 1) expected.push(point);
    expect(added).toEqual(expected);
  });

  it('is refused by the command at both edges of every range, and stripped by the model path', () => {
    const points = edges(widened[0] as string);
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      const title = `a${String.fromCodePoint(point)}b`;
      expect(['multiline', 'control'], `U+${point.toString(16)}`).toContain(chapterTitleProblem(title));
      const cleaned = cleanChapterTitle(title);
      expect(['ab', 'a b'], `U+${point.toString(16)}`).toContain(cleaned);
    }
    // Neighbours just outside the class are fine: a letter with a combining mark, a no-break space between words is folded by the model path.
    for (const outside of ['\u00e1', '\u1ebf', '\u2010', '\u00a0', '\u2070', '\uffa1', '\u{1d172}', '\u{1d17b}', '\ufe0f']) {
      expect(chapterTitleProblem(`a${outside}b`), outside).toBeNull();
    }
  });
});
