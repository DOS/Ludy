// SPDX-License-Identifier: AGPL-3.0-only
// The token of a sent quote's public page follows the address's hash (#2827): a hash-only change in the same tab (a second quote link opened where the first is shown) must
// reach the page, which a token read once at the start would miss. This app's unit tests run without a DOM, so the window is a small stand-in with the one event.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quoteTokenOfHash, subscribeToHash } from '../src/lib/quote-hash.ts';

const A = 'a'.repeat(43);
const B = 'b'.repeat(43);

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

describe('the token of the quote page follows the hash', () => {
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
    expect(quoteTokenOfHash()).toBe(A);
    for (const hash of ['', '#', '#short', `#${A}x`, `#${'!'.repeat(43)}`]) {
      win.location.hash = hash;
      expect(quoteTokenOfHash(), hash).toBeNull();
    }
  });

  it('tells the page when the hash changes, so another quote link in the same tab shows the other quote, and stops when asked', () => {
    let calls = 0;
    const seen: Array<string | null> = [];
    const stop = subscribeToHash(() => {
      calls += 1;
      seen.push(quoteTokenOfHash());
    });
    expect(win.handlers.get('hashchange')?.size).toBe(1);
    // The same tab, another link: only the hash differs, and the browser fires hashchange without reloading.
    win.location.hash = `#${B}`;
    for (const handler of win.handlers.get('hashchange') ?? []) handler();
    expect(calls).toBe(1);
    expect(seen).toEqual([B]);
    stop();
    expect(win.handlers.get('hashchange')?.size).toBe(0);
  });
});
