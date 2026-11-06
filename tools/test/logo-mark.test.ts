// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy mark (four keys that spell L, U, D and Y, the Y key teal, #2200, #2293) is drawn in several
// places that cannot import one another: the app's `Logo`, the landing page's `LudyMark` and the SVG files under
// apps/web/public. This keeps their paths identical, keeps the light and dark colors where DESIGN.md puts them, and
// keeps the older marks (Crove's ring C, the tiles and spark of #2052, the accented y of #2200) out of the sources.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const BRAND = 'apps/web/public/brand';
const pathsOf = (text: string): { attrs: string; d: string }[] =>
  [...text.matchAll(/<path ([^>]*?)d="([^"]+)"\/>/g)].map((m) => ({ attrs: m[1] ?? '', d: m[2] ?? '' }));

// The six paths of the reference mark, in drawing order: the lips of the three violet keys and of the Y key, their
// faces, then the strokes of the letters L U D and of the Y.
const ROLES = ['lips', 'lipY', 'keys', 'keyY', 'lud', 'y'] as const;
type Role = (typeof ROLES)[number];
const reference = pathsOf(read(`${BRAND}/ludy-mark.svg`));
const PATH = Object.fromEntries(ROLES.map((role, i) => [role, reference[i]?.d ?? ''])) as Record<Role, string>;

// DESIGN.md 1.2: `v` and `t` are the faces of the violet keys and of the teal Y key, `vl` and `tl` their lips, `ink` the
// letters L U D, `tInk` the Y, `word` the "Lud" of the wordmark (its y takes `t`).
type Palette = Record<'v' | 'vl' | 't' | 'tl' | 'ink' | 'tInk' | 'word', string>;
const COLORS: Record<'light' | 'dark', Palette> = {
  light: { v: '#612BD3', vl: '#44209A', t: '#0F8F7A', tl: '#0A6A5B', ink: '#FFFFFF', tInk: '#FFFFFF', word: '#17141F' },
  dark: { v: '#7C4DEB', vl: '#5A33B5', t: '#13A58A', tl: '#0B7563', ink: '#FFFFFF', tInk: '#FFFFFF', word: '#F4F3F8' },
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
  stroke(c.tInk, 7, PATH.y),
];

// An sRGB hex color as OKLCH, to compare the stylesheets' tokens with the hex colors of DESIGN.md.
function oklch(hex: string): [number, number, number] {
  const linear = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [linear(1), linear(3), linear(5)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, bb), hue < 0 ? hue + 360 : hue];
}

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

describe('the Ludy logo (#2200, #2293)', () => {
  it('has the same keys and letters in every file that draws it', () => {
    expect(reference).toHaveLength(ROLES.length);
    expect(PATH.lips).toMatch(/^M0 15/);
    expect(PATH.keys).toMatch(/^M0 11/);
    // The capital Y: two arms that meet just below the centre of its key, then the stem.
    expect(PATH.y).toBe('M61.95 57.1L70.5 69.1L79.05 57.1M70.5 69.1V79.9');
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

  it('gives each path of the components and of the favicon the token or class of its role', () => {
    const jsx = (className: string, d: string, width?: number) =>
      width === undefined
        ? `<path className="${className}" d="${d}" />`
        : `<path className="${className}" strokeWidth="${width}" strokeLinecap="round" strokeLinejoin="round" d="${d}" />`;
    const elements = [
      jsx('fill-brand-lip', PATH.lips),
      jsx('fill-brand-spark-lip', PATH.lipY),
      jsx('fill-brand', PATH.keys),
      jsx('fill-brand-spark', PATH.keyY),
      jsx('fill-none stroke-brand-ink', PATH.lud, 7),
      jsx('fill-none stroke-brand-spark-ink', PATH.y, 7),
    ];
    for (const file of ['apps/app/src/components/ui.tsx', 'apps/web/src/components/landing/ui.tsx']) {
      const text = read(file);
      for (const element of elements) expect(text, file).toContain(element);
    }
    const favicon = read('apps/web/public/favicon.svg');
    for (const [className, role] of [['vl', 'lips'], ['tl', 'lipY'], ['v', 'keys'], ['t', 'keyY']] as const) {
      expect(favicon, className).toContain(`<path class="${className}" d="${PATH[role]}"/>`);
    }
  });

  it('has the hex colors of DESIGN.md as the OKLCH tokens, in the light and the dark theme', () => {
    const roles = { brand: 'v', 'brand-lip': 'vl', 'brand-ink': 'ink', 'brand-spark': 't', 'brand-spark-lip': 'tl', 'brand-spark-ink': 'tInk' } as const;
    const css = read('packages/ui/src/styles/globals.css');
    for (const [token, role] of Object.entries(roles)) {
      // The light value comes first in the file, the dark one second.
      const values = [...css.matchAll(new RegExp(`^\\s*--${token}:\\s*oklch\\(([^)]+)\\);`, 'gm'))].map((m) => (m[1] ?? '').trim().split(/\s+/).map(Number));
      expect(values, token).toHaveLength(2);
      (['light', 'dark'] as const).forEach((scheme, i) => {
        const [l, c, h] = oklch(COLORS[scheme][role]);
        const [tl = NaN, tc = NaN, th = NaN] = values[i] ?? [];
        expect(Math.abs(tl - l), `${token} ${scheme} lightness`).toBeLessThan(0.002);
        expect(Math.abs(tc - c), `${token} ${scheme} chroma`).toBeLessThan(0.002);
        // The hue means nothing for a color without chroma (white).
        if (c > 0.02) expect(Math.abs(((th - h + 540) % 360) - 180), `${token} ${scheme} hue`).toBeLessThan(0.3);
      });
    }
  });

  it('letters "Ludy" the same in the light and the dark wordmark, the y in the teal of the Y key, in a box as high as the mark (#2059)', () => {
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

  it('no longer draws the Crove mark (a ring C with two sparkles), the tiles and spark of #2052 or the accented y of #2200', () => {
    const older = ['M141.5 33.7', 'M71 0C73.27 15.5', 'M61.99 64.05', 'M71.95 59.96'];
    const offenders = ['apps/app/src', 'apps/app/public', 'apps/web/src', 'apps/web/public', 'packages/ui/src']
      .flatMap(sources)
      .filter((file) => older.some((d) => read(file).includes(d)));
    expect(offenders).toEqual([]);
  });
});
