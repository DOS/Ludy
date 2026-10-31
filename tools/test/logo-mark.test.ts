// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy mark (four keys that spell L, U, D and y, the y key teal with its acute accent, #2200) is drawn in several
// places that cannot import one another: the app's `Logo`, the landing page's `LudyMark` and the SVG files under
// apps/web/public. This keeps their paths identical, keeps the light and dark colors where DESIGN.md puts them, and
// keeps the older marks (Crove's ring C, the tiles and spark of #2052) out of the sources.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const BRAND = 'apps/web/public/brand';
const pathsOf = (text: string): { attrs: string; d: string }[] =>
  [...text.matchAll(/<path ([^>]*?)d="([^"]+)"\/>/g)].map((m) => ({ attrs: m[1] ?? '', d: m[2] ?? '' }));

// The seven paths of the reference mark, in drawing order: the lips of the three violet keys and of the y key, their
// faces, then the strokes of the letters L U D, of the y and of its accent.
const ROLES = ['lips', 'lipY', 'keys', 'keyY', 'lud', 'y', 'accent'] as const;
type Role = (typeof ROLES)[number];
const reference = pathsOf(read(`${BRAND}/ludy-mark.svg`));
const PATH = Object.fromEntries(ROLES.map((role, i) => [role, reference[i]?.d ?? ''])) as Record<Role, string>;

// DESIGN.md 1.2: `v` and `t` are the faces of the violet keys and of the teal y key, `vl` and `tl` their lips, `ink` the
// letters L U D, `tInk` the y and its accent, `word` the "Lud" of the wordmark (its y takes `t`).
type Palette = Record<'v' | 'vl' | 't' | 'tl' | 'ink' | 'tInk' | 'word', string>;
const COLORS: Record<'light' | 'dark', Palette> = {
  light: { v: '#612BD3', vl: '#44209A', t: '#0F8F7A', tl: '#0A6A5B', ink: '#FFFFFF', tInk: '#FFFFFF', word: '#17141F' },
  dark: { v: '#7C4DEB', vl: '#5A33B5', t: '#3FD0B0', tl: '#2A9C82', ink: '#FFFFFF', tInk: '#0E2A25', word: '#F4F3F8' },
};
const fill = (color: string, d: string) => `<path fill="${color}" d="${d}"/>`;
const stroke = (color: string, width: number, d: string) =>
  `<path fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
const markPaths = (c: Palette) => [
  fill(c.vl, PATH.lips),
  fill(c.tl, PATH.lipY),
  fill(c.v, PATH.keys),
  fill(c.t, PATH.keyY),
  stroke(c.ink, 7, PATH.lud),
  stroke(c.tInk, 6.4, PATH.y),
  stroke(c.tInk, 5.4, PATH.accent),
];

// Every file that draws the whole mark, and the two favicons that draw the keys alone (a tab is 16 px, too small for letters).
const DRAWS_THE_MARK = [
  'apps/app/src/components/ui.tsx',
  'apps/web/src/components/landing/ui.tsx',
  `${BRAND}/ludy-mark.svg`,
  `${BRAND}/ludy-mark-dark.svg`,
  `${BRAND}/ludy-wordmark.svg`,
  `${BRAND}/ludy-wordmark-dark.svg`,
];
const DRAWS_THE_KEYS = ['apps/web/public/favicon.svg', 'apps/app/public/favicon.svg'];

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(tsx?|css|svg|html|webmanifest)$/.test(name) ? [path] : [];
  });
}

describe('the Ludy logo (#2200)', () => {
  it('has the same keys, letters and accent in every file that draws it', () => {
    expect(reference).toHaveLength(ROLES.length);
    expect(PATH.lips).toMatch(/^M0 15/);
    expect(PATH.keys).toMatch(/^M0 11/);
    expect(PATH.accent).toMatch(/^M72\.9 58\.6/);
    for (const file of DRAWS_THE_MARK) {
      const text = read(file);
      for (const role of ROLES) expect(text, `${file}: ${role}`).toContain(PATH[role]);
    }
    for (const file of DRAWS_THE_KEYS) {
      const text = read(file);
      for (const role of ['lips', 'lipY', 'keys', 'keyY'] as const) expect(text, `${file}: ${role}`).toContain(PATH[role]);
    }
  });

  it('takes the key and letter colors of DESIGN.md in the light and the dark files', () => {
    for (const [file, scheme] of [
      ['ludy-mark.svg', 'light'],
      ['ludy-wordmark.svg', 'light'],
      ['ludy-mark-dark.svg', 'dark'],
      ['ludy-wordmark-dark.svg', 'dark'],
    ] as const) {
      const text = read(`${BRAND}/${file}`);
      for (const path of markPaths(COLORS[scheme])) expect(text, file).toContain(path);
    }
  });

  it('draws the favicon keys in the same colors, and in the dark ones when the browser is dark', () => {
    const classes = (c: Palette) => `.v{fill:${c.v}}.vl{fill:${c.vl}}.t{fill:${c.t}}.tl{fill:${c.tl}}`;
    const text = read('apps/web/public/favicon.svg');
    expect(text).toContain(`<style>${classes(COLORS.light)}@media (prefers-color-scheme:dark){${classes(COLORS.dark)}}</style>`);
    expect(text).not.toContain('stroke=');
  });

  it('letters "Ludy" the same in the light and the dark wordmark, the y in the teal of the y key, in a box as high as the mark (#2059)', () => {
    const wordmark = (file: string, scheme: 'light' | 'dark') => {
      const text = read(`${BRAND}/${file}`);
      const lettering = pathsOf(text).slice(ROLES.length);
      expect(lettering.map((p) => p.attrs.trim()), file).toEqual([`fill="${COLORS[scheme].word}"`, `fill="${COLORS[scheme].t}"`]);
      return { lettering: lettering.map((p) => p.d), box: /viewBox="(0 0 \d+ \d+)"/.exec(text)?.[1] };
    };
    const light = wordmark('ludy-wordmark.svg', 'light');
    const dark = wordmark('ludy-wordmark-dark.svg', 'dark');
    expect(light.lettering).toHaveLength(2);
    for (const d of light.lettering) expect(d).toMatch(/^M\d/);
    expect(dark).toEqual(light);
    expect(light.box).toMatch(/^0 0 \d+ 92$/);
    // The lettering stays inside the box. Every command of a path (M, L, Q) has absolute coordinate pairs, so the numbers
    // alternate x, y.
    const [, width] = /^0 0 (\d+) /.exec(light.box ?? '') ?? [];
    for (const d of light.lettering) {
      const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(Math.max(...numbers.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(Number(width));
      expect(Math.max(...numbers.filter((_, i) => i % 2 === 1))).toBeLessThanOrEqual(92);
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    }
  });

  it('serves one Apple touch icon from the landing page and the app, a full white square with no alpha (#2059)', () => {
    const appIcon = readFileSync(join(ROOT, 'apps/app/public/assets/icon-maskable-512.png'));
    expect(appIcon.equals(readFileSync(join(ROOT, `${BRAND}/apple-touch-icon.png`)))).toBe(true);
    // PNG color type 2 is RGB: iOS fills the transparent corners of an icon with black.
    expect(appIcon[25]).toBe(2);
  });

  it('serves one favicon from the landing page and the app', () => {
    expect(read('apps/app/public/favicon.svg')).toBe(read('apps/web/public/favicon.svg'));
  });

  it('defines the same brand tokens, light and dark, in the app theme and the landing page theme', () => {
    const tokens = (path: string) => [...read(path).matchAll(/^\s*--(brand[a-z-]*):\s*([^;]+);/gm)].map((m) => `${m[1]}: ${m[2]}`);
    const app = tokens('packages/ui/src/styles/globals.css');
    // Six tokens in the light theme and the same six in the dark one.
    expect(app).toHaveLength(12);
    expect(tokens('apps/web/src/app/globals.css')).toEqual(app);
  });

  it('no longer draws the Crove mark (a ring C with two sparkles) or the tiles and spark of #2052', () => {
    const older = ['M141.5 33.7', 'M71 0C73.27 15.5'];
    const offenders = ['apps/app/src', 'apps/app/public', 'apps/web/src', 'apps/web/public', 'packages/ui/src']
      .flatMap(sources)
      .filter((file) => older.some((d) => read(file).includes(d)));
    expect(offenders).toEqual([]);
  });
});
