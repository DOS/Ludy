// SPDX-License-Identifier: AGPL-3.0-only
// The `proposal` hue (the AI marks: "AI-written", a proposal waiting for approval) reaches 4.5:1 as text on its own badge fill (`bg-proposal/10`, mixed in OKLab by Tailwind) over every surface a badge sits on, in both
// themes (WCAG 1.4.3, #4163). The tokens are read from globals.css, so a later edit of --proposal cannot slip under the floor unseen.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/globals.css', import.meta.url)), 'utf8');

// The declarations of one theme block (`:root` or `.dark`), up to the closing brace at the start of a line.
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const end = css.indexOf('\n}', start + 1);
  const tokens = new Map<string, string>();
  for (const match of css.slice(start, end).matchAll(/^\s+--([\w-]+):\s*([^;]+);/gm)) tokens.set(match[1] ?? '', (match[2] ?? '').trim());
  return tokens;
}

type Lab = [number, number, number];

function parse(value: string): Lab {
  const parts = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!parts) throw new Error(`not a plain oklch() value: ${value}`);
  const hue = (Number(parts[3]) * Math.PI) / 180;
  const chroma = Number(parts[2]);
  return [Number(parts[1]), chroma * Math.cos(hue), chroma * Math.sin(hue)];
}

// OKLab to WCAG relative luminance on the clamped linear sRGB channels (Ottosson's matrices).
function luminance([lightness, a, b]: Lab): number {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const [r, g, bl] = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) => Math.min(1, Math.max(0, c)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
}

function contrast(a: Lab, b: Lab): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The badge's own fill: the hue at 10 % over the surface.
const fillOver = (hue: Lab, surface: Lab): Lab => [0, 1, 2].map((i) => (hue[i] as number) * 0.1 + (surface[i] as number) * 0.9) as Lab;

// The surfaces a badge sits on: the canvas, a card or popover, and the muted fill of a hovered or selected row.
const SURFACES = ['background', 'card', 'popover', 'muted', 'accent'];

describe('the proposal hue as text on its badge (WCAG 1.4.3)', () => {
  it('measures a known pair correctly', () => {
    expect(contrast([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 1);
  });

  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const tokens = block(selector);
    for (const surface of SURFACES) {
      it(`--proposal is at least 4.5:1 on its 10 % fill over --${surface} in ${theme}`, () => {
        const hue = tokens.get('proposal');
        const base = tokens.get(surface);
        if (!hue || !base) throw new Error(`--proposal or --${surface} missing in the ${theme} block`);
        expect(contrast(parse(hue), fillOver(parse(hue), parse(base)))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
