// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createApprovalsCache, type CachedApprovalSummary } from '../src/screens/approvals/cache.ts';
import { memoryStore, SERVER } from './helpers.ts';

function makeSummary(index: number, longPad = ''): CachedApprovalSummary {
  return {
    key: `inbox:id-${index}`,
    source: 'inbox',
    id: `id-${index}`,
    subtype: 'finance.purchase',
    title: `Hóa đơn nhà cung cấp số ${index} với mô tả tiếng Việt đầy đủ dấu ${longPad}`,
    subtitle: `Công ty TNHH Đối Tác Thương Mại Quốc Tế ${longPad}`,
    counterparty: 'Công ty TNHH Đối Tác',
    amount: '2500000',
    currency: null,
    requiresStepUp: true,
    requiresNetwork: true,
    createdAt: '2026-11-26T09:00:00Z',
    dateLabel: '2026-11-26',
    failedChecks: 0,
    warnChecks: 1,
    anomalyChecks: 0,
    unclassifiedLines: 0,
    aiCoworker: { id: 'finance', label: 'Ly' },
    webPath: `/inbox/id-${index}`,
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: 1,
  };
}

describe('approvals persisted KeyValue read cache', () => {
  it('saves atomically with generation isolation, fits UTF-8 bounds, and restores matching snapshots', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);
    const items = Array.from({ length: 18 }, (_, i) => makeSummary(i));

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'acme-vn',
      userId: 'user-a',
      savedAt: 1_764_140_000_000,
      items,
      todayNotices: [
        {
          key: 'ads:flag:1',
          kind: 'flag',
          app: 'ads',
          id: '1',
          titleKey: 'ads.cpr',
          titleParams: { campaign: 'Tết', account: 'Main', ratio: '2.5' },
          amount: '500000',
          currency: 'VND',
          count: 1,
          dueAt: null,
          severity: 'warn',
          webPath: '/ads',
          aiCoworkerLabel: 'Uy',
        },
      ],
      coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' },
    });

    const encoder = new TextEncoder();
    let chunkCount = 0;
    for (const [k, v] of store.data.entries()) {
      expect(encoder.encode(v).length).toBeLessThanOrEqual(1650);
      if (k.startsWith('ludy.approvals.cache.v1.1.')) chunkCount += 1;
    }
    expect(chunkCount).toBeGreaterThan(1);

    const loaded = await cache.load(SERVER, 'acme-vn', 'user-a');
    expect(loaded).not.toBeNull();
    expect(loaded?.savedAt).toBe(1_764_140_000_000);
    expect(loaded?.items).toHaveLength(18);
    expect(loaded?.todayNotices[0]?.aiCoworkerLabel).toBe('Uy');
  });

  it('shrinks oversized payloads cleanly without truncating JSON mid-string', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);
    const hugePad = 'Tiếng Việt có dấu rất dài '.repeat(25);
    const items = Array.from({ length: 60 }, (_, i) => makeSummary(i, hugePad));

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'acme-vn',
      userId: 'user-a',
      savedAt: 2_000_000,
      items,
      todayNotices: Array.from({ length: 40 }, (_, i) => ({
        key: `n:${i}`,
        kind: 'flag' as const,
        app: 'ads',
        id: String(i),
        titleKey: 'ads.cpr',
        titleParams: { campaign: hugePad },
        amount: null,
        currency: null,
        count: 1,
        dueAt: null,
        severity: 'warn' as const,
        webPath: '/ads',
        aiCoworkerLabel: 'Uy',
      })),
      coworkers: { marketing: 'Uy' },
    });

    const loaded = await cache.load(SERVER, 'acme-vn', 'user-a');
    expect(loaded).not.toBeNull();
    expect(loaded?.items.length).toBeGreaterThan(0);
    expect(loaded?.items.length).toBeLessThanOrEqual(60);
  });

  it('never leaks cached data across different serverUrl, orgSlug, or userId', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);
    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 1000,
      items: [makeSummary(1)],
      todayNotices: [],
      coworkers: { finance: 'Ly' },
    });

    expect(await cache.load(SERVER, 'org-b', 'user-a')).toBeNull();
    expect(await cache.load('https://other.example', 'org-a', 'user-a')).toBeNull();
    expect(await cache.load(SERVER, 'org-a', 'user-b')).toBeNull();
    expect(await cache.load(SERVER, 'org-a', null)).toBeNull();
    expect(await cache.load(SERVER, 'org-a', 'user-a')).not.toBeNull();
  });

  it('drops stale save started before clear() on sign-out or org switch', async () => {
    const base = memoryStore();
    const gate: { enter: (() => void) | null; release: (() => void) | null } = {
      enter: null,
      release: null,
    };
    const enteredSet = new Promise<void>((resolve) => {
      gate.enter = resolve;
    });
    const delayedStore = {
      ...base,
      async set(key: string, value: string) {
        if (key.startsWith('ludy.approvals.cache.v1.')) {
          gate.enter?.();
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return base.set(key, value);
      },
    };
    const cache = createApprovalsCache(delayedStore);
    const startEpoch = cache.epoch();

    const pendingSave = cache.save(
      {
        serverUrl: SERVER,
        orgSlug: 'org-a',
        userId: 'user-a',
        savedAt: 1000,
        items: [makeSummary(1)],
        todayNotices: [],
        coworkers: { finance: 'Ly' },
      },
      { expectedEpoch: startEpoch },
    );

    // Wait until chunk write enters store.set, then clear() synchronously before releasing it.
    await enteredSet;
    const pendingClear = cache.clear();
    expect(cache.epoch()).toBe(startEpoch + 1);
    gate.release?.();

    expect(await pendingSave).toBe(false);
    await pendingClear;
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();
    expect(base.data.size).toBe(0);

    // Post-clear stale expectedEpoch saves fail immediately too.
    expect(
      await cache.save(
        {
          serverUrl: SERVER,
          orgSlug: 'org-a',
          userId: 'user-a',
          savedAt: 2000,
          items: [makeSummary(2)],
          todayNotices: [],
          coworkers: {},
        },
        { expectedEpoch: startEpoch },
      ),
    ).toBe(false);
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();
  });

  it('cleans up orphaned chunks left behind by an interrupted mid-write failure', async () => {
    const base = memoryStore();
    let chunkWrites = 0;
    const flakyStore = {
      ...base,
      async set(key: string, value: string) {
        if (key.startsWith('ludy.approvals.cache.v1.')) {
          chunkWrites += 1;
          if (chunkWrites >= 2) throw new Error('disk full');
        }
        return base.set(key, value);
      },
    };
    const cache = createApprovalsCache(flakyStore);

    await expect(
      cache.save({
        serverUrl: SERVER,
        orgSlug: 'org-a',
        userId: 'user-a',
        savedAt: 1000,
        items: Array.from({ length: 12 }, (_, i) => makeSummary(i)),
        todayNotices: [],
        coworkers: {},
      }),
    ).rejects.toThrow('disk full');

    expect(base.data.size).toBeGreaterThan(0);
    await cache.clear();
    expect(base.data.size).toBe(0);
  });

  it('removes previous generation chunks on subsequent save and clears all keys on clear()', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 1000,
      items: Array.from({ length: 12 }, (_, i) => makeSummary(i)),
      todayNotices: [],
      coworkers: {},
    });
    const keysGen1 = [...store.data.keys()].filter((k) => k.startsWith('ludy.approvals.cache.v1.1.'));
    expect(keysGen1.length).toBeGreaterThan(1);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 2000,
      items: [makeSummary(1)],
      todayNotices: [],
      coworkers: {},
    });
    const lingeringGen1 = [...store.data.keys()].filter((k) => k.startsWith('ludy.approvals.cache.v1.1.'));
    const presentGen2 = [...store.data.keys()].filter((k) => k.startsWith('ludy.approvals.cache.v1.2.'));
    expect(lingeringGen1).toHaveLength(0);
    expect(presentGen2.length).toBeGreaterThan(0);

    await cache.clear();
    expect(store.data.size).toBe(0);
  });

  it('fails closed on corrupted meta or missing chunks', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 1000,
      items: Array.from({ length: 10 }, (_, i) => makeSummary(i)),
      todayNotices: [],
      coworkers: {},
    });
    store.data.delete('ludy.approvals.cache.v1.1.0');
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();

    store.data.set('ludy.approvals.cache.meta.v1', '{broken-json');
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();
  });
});
