// SPDX-License-Identifier: AGPL-3.0-only
// The consent page's helpers (ADR-0051, #2975): the interaction id kept while the person signs in, and where the browser may go after an answer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_OAUTH_TTL_MS, forgetInteraction, pendingInteraction, rememberInteraction, safeResume, wellFormedUid } from '../src/lib/oauth-consent.ts';

const UID = 'au3opBAruRuEEW2q_13PDiBqNCa2bR1Yx5941fUcreG';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

describe('the pending interaction', () => {
  beforeEach(() => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('keeps a well formed id for ten minutes and then forgets it', () => {
    rememberInteraction(UID, 1_000);
    expect(pendingInteraction(1_000 + PENDING_OAUTH_TTL_MS - 1)).toBe(UID);
    expect(pendingInteraction(1_000 + PENDING_OAUTH_TTL_MS)).toBeNull();
    expect(pendingInteraction(1_000)).toBeNull();
  });

  it('keeps nothing for an id that is not a path segment of the provider, and forgets on request', () => {
    for (const bad of ['', 'short', 'has space in it padding padding', '../../etc/passwd/padding', `${UID}/details`, 'a'.repeat(200)]) {
      rememberInteraction(bad, 5);
      expect(pendingInteraction(5), bad).toBeNull();
      expect(wellFormedUid(bad), bad).toBe(false);
    }
    rememberInteraction(UID, 5);
    forgetInteraction();
    expect(pendingInteraction(6)).toBeNull();
  });

  it('survives storage that throws', () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    expect(() => rememberInteraction(UID)).not.toThrow();
    expect(pendingInteraction()).toBeNull();
    expect(() => forgetInteraction()).not.toThrow();
  });
});

describe('where the browser goes after an answer', () => {
  const origin = 'https://ludy.example.com';
  it('goes only to the provider\'s resume address on this origin', () => {
    expect(safeResume(`${origin}/oauth/authorize/${UID}`, origin)).toBe(`${origin}/oauth/authorize/${UID}`);
    expect(safeResume(`/oauth/authorize/${UID}`, origin)).toBe(`${origin}/oauth/authorize/${UID}`);
    for (const bad of ['', 'https://evil.example.com/oauth/authorize/x', `${origin}/other`, `${origin}/oauth/token`, 'javascript:alert(1)', '//evil.example.com/oauth/authorize/x']) {
      expect(safeResume(bad, origin), bad).toBeNull();
    }
  });
});
