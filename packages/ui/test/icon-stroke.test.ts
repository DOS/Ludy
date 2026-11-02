// SPDX-License-Identifier: AGPL-3.0-only
// Lucide icons draw at stroke 1.5 (DESIGN.md 3.7, #2351), set once at the root of the app by <IconDefaults> and not file by
// file. Spinners and check marks are the named exceptions and name their own, heavier width.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { HEAVY_ICON_STROKE, ICON_STROKE, IconDefaults } from '../src/components/icon-defaults.tsx';
import { Spinner } from '../src/components/spinner.tsx';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const strokeOf = (markup: string) => /stroke-width="([\d.]+)"/.exec(markup)?.[1];

describe('icon stroke', () => {
  it('is 1.5 for an icon that names no width, inside <IconDefaults>', () => {
    expect(ICON_STROKE).toBe(1.5);
    expect(strokeOf(renderToStaticMarkup(createElement(IconDefaults, null, createElement(SearchIcon))))).toBe('1.5');
  });

  it("is lucide's own 2 outside it, so the provider is what makes the default", () => {
    expect(strokeOf(renderToStaticMarkup(createElement(SearchIcon)))).toBe('2');
  });

  it('keeps the spinner heavier, inside the provider too', () => {
    expect(HEAVY_ICON_STROKE).toBeGreaterThan(ICON_STROKE);
    expect(strokeOf(renderToStaticMarkup(createElement(IconDefaults, null, createElement(Spinner))))).toBe(String(HEAVY_ICON_STROKE));
  });

  it('has the loading Button spinner and the checkbox marks name the heavier width', () => {
    for (const file of ['button', 'checkbox']) expect(read(`../src/components/${file}.tsx`), file).toContain('strokeWidth={HEAVY_ICON_STROKE}');
  });

  it('wraps every root of the app in <IconDefaults>', () => {
    const main = read('../../../apps/app/src/main.tsx');
    const roots = main.match(/root\.render\(/g)?.length ?? 0;
    expect(roots).toBeGreaterThanOrEqual(2);
    expect(main.match(/<IconDefaults>/g)?.length).toBe(roots);
  });

  it('has no component that sets the default width by hand where the provider covers it', () => {
    for (const file of ['dialog', 'native-select']) expect(read(`../src/components/${file}.tsx`), file).not.toContain('strokeWidth');
  });
});
