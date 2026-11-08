// SPDX-License-Identifier: AGPL-3.0-only
// Under prefers-reduced-motion the spinner keeps turning, being the only sign that work is running (DESIGN.md 3.6, WCAG
// 2.3.3 essential motion, #2351). The standalone <Spinner> and the spinner of a loading <Button> are separate slots, and
// the second was once left out of the exception, so a busy button showed a frozen ring. Every element that spins must
// name its data-slot in the exception of globals.css.
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/globals.css', import.meta.url)), 'utf8');
const componentsDir = fileURLToPath(new URL('../src/components/', import.meta.url));

// The data-slots in the selector list of the rule, inside the reduced-motion media query, that restarts an infinite
// animation.
function exemptSlots(): string[] {
  const media = css.indexOf('@media (prefers-reduced-motion: reduce)');
  if (media < 0) throw new Error('no reduced-motion block in globals.css');
  const rule = /([^{}]*)\{[^{}]*animation-iteration-count: infinite !important;[^{}]*\}/.exec(css.slice(media));
  if (!rule) throw new Error('no rule that keeps an animation infinite under reduced motion');
  return [...(rule[1] ?? '').matchAll(/\[data-slot='([\w-]+)'\]/g)].map((match) => match[1] ?? '');
}

describe('spinners under reduced motion', () => {
  it('keeps both the standalone spinner and the loading Button spinner turning', () => {
    expect(exemptSlots().sort()).toEqual(['button-spinner', 'spinner']);
  });

  it('has every spinning element of packages/ui in the exception', () => {
    const exempt = new Set(exemptSlots());
    let spinning = 0;
    for (const file of readdirSync(componentsDir).filter((name) => name.endsWith('.tsx'))) {
      for (const line of readFileSync(`${componentsDir}${file}`, 'utf8').split('\n')) {
        if (!line.includes('animate-spin')) continue;
        spinning += 1;
        const slot = /data-slot="([\w-]+)"/.exec(line)?.[1] ?? '';
        expect(exempt.has(slot), `${file} spins as "${slot}", which is not in the reduced-motion exception: ${line.trim()}`).toBe(true);
      }
    }
    expect(spinning).toBeGreaterThanOrEqual(2);
  });
});
