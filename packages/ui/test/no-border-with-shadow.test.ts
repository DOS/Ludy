// SPDX-License-Identifier: AGPL-3.0-only
// A hairline border or ring and a wide soft shadow never sit on the same element (DESIGN.md 3.5 and 10, #2351): the border
// or ring defines the surface; a shadow, when there is one, stays as narrow as `shadow-sm`. Read per class string in
// packages/ui and apps/app, so a floating element that gets both again fails here. State variants (`focus-visible:ring-3`,
// `dark:border-input`) are not part of the resting look and are left out.
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'messages' ? [] : sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const isWideShadow = (token: string) => /^shadow(-(md|lg|xl|2xl|3xl))?$/.test(token);
const isEdge = (token: string) => /^(border|ring)(-|$)/.test(token) && !/^(border|ring)-(offset|transparent|0$|none)/.test(token);

// The string literals of a source file that hold both a resting edge and a wide shadow, as a description.
function offenders(source: string): string[] {
  const found: string[] = [];
  for (const literal of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs)) {
    const tokens = (literal[2] ?? '').split(/\s+/).filter((token) => token && !token.includes(':'));
    const shadows = tokens.filter(isWideShadow);
    const edges = tokens.filter(isEdge);
    if (shadows.length > 0 && edges.length > 0) found.push(`${edges.join(' ')} with ${shadows.join(' ')}`);
  }
  return found;
}

describe('border or ring with a wide shadow', () => {
  it('is caught by the check', () => {
    expect(offenders('className="rounded-xl border bg-popover shadow-2xl"')).toHaveLength(1);
    expect(offenders('className="rounded-lg ring-1 ring-foreground/10 shadow-lg"')).toHaveLength(1);
    expect(offenders('className="rounded-lg border bg-card shadow-sm"')).toHaveLength(0);
    expect(offenders('className="rounded-xl bg-popover shadow-lg"')).toHaveLength(0);
    expect(offenders('className="rounded-md border-transparent shadow-md focus-visible:ring-3"')).toHaveLength(0);
  });

  it('is in no component of packages/ui or apps/app', () => {
    const all: string[] = [];
    for (const dir of ['packages/ui/src', 'apps/app/src']) {
      for (const file of sources(join(ROOT, dir))) {
        for (const hit of offenders(readFileSync(file, 'utf8'))) all.push(`${file.slice(ROOT.length)}: ${hit}`);
      }
    }
    expect(all).toEqual([]);
  });
});
