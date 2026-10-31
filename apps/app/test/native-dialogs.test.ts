// SPDX-License-Identifier: AGPL-3.0-only
// Decisions that block go through the app's Dialog, not the browser's (DESIGN.md §4.5, #1512, #2117): `window.confirm`,
// `window.prompt` and `window.alert` are unthemed, speak the browser's language, cannot name the outcome and return
// false once a browser suppresses them. `ConfirmDialog` is the way to ask. The Social screens are paused (decision D5)
// and keep their calls, by file and count, until the line reopens and moves them; a file that no longer has one must
// leave this list, and no other file may add one.
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

const NATIVE_DIALOG = /\bwindow\.(?:confirm|prompt|alert)\(/g;

const SOCIAL_NATIVE_DIALOGS: Readonly<Record<string, number>> = {
  'components/social-bulk.tsx': 3,
  'components/social-calendar-feed.tsx': 2,
  'components/social-report-schedules.tsx': 1,
  'components/social-review-links.tsx': 2,
  'components/social-saved-views.tsx': 1,
  'routes/social-feeds.tsx': 1,
  'routes/social-labels.tsx': 1,
  'routes/social-post.tsx': 3,
  'routes/social-snippets.tsx': 1,
};

describe('the browser dialogs', () => {
  it('are not used to ask or tell; only the paused Social screens still call them', () => {
    const counts = Object.fromEntries(
      sources(src)
        .map((path) => [relative(src, path).split(sep).join('/'), readFileSync(path, 'utf8').match(NATIVE_DIALOG)?.length ?? 0] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counts).toEqual(SOCIAL_NATIVE_DIALOGS);
  });
});
