// SPDX-License-Identifier: AGPL-3.0-only
// The way back from a post (#3656) returns to the list the person left: its tab and filters, kept for the browser tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastSocialList, rememberSocialList } from '../src/lib/social.ts';

const store = new Map<string, string>();

describe('the list kept for the way back (#3656)', () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gives back the tab and filters it was given, through the same checks as a typed link', () => {
    rememberSocialList('hoa-mai', { tab: 'review', q: 'khai trương' });
    expect(lastSocialList('hoa-mai')).toEqual({ tab: 'review', q: 'khai trương' });
    store.set('ludy:social-list:hoa-mai', JSON.stringify({ tab: 'nope', channel: 'not-a-uuid' }));
    expect(lastSocialList('hoa-mai')).toEqual({});
    store.clear();
    store.set('crove:social-list:hoa-mai', JSON.stringify({ tab: 'drafts', q: 'tet' }));
    expect(lastSocialList('hoa-mai')).toEqual({ tab: 'drafts', q: 'tet' });
    expect(store.get('ludy:social-list:hoa-mai')).toBe(JSON.stringify({ tab: 'drafts', q: 'tet' }));
  });

  it('keeps one list per organization, so a filter of one never reaches another', () => {
    rememberSocialList('hoa-mai', { tab: 'drafts' });
    expect(lastSocialList('lan-anh')).toEqual({});
    expect(lastSocialList('hoa-mai')).toEqual({ tab: 'drafts' });
  });

  it('is empty before anything was kept, and when storage is not there', () => {
    expect(lastSocialList('hoa-mai')).toEqual({});
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => rememberSocialList('hoa-mai', { tab: 'drafts' })).not.toThrow();
    expect(lastSocialList('hoa-mai')).toEqual({});
  });
});
