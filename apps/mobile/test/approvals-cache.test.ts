// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createApprovalsCache, type CachedApprovalSummary } from '../src/screens/approvals/cache.ts';
import { memoryStore, SERVER } from './helpers.ts';

function makeSummary(index: number): CachedApprovalSummary {
  return {
    key: `inbox:id-${index}`,
    source: 'inbox',
    id: `id-${index}`,
    subtype: 'finance.purchase',
    title: `Hóa đơn nhà cung cấp số ${index} với mô tả tiếng Việt đầy đủ dấu để kiểm tra cắt chunk UTF-8`,
    subtitle: 'Công ty TNHH Đối Tác Thương Mại Quốc Tế',
    counterparty: 'Công ty TNHH Đối Tác',
    amount: '2500000',
    currency: 'VND',
    requiresStepUp: true,
    requiresNetwork: true,
    createdAt: '2026-11-26T09:00:00Z',
    dateLabel: '2026-11-26',
    failedChecks: 0,
    warnChecks: 1,
    unclassifiedLines: 0,
    aiCoworker: { id: 'finance', label: 'Ly' },
    webPath: `/inbox/id-${index}`,
    multiDecisionOnly: false,
    multiDecisionReason: null,
    revision: 1,
  };
}

describe('approvals persisted KeyValue read cache', () => {
  it('saves, chunks within UTF-8 bounds, and restores matching server/org snapshots', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);
    const items = Array.from({ length: 18 }, (_, i) => makeSummary(i));

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'acme-vn',
      savedAt: 1_764_140_000_000,
      items,
      todayNotices: [
        {
          key: 'ads:flag:1',
          kind: 'flag',
          app: 'ads',
          id: '1',
          titleKey: 'ads.today.spend_pace',
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

    // Every stored chunk must remain comfortably under SecureStore's 2048-byte limit.
    const encoder = new TextEncoder();
    let chunkCount = 0;
    for (const [k, v] of store.data.entries()) {
      expect(encoder.encode(v).length).toBeLessThanOrEqual(1650);
      if (k.startsWith('ludy.approvals.cache.chunk.v1.')) chunkCount += 1;
    }
    expect(chunkCount).toBeGreaterThan(1);

    const loaded = await cache.load(SERVER, 'acme-vn');
    expect(loaded).not.toBeNull();
    expect(loaded?.savedAt).toBe(1_764_140_000_000);
    expect(loaded?.items).toHaveLength(18);
    expect(loaded?.todayNotices[0]?.aiCoworkerLabel).toBe('Uy');
  });

  it('never leaks cached data across different serverUrl or orgSlug', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);
    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      savedAt: 1000,
      items: [makeSummary(1)],
      todayNotices: [],
      coworkers: { finance: 'Ly' },
    });

    expect(await cache.load(SERVER, 'org-b')).toBeNull();
    expect(await cache.load('https://other.example', 'org-a')).toBeNull();
    expect(await cache.load(SERVER, 'org-a')).not.toBeNull();
  });

  it('removes stale chunks when a later save is smaller and clears all keys on clear()', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      savedAt: 1000,
      items: Array.from({ length: 12 }, (_, i) => makeSummary(i)),
      todayNotices: [],
      coworkers: {},
    });
    const keysBefore = store.data.size;
    expect(keysBefore).toBeGreaterThan(2);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      savedAt: 2000,
      items: [makeSummary(1)],
      todayNotices: [],
      coworkers: {},
    });
    expect(store.data.size).toBeLessThan(keysBefore);

    await cache.clear();
    expect(store.data.size).toBe(0);
  });

  it('fails closed on corrupted meta or missing chunks', async () => {
    const store = memoryStore();
    const cache = createApprovalsCache(store);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      savedAt: 1000,
      items: Array.from({ length: 10 }, (_, i) => makeSummary(i)),
      todayNotices: [],
      coworkers: {},
    });
    store.data.delete('ludy.approvals.cache.chunk.v1.0');
    expect(await cache.load(SERVER, 'org-a')).toBeNull();

    store.data.set('ludy.approvals.cache.meta.v1', '{broken-json');
    expect(await cache.load(SERVER, 'org-a')).toBeNull();
  });
});
