// SPDX-License-Identifier: AGPL-3.0-only
// One character class for a chapter title (#3882): the database's CHECK on meeting_chapter (20270117170000), the minutes templates' CHECK it copies (20270109090000), the contract's
// chapterTitleProblem and the AI run's cleanChapterTitle must agree, so a title one of them lets in is never refused by another (a run's chapter that the database would reject, a typed title the
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

describe('the character class of a chapter title (#3882)', () => {
  const chapters = classOf(read('20270117170000_crove_meetings_chapters_run.sql'));
  const templates = classOf(read('20270109090000_crove_meetings_minutes_template.sql'));

  it('is the minutes templates\' class, written once in the same way', () => {
    expect(chapters).not.toBe('');
    expect(chapters).toBe(templates);
  });

  it('is refused by the command at both edges of every range, and stripped by the model path', () => {
    const points = edges(chapters);
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      const title = `a${String.fromCodePoint(point)}b`;
      expect(['multiline', 'control'], `U+${point.toString(16)}`).toContain(chapterTitleProblem(title));
      const cleaned = cleanChapterTitle(title);
      expect(['ab', 'a b'], `U+${point.toString(16)}`).toContain(cleaned);
    }
    // Neighbours just outside the class are fine: a letter with a combining mark, a no-break space between words is folded by the model path.
    for (const outside of ['\u00e1', '\u1ebf', '\u2010', '\u00a0']) {
      expect(chapterTitleProblem(`a${outside}b`), outside).toBeNull();
    }
  });
});
