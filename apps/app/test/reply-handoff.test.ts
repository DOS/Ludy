// SPDX-License-Identifier: AGPL-3.0-only
// The text left for a conversation's reply box (meetings integrations B5, #3169): taken once, only by its own thread, never when old, never when the browser keeps nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLY_HANDOFF_MAX_AGE_MS, putReplyHandoff, takeReplyHandoff } from '../src/lib/reply-handoff.ts';

const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
};

beforeEach(() => vi.stubGlobal('sessionStorage', memory()));
afterEach(() => vi.unstubAllGlobals());

describe('reply handoff', () => {
  it('gives the text to the box of its own conversation, once', () => {
    expect(putReplyHandoff('c1', 'Biên bản', 1_000)).toBe(true);
    expect(takeReplyHandoff('c1', 2_000)).toBe('Biên bản');
    expect(takeReplyHandoff('c1', 2_000)).toBeNull();
  });

  it('drops the text when another thread opens first, so it never reaches a later box', () => {
    putReplyHandoff('c1', 'Biên bản', 1_000);
    expect(takeReplyHandoff('c2', 2_000)).toBeNull();
    expect(takeReplyHandoff('c1', 2_000)).toBeNull();
  });

  it('drops a text older than a few minutes, and one dated in the future', () => {
    putReplyHandoff('c1', 'Biên bản', 1_000);
    expect(takeReplyHandoff('c1', 1_000 + REPLY_HANDOFF_MAX_AGE_MS + 1)).toBeNull();
    putReplyHandoff('c1', 'Biên bản', 10_000);
    expect(takeReplyHandoff('c1', 5_000)).toBeNull();
    putReplyHandoff('c1', 'Biên bản', 1_000);
    expect(takeReplyHandoff('c1', 1_000 + REPLY_HANDOFF_MAX_AGE_MS)).toBe('Biên bản');
  });

  it('ignores a value that is not ours, and a browser that keeps nothing', () => {
    sessionStorage.setItem('ludy:reply-handoff', '{"conversationId":1}');
    expect(takeReplyHandoff('c1')).toBeNull();
    sessionStorage.setItem('ludy:reply-handoff', 'not json');
    expect(takeReplyHandoff('c1')).toBeNull();
    vi.stubGlobal('sessionStorage', { ...memory(), setItem: () => { throw new Error('full'); } });
    expect(putReplyHandoff('c1', 'x')).toBe(false);
    // No sessionStorage at all (stubbed absent, so the case does not depend on the runner: a newer Node has a built-in one).
    vi.stubGlobal('sessionStorage', undefined);
    expect(putReplyHandoff('c1', 'x')).toBe(false);
    expect(takeReplyHandoff('c1')).toBeNull();
  });
});
