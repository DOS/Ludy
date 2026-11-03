// SPDX-License-Identifier: AGPL-3.0-only
// Decisions that block go through the app's Dialog, not the browser's (DESIGN.md §4.5, #1512, #2117): `window.confirm`,
// `window.prompt` and `window.alert` are unthemed, speak the browser's language, cannot name the outcome and return
// false once a browser suppresses them. `ConfirmDialog` is the way to ask (and `LeavePageDialog` for a router that blocks
// a navigation); no file may call them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const NATIVE_DIALOG = /\b(?:window|globalThis)\s*\??\.\s*(?:confirm|prompt|alert)\s*\(/g;

describe('the browser dialogs', () => {
  it('are not used to ask or tell, anywhere in the app', () => {
    const counts = Object.fromEntries(
      sources(src)
        .map((path) => [relative(src, path).split(sep).join('/'), readFileSync(path, 'utf8').match(NATIVE_DIALOG)?.length ?? 0] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counts).toEqual({});
  });
});
