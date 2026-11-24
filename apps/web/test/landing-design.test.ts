// SPDX-License-Identifier: AGPL-3.0-only
// Landing page visual guardrails (DESIGN.md 3.5, 3.7, 10; #4518): no colored rounded icon tiles above headings
// in AppCards or Story, and no border-line combined with shadow-2xl on the AppShell command palette.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LANDING = join(import.meta.dirname, '..', 'src', 'components', 'landing');

describe('landing component design rules (DESIGN.md 3.5, 3.7, 10)', () => {
  it('renders inline 20px icons beside headings instead of rounded icon tiles in app-cards and story', () => {
    for (const file of ['app-cards.tsx', 'story.tsx']) {
      const source = readFileSync(join(LANDING, file), 'utf8');
      expect(source, file).not.toMatch(/size-(?:11|12)\b[^"]*rounded-xl|rounded-xl[^"]*size-(?:11|12)\b/);
      expect(source, file).not.toContain('size-6');
      expect(source, file).toMatch(/<h3[^>]*>[\s\S]*?<Icon[^>]*className=["{`][^"}]*\bsize-5\b/);
    }
  });

  it('uses shadow-sm instead of shadow-2xl alongside border-line in app-shell', () => {
    const source = readFileSync(join(LANDING, 'app-shell.tsx'), 'utf8');
    expect(source).not.toContain('shadow-2xl');
    expect(source).toContain('border-line bg-surface shadow-sm');
  });
});
