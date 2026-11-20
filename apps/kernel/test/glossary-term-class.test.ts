// SPDX-License-Identifier: AGPL-3.0-only
// Pin the glossary term's invisible-character class (#4137 point 2b): the SQL regex in 20270124150000_crove_meetings_glossary_invisible_chars.sql (glossary_term_ok, scrub_glossary_term, and the
// scrub WHERE clause) must match the widened class from 20270122120000 and equal INVISIBLE_PATTERN (for all non-NUL code points: PostgreSQL text cannot store U+0000). Pure file and function checks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVISIBLE_PATTERN, glossaryTermProblem, zGlossaryAdd } from '@crove/kernel-contract';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${name}`, import.meta.url)), 'utf8');
const CLASS = /'(\[\\u0001-[^']*\])'/g;
const classesOf = (sql: string): string[] => [...sql.matchAll(CLASS)].map((m) => m[1] as string);

function edges(cls: string): number[] {
  const points: number[] = [];
  for (const part of cls.slice(1, -1).match(/\\U[0-9a-f]{8}-\\U[0-9a-f]{8}|\\u[0-9a-f]{4}-\\u[0-9a-f]{4}|\\U[0-9a-f]{8}|\\u[0-9a-f]{4}/g) ?? []) {
    for (const hex of part.split('-')) points.push(Number.parseInt(hex.slice(2), 16));
  }
  return points;
}

function members(cls: string): Set<number> {
  const set = new Set<number>();
  for (const part of cls.slice(1, -1).match(/\\U[0-9a-f]{8}-\\U[0-9a-f]{8}|\\u[0-9a-f]{4}-\\u[0-9a-f]{4}|\\U[0-9a-f]{8}|\\u[0-9a-f]{4}/g) ?? []) {
    const [from, to] = part.split('-').map((hex) => Number.parseInt(hex.slice(2), 16)) as [number, number | undefined];
    for (let point = from; point <= (to ?? from); point += 1) set.add(point);
  }
  return set;
}

describe('the character class of a glossary term (#4137 point 2b)', () => {
  const templateWidened = classesOf(read('20270122120000_crove_meetings_invisible_chars_widen.sql'));
  const glossaryWidened = classesOf(read('20270124150000_crove_meetings_glossary_invisible_chars.sql'));

  it('spells the exact same widened class everywhere in the glossary migration as 20270122120000', () => {
    expect(glossaryWidened.length).toBeGreaterThanOrEqual(3);
    expect(new Set(glossaryWidened).size).toBe(1);
    expect(glossaryWidened[0]).toBe(templateWidened[0]);
  });

  it('pins every non-NUL code point in the SQL class against INVISIBLE_PATTERN', () => {
    const sqlPoints = members(glossaryWidened[0] as string);
    const tsInvisible = new RegExp(`^${INVISIBLE_PATTERN}$`, 'u');
    expect(tsInvisible.test('\u0000')).toBe(true);
    expect(sqlPoints.has(0)).toBe(false);
    const mismatches: string[] = [];
    for (let point = 1; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const inSql = sqlPoints.has(point);
      const inTs = tsInvisible.test(String.fromCodePoint(point));
      if (inSql !== inTs) mismatches.push(`U+${point.toString(16)}(sql=${inSql},ts=${inTs})`);
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses every range edge directly in glossaryTermProblem and strips it on parse', () => {
    const points = edges(glossaryWidened[0] as string);
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      const ch = String.fromCodePoint(point);
      const label = `U+${point.toString(16)}`;
      expect(glossaryTermProblem(`a${ch}b`), label).toMatch(/invisible|control/);
      const parsed = zGlossaryAdd.safeParse({ term: `a${ch}b` });
      expect(parsed.success, label).toBe(true);
      if (parsed.success) expect(parsed.data.term, label).toBe('a b');
      expect(zGlossaryAdd.safeParse({ term: ch }).success, `only ${label}`).toBe(false);
    }
    for (const outside of ['\u00e1', '\u1ebf', '\u2010', '\u00a0', '\u2070', '\uffa1', '\u{1d172}', '\u{1d17b}', '\ufe0f']) {
      expect(glossaryTermProblem(`a${outside}b`), outside).toBeNull();
      expect(zGlossaryAdd.safeParse({ term: `a${outside}b` }).success, outside).toBe(true);
    }
  });
});
