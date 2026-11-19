// SPDX-License-Identifier: AGPL-3.0-only
// The meeting page keys several sibling components by the meeting id (so a link to another meeting in place remounts each). The keys must differ from one component to the next: the same key on siblings
// makes React duplicate or drop children on a re-render, and a click on a cited line then showed the agenda card twice (#4066). The AI e2e spec of #4050 checks the page itself; this guards the source.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the meeting page', () => {
  it('gives every component keyed by the meeting id a key of its own', () => {
    const source = readFileSync(new URL('../src/routes/meeting-detail.tsx', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/\bkey=\{([^}]*\$\{id\}[^}]*|id)\}/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
