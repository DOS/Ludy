// SPDX-License-Identifier: AGPL-3.0-only
// The meeting page keys several sibling components by the meeting id (so a link to another meeting in place remounts each). The keys must differ from one component to the next: the same key on siblings
// makes React duplicate or drop children on a re-render, and a click on a cited line then showed the agenda card twice (#4066). The AI e2e spec of #4050 checks the page itself; this guards the source.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A key expression written in any spelling of the meeting id (`id`, `${id}` in a template, `String(id)`, `meeting.id`), reduced to what it names, so two siblings spelled differently still collide.
const keyOfId = (expression: string): string => expression.replace(/String\(|\)|[`\s]/g, '').replace(/\$\{([^}]*)\}/g, '$1').replace(/\bmeeting\./g, '');

describe('the meeting page', () => {
  it('gives every component keyed by the meeting id a key of its own', () => {
    const source = readFileSync(new URL('../src/routes/meeting-detail.tsx', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/\bkey=\{((?:[^{}]|\$\{[^}]*\})*)\}/g)].map((m) => m[1] as string).filter((k) => /\bid\b/.test(k)).map(keyOfId);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('catches siblings keyed the same in different spellings', () => {
    expect(keyOfId('id')).toBe(keyOfId('`${id}`'));
    expect(keyOfId('id')).toBe(keyOfId('String(id)'));
    expect(keyOfId('`chapters-${id}`')).not.toBe(keyOfId('`adherence-${id}`'));
  });
});
