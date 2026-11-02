// SPDX-License-Identifier: AGPL-3.0-only
// The marketing site's lucide icons draw at stroke 1.5 (DESIGN.md 3.7, #2351). Its sections ship no client JavaScript, so the
// default is one stylesheet rule instead of a provider: lucide writes stroke-width="2" on an icon that names no width, and a
// stylesheet rule beats that attribute. An icon that names a width keeps it, as long as it is not 2: that one would be
// pulled to 1.5 too. Check marks are the named exception and name 2.5 or 3.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('icon stroke on the marketing site', () => {
  it('is 1.5 by the stylesheet, for icons that name no width', () => {
    const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/svg\.lucide\[stroke-width='2'\]\s*\{\s*stroke-width: 1\.5;\s*\}/);
  });

  it('has no icon that names the width 2, which the rule would turn into 1.5', () => {
    for (const file of sources(SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/strokeWidth=(\{2(\.0+)?\}|"2(\.0+)?")/);
    }
  });

  it('has every check mark name its own, heavier width', () => {
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<Check\b[^>]*>/g)) {
        expect(match[0], `${file}: a Check without strokeWidth would draw at 1.5`).toMatch(/strokeWidth=\{(2\.5|3)\}/);
      }
    }
  });
});
