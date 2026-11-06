// SPDX-License-Identifier: AGPL-3.0-only
// A hairline border or ring and a wide soft shadow never sit on the same element (DESIGN.md 3.5 and 10, #2351): the border
// or ring defines the surface; a shadow, when there is one, stays as narrow as `shadow-sm`. Read in packages/ui and
// apps/app, per class string and per `cn(...)` call (a call splits its classes across literals), so a floating element that
// gets both again fails here. State variants (`focus-visible:ring-3`, `dark:border-input`, `data-open:shadow-lg`) are not
// part of the resting look and are left out. The marketing site's product mockups (apps/web) are not read.
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

const isWideShadow = (token: string) => /^(drop-)?shadow(-(md|lg|xl|2xl|3xl))?$/.test(token);
const isEdge = (token: string) => /^(border|ring)(-|$)/.test(token) && !/^(border|ring)-(offset|transparent|0$|none)/.test(token);

const literals = (text: string): string[] => [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs)].map((match) => match[2] ?? '');

// The text of every `cn(...)` call, found by balancing parentheses outside string literals.
function cnCalls(source: string): string[] {
  const calls: string[] = [];
  for (let from = source.indexOf('cn('); from >= 0; from = source.indexOf('cn(', from + 3)) {
    let depth = 0;
    let quote = '';
    for (let i = from + 2; i < source.length; i++) {
      const char = source[i] ?? '';
      if (quote) {
        if (char === '\\') i++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth++;
      else if (char === ')' && --depth === 0) {
        calls.push(source.slice(from, i + 1));
        break;
      }
    }
  }
  return calls;
}

function describeBoth(text: string): string | undefined {
  const tokens = text.split(/\s+/).filter((token) => token && !token.includes(':'));
  const shadows = tokens.filter(isWideShadow);
  const edges = tokens.filter(isEdge);
  return shadows.length > 0 && edges.length > 0 ? `${edges.join(' ')} with ${shadows.join(' ')}` : undefined;
}

// What holds both a resting edge and a wide shadow: a string literal, or all the literals of one cn() call.
function offenders(source: string): string[] {
  const found = literals(source).map(describeBoth);
  for (const call of cnCalls(source)) found.push(describeBoth(literals(call).join(' ')));
  return [...new Set(found.filter((hit): hit is string => hit !== undefined))];
}

describe('border or ring with a wide shadow', () => {
  it('is caught by the check', () => {
    expect(offenders('className="rounded-xl border bg-popover shadow-2xl"')).toHaveLength(1);
    expect(offenders('className="rounded-lg ring-1 ring-foreground/10 shadow-lg"')).toHaveLength(1);
    expect(offenders('className="rounded-lg border drop-shadow-md"')).toHaveLength(1);
    expect(offenders("className={cn('rounded border bg-popover', open && 'shadow-lg')}").length).toBeGreaterThan(0);
    expect(offenders("className={cn('rounded border', ['a (b)', 'c'], cond ? 'shadow-md' : '')}").length).toBeGreaterThan(0);
  });

  it('lets the allowed looks through', () => {
    expect(offenders('className="rounded-lg border bg-card shadow-sm"')).toHaveLength(0);
    expect(offenders('className="rounded-xl bg-popover shadow-lg"')).toHaveLength(0);
    expect(offenders('className="rounded-md border-transparent shadow-md focus-visible:ring-3"')).toHaveLength(0);
    expect(offenders("className={cn('rounded border', open && 'data-open:shadow-lg')}")).toHaveLength(0);
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
