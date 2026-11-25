// SPDX-License-Identifier: AGPL-3.0-only
// The token of the shared minutes page follows the address's hash (#4822), as the quote page's does: shaped like a token or none, and a hash-only change in the same tab reaches the page.
// This app's unit tests run without a DOM, so the window is a small stand-in with the one event.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { minutesTokenOfHash, subscribeToHash } from '../src/lib/minutes-hash.ts';

const A = 'a'.repeat(43);
const B = 'b-_'.repeat(14) + 'b';

interface FakeWindow {
  location: { hash: string };
  handlers: Map<string, Set<() => void>>;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

function fakeWindow(hash: string): FakeWindow {
  const handlers = new Map<string, Set<() => void>>();
  return {
    location: { hash },
    handlers,
    addEventListener: (type, handler) => void handlers.set(type, (handlers.get(type) ?? new Set()).add(handler)),
    removeEventListener: (type, handler) => void handlers.get(type)?.delete(handler),
  };
}

describe('the token of the shared minutes page follows the hash', () => {
  const saved = (globalThis as { window?: unknown }).window;
  let win: FakeWindow;
  beforeEach(() => {
    win = fakeWindow(`#${A}`);
    (globalThis as { window?: unknown }).window = win;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  it('reads the token in the address, and none when it is missing or not shaped like one', () => {
    expect(minutesTokenOfHash()).toBe(A);
    expect(B).toHaveLength(43);
    win.location.hash = `#${B}`;
    expect(minutesTokenOfHash()).toBe(B);
    for (const hash of ['', '#', '#short', `#${A}x`, `#${'!'.repeat(43)}`, `#${A}?x=1`]) {
      win.location.hash = hash;
      expect(minutesTokenOfHash(), hash).toBeNull();
    }
  });

  it('tells the page when the hash changes, and stops when asked', () => {
    const seen: Array<string | null> = [];
    const stop = subscribeToHash(() => seen.push(minutesTokenOfHash()));
    expect(win.handlers.get('hashchange')?.size).toBe(1);
    win.location.hash = `#${B}`;
    for (const handler of win.handlers.get('hashchange') ?? []) handler();
    expect(seen).toEqual([B]);
    stop();
    expect(win.handlers.get('hashchange')?.size).toBe(0);
  });
});
