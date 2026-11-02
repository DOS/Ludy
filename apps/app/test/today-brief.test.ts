// SPDX-License-Identifier: AGPL-3.0-only
// Vy's daily brief on Home (#2383), the parts without a screen: the fingerprint of the list and the per-tab store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zTodayItem, type TodayItem } from '@crove/kernel-contract';
import { briefStorageKey, listFingerprint, readStoredBrief, storeBrief } from '../src/lib/today-brief.ts';

const item = (over: Record<string, unknown>): TodayItem => zTodayItem.parse({ kind: 'proposal', app: 'finance', id: 'a', title: { key: 'k' }, href: '/inbox', ...over });

describe('listFingerprint', () => {
  it('is the same for the same list in any order, and changes when a figure changes', () => {
    const a = item({ id: 'a', count: 3 });
    const b = item({ id: 'b', kind: 'flag', severity: 'warn' });
    expect(listFingerprint([a, b])).toBe(listFingerprint([b, a]));
    expect(listFingerprint([a, b])).not.toBe(listFingerprint([item({ id: 'a', count: 4 }), b]));
    expect(listFingerprint([a, b])).not.toBe(listFingerprint([a]));
  });

  it('does not depend on the titles or links, which the brief is not written from', () => {
    expect(listFingerprint([item({ title: { key: 'x' }, href: '/one' })])).toBe(listFingerprint([item({ title: { key: 'y' }, href: '/two' })]));
  });
});

describe('the per-tab store', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a written brief by day, language and list, and reads it back', () => {
    const key = briefStorageKey('2026-11-02', 'vi', 'abc');
    expect(key).not.toBe(briefStorageKey('2026-11-02', 'en', 'abc'));
    expect(readStoredBrief(key)).toBeUndefined();
    storeBrief(key, { writtenBy: 'vy', sentences: ['Có 3 việc.'], budgetSpent: false });
    expect(readStoredBrief(key)).toEqual({ writtenBy: 'vy', sentences: ['Có 3 việc.'], budgetSpent: false });
  });

  it('keeps no brief that says nothing, and ignores a stored value that is not a brief', () => {
    const key = briefStorageKey('2026-11-02', 'vi', 'abc');
    storeBrief(key, { writtenBy: null, sentences: [], budgetSpent: true });
    expect(store.size).toBe(0);
    store.set(key, '{"writtenBy":"x","sentences":[1]}');
    expect(readStoredBrief(key)).toBeUndefined();
    store.set(key, 'not json');
    expect(readStoredBrief(key)).toBeUndefined();
  });

  it('works with no storage at all', () => {
    vi.stubGlobal('window', {});
    expect(readStoredBrief('k')).toBeUndefined();
    expect(() => storeBrief('k', { writtenBy: 'vy', sentences: ['x'], budgetSpent: false })).not.toThrow();
  });
});
