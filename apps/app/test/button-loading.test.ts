// SPDX-License-Identifier: AGPL-3.0-only
// A working button says so with `<Button loading>` (DESIGN.md §4.1, #2116): the label and the width stay, the spinner
// is drawn by the button and hidden from assistive tech, and the button says it is busy. A screen's own `<Spinner>`
// as a child of a button grows the button and puts "Loading" in its name, so no source does that, but for the
// Social screens, which are paused (decision D5) and are left as they are until the line reopens.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

// The elements whose children end up inside a button: the button itself, and the dialog triggers that render one
// (`ConfirmDialog`, `DialogTrigger` and `DialogClose` hand their children to the button in `render`), matched by the regular
// expression in `spinnersInButtons`.

// The index just past the `>` that ends the opening tag starting at `from`: attribute values in braces and quotes
// (`onClick={() => go()}`, `title="a > b"`) may hold a `>`, so only one outside both ends the tag.
function openingEnd(text: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || (c === "'" && depth === 0)) quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

// How many Spinners sit in the children of a button-like element of a source.
function spinnersInButtons(path: string): number {
  const text = readFileSync(path, 'utf8');
  let count = 0;
  for (const open of text.matchAll(/<(Button|ConfirmDialog|DialogTrigger|DialogClose)\b/g)) {
    const end = openingEnd(text, open.index + open[0].length);
    if (end < 0 || text.charAt(end - 2) === '/') continue;
    const close = text.indexOf(`</${open[1]}>`, end);
    count += (text.slice(end, close < 0 ? text.length : close).match(/<(?:Spinner\w*|Loader2Icon)\b|animate-spin/g) ?? []).length;
  }
  return count;
}

// Social is paused (decision D5): these screens keep their hand-placed spinners, by file and count, until the line
// reopens and moves them to `loading`. A file that no longer has one must leave this list.
const SOCIAL_SPINNERS: Readonly<Record<string, number>> = {
  'components/social-activity.tsx': 1,
  'components/social-bulk-drafts.tsx': 1,
  'components/social-chat-alert.tsx': 2,
  'components/social-crop.tsx': 1,
  'components/social-image-fix.tsx': 1,
  'components/social-labels.tsx': 1,
  'components/social-media.tsx': 5,
  'components/social-report-branding.tsx': 1,
  'components/social-signature.tsx': 1,
  'components/social-stock-photos.tsx': 3,
  'components/social-suggest.tsx': 2,
  'components/social-text-variations.tsx': 1,
  'components/social-watermark.tsx': 1,
  'routes/social-bio.tsx': 1,
  'routes/social-feeds.tsx': 1,
  'routes/social-ideas.tsx': 3,
  'routes/social-labels.tsx': 1,
  'routes/social-post.tsx': 11,
  'routes/social-snippets.tsx': 1,
  'routes/social.tsx': 2,
};

describe('buttons that are working', () => {
  it('use `loading`, never a Spinner placed in the button; only the paused Social screens are left', () => {
    const counts = Object.fromEntries(
      sources(src)
        .map((path) => [relative(src, path).split(sep).join('/'), spinnersInButtons(path)] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counts).toEqual(SOCIAL_SPINNERS);
    for (const file of Object.keys(counts)) expect(basename(file).startsWith('social')).toBe(true);
  });
});
