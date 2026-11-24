// SPDX-License-Identifier: AGPL-3.0-only
// Per-org Cmd+K recent history (#4525): strict per-org isolation, 5-item cap with most-recent-first
// deduplication, SSR safety, QuotaExceededError / private-mode fallback, corrupted-JSON resilience,
// cross-tab storage sync, and disabled-module / permission filtering.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellVisibility } from '../src/lib/apps.ts';

type PaletteRecents = typeof import('../src/lib/palette-recents.ts');

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(k: string): string | null {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    this.values.set(k, value);
  }
  removeItem(k: string): void {
    this.values.delete(k);
  }
  clear(): void {
    this.values.clear();
  }
}

let storage: MemoryStorage;
let windowListeners: Map<string, Set<(event: Event) => void>>;

async function load(
  options: {
    initial?: Record<string, string>;
    throwOnRead?: boolean;
    throwOnWrite?: boolean;
    throwOnRemove?: boolean;
    noWindow?: boolean;
  } = {},
): Promise<PaletteRecents> {
  storage = new MemoryStorage();
  for (const [k, v] of Object.entries(options.initial ?? {})) {
    storage.values.set(k, v);
  }
  windowListeners = new Map();

  if (options.noWindow) {
    vi.stubGlobal('window', undefined);
  } else {
    const wrappedStorage = {
      get length() {
        return storage.length;
      },
      key: (index: number) => storage.key(index),
      getItem: (k: string) => {
        if (options.throwOnRead) throw new Error('SecurityError: storage blocked');
        return storage.getItem(k);
      },
      setItem: (k: string, value: string) => {
        if (options.throwOnWrite) throw new Error('QuotaExceededError: storage full');
        storage.setItem(k, value);
      },
      removeItem: (k: string) => {
        if (options.throwOnRemove) throw new Error('SecurityError: remove blocked');
        storage.removeItem(k);
      },
    };
    vi.stubGlobal('window', {
      localStorage: wrappedStorage,
      addEventListener: (type: string, fn: (event: Event) => void) => {
        let set = windowListeners.get(type);
        if (!set) windowListeners.set(type, (set = new Set()));
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (event: Event) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
    });
  }
  vi.resetModules();
  return import('../src/lib/palette-recents.ts');
}

function dispatchStorageEvent(key: string | null, newValue: string | null): void {
  const listeners = [...(windowListeners.get('storage') ?? [])];
  const event = { key, newValue } as unknown as Event;
  for (const fn of listeners) fn(event);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('palette-recents org isolation, 5-item cap, and deduplication', () => {
  it('isolates recent history strictly per org slug and never leaks across orgs', async () => {
    const recents = await load();
    recents.recordRecentItem(
      'hoa-sen',
      { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' },
      { orgId: 'org-1', userId: 'user-1' },
    );
    recents.recordRecentItem(
      'hoa-sen',
      { id: '/inbox/inv-1', path: '/inbox/inv-1', label: 'Công ty Bao Bì', kind: 'record' },
      { orgId: 'org-1', userId: 'user-1' },
    );
    recents.recordRecentItem(
      'huong-duong',
      { id: '/notes', path: '/notes', label: 'Ghi chú', kind: 'screen' },
      { orgId: 'org-2', userId: 'user-1' },
    );

    expect(recents.readRecentItems('hoa-sen', { orgId: 'org-1', userId: 'user-1' }).map((i) => i.id)).toEqual([
      '/inbox/inv-1',
      '/ledger',
    ]);
    expect(recents.readRecentItems('huong-duong', { orgId: 'org-2', userId: 'user-1' }).map((i) => i.id)).toEqual([
      '/notes',
    ]);
    expect(recents.readRecentItems('other-org', { orgId: 'org-3', userId: 'user-1' })).toEqual([]);
  });

  it('rejects stored history when orgId or userId mismatches the active scope', async () => {
    const recents = await load();
    recents.recordRecentItem(
      'hoa-sen',
      { id: '/documents', path: '/documents', label: 'Chứng từ', kind: 'screen' },
      { orgId: 'org-1', userId: 'user-1' },
    );

    expect(recents.readRecentItems('hoa-sen', { orgId: 'org-999', userId: 'user-1' })).toEqual([]);
    expect(recents.readRecentItems('hoa-sen', { orgId: 'org-1', userId: 'user-2' })).toEqual([]);
    expect(recents.readRecentItems('hoa-sen', { orgId: 'org-1', userId: 'user-1' })).toHaveLength(1);
  });

  it('caps history at 5 items and deduplicates most-recent-first', async () => {
    const recents = await load();
    const screens = ['/overview', '/inbox', '/documents', '/ledger', '/vat', '/bank'];
    for (const [index, path] of screens.entries()) {
      recents.recordRecentItem('acme', {
        id: path,
        path,
        label: `Screen ${index}`,
        kind: 'screen',
        visitedAt: 1000 + index,
      });
    }
    expect(recents.readRecentItems('acme').map((i) => i.id)).toEqual([
      '/bank',
      '/vat',
      '/ledger',
      '/documents',
      '/inbox',
    ]);

    // Revisiting an older item moves it to index 0 and keeps the 5-item cap.
    recents.recordRecentItem('acme', {
      id: '/documents',
      path: '/documents',
      label: 'Chứng từ mới',
      kind: 'screen',
      visitedAt: 2000,
    });
    const after = recents.readRecentItems('acme');
    expect(after.map((i) => i.id)).toEqual(['/documents', '/bank', '/vat', '/ledger', '/inbox']);
    expect(after[0]?.label).toBe('Chứng từ mới');
  });

  it('clears one org or all orgs cleanly without touching unrelated keys', async () => {
    const recents = await load({
      initial: { 'ludy-theme': 'dark' },
    });
    recents.recordRecentItem('org-a', { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' });
    recents.recordRecentItem('org-b', { id: '/notes', path: '/notes', label: 'Ghi chú', kind: 'screen' });

    recents.clearRecentItems('org-a');
    expect(recents.readRecentItems('org-a')).toEqual([]);
    expect(recents.readRecentItems('org-b')).toHaveLength(1);

    recents.clearRecentItems();
    expect(recents.readRecentItems('org-b')).toEqual([]);
    expect(storage.getItem('ludy-theme')).toBe('dark');
  });
});

describe('palette-recents storage resilience and SSR safety', () => {
  it('handles QuotaExceededError and blocked storage via per-org in-memory fallback', async () => {
    const recents = await load({ throwOnWrite: true });
    expect(() =>
      recents.recordRecentItem('acme', { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' }),
    ).not.toThrow();
    expect(recents.readRecentItems('acme').map((i) => i.id)).toEqual(['/ledger']);
    expect(recents.readRecentItems('other')).toEqual([]);

    const blockedBoth = await load({ throwOnRead: true, throwOnWrite: true, throwOnRemove: true });
    expect(blockedBoth.readRecentItems('acme')).toEqual([]);
    expect(() =>
      blockedBoth.recordRecentItem('acme', { id: '/vat', path: '/vat', label: 'Thuế', kind: 'screen' }),
    ).not.toThrow();
    expect(blockedBoth.readRecentItems('acme').map((i) => i.id)).toEqual(['/vat']);
    expect(() => blockedBoth.clearRecentItems('acme')).not.toThrow();
    expect(blockedBoth.readRecentItems('acme')).toEqual([]);
  });

  it('recovers cleanly from corrupted JSON and drops unsafe or cross-org paths', async () => {
    const recents = await load({
      initial: {
        'ludy.palette.recent.broken-json': '{not-valid-json',
        'ludy.palette.recent.wrong-version': JSON.stringify({ version: 99, items: [] }),
        'ludy.palette.recent.mixed': JSON.stringify({
          version: 1,
          items: [
            { id: 'bad-url', path: 'https://evil.example/phish', label: 'Evil', kind: 'screen', visitedAt: 1 },
            { id: 'bad-proto', path: '//evil.example/phish', label: 'Proto', kind: 'screen', visitedAt: 2 },
            { id: 'bad-cross-org', path: '/o/other-org/inbox', label: 'Cross org', kind: 'screen', visitedAt: 3 },
            { id: 'bad-traversal', path: '/ledger/../secret', label: 'Traversal', kind: 'screen', visitedAt: 4 },
            { id: 'valid-screen', path: '/ledger', label: 'Sổ sách', kind: 'screen', visitedAt: 5 },
          ],
        }),
      },
    });

    expect(recents.readRecentItems('broken-json')).toEqual([]);
    expect(recents.readRecentItems('wrong-version')).toEqual([]);
    expect(recents.readRecentItems('mixed').map((i) => i.id)).toEqual(['valid-screen']);
    expect(recents.normalizeOrgRelativePath('/o/other/ledger', 'acme')).toBeNull();
    expect(recents.normalizeOrgRelativePath('/o/acme/ledger/', 'acme')).toBe('/ledger');
  });

  it('is SSR-safe when window is undefined and useRecentItems renders cleanly', async () => {
    const recents = await load({ noWindow: true });
    expect(recents.readRecentItems('acme')).toEqual([]);
    expect(() =>
      recents.recordRecentItem('acme', { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' }),
    ).not.toThrow();
    expect(recents.readRecentItems('acme')).toEqual([]);

    function Probe() {
      const items = recents.useRecentItems('acme');
      return createElement('span', null, String(items.length));
    }
    expect(renderToString(createElement(Probe))).toBe('<span>0</span>');
  });

  it('notifies subscribers on local writes and cross-tab storage events', async () => {
    const recents = await load();
    const events: string[] = [];
    const unsubscribe = recents.subscribeRecentItems('acme', () => {
      events.push(recents.readRecentItems('acme').map((i) => i.id).join(','));
    });

    recents.recordRecentItem('acme', { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' });
    storage.setItem(
      recents.recentStorageKey('acme'),
      JSON.stringify({
        version: 1,
        items: [{ id: '/vat', path: '/vat', label: 'Thuế', kind: 'screen', visitedAt: 10 }],
      }),
    );
    dispatchStorageEvent(recents.recentStorageKey('acme'), storage.getItem(recents.recentStorageKey('acme')));
    storage.clear();
    dispatchStorageEvent(null, null);

    unsubscribe();
    expect(events).toEqual(['/ledger', '/vat', '']);
  });
});

describe('palette-recents disabled-module and permission filtering', () => {
  const managerVis: ShellVisibility = { manager: true, hrMember: true, showAiConnections: true };
  const memberVis: ShellVisibility = { manager: false, hrMember: true, showAiConnections: false };
  const viewerVis: ShellVisibility = { manager: false, hrMember: false, showAiConnections: false };

  it('filters out routes belonging to disabled modules and unknown paths', async () => {
    const recents = await load();
    const items = [
      { id: '/overview', path: '/overview', label: 'Tổng quan', kind: 'screen' as const, visitedAt: 1 },
      { id: '/inbox/p1', path: '/inbox/p1', label: 'Đề xuất kernel', kind: 'record' as const, visitedAt: 2 },
      { id: '/documents?q=00001284', path: '/documents?q=00001284', label: '1C26TPT-00001284', kind: 'record' as const, visitedAt: 3 },
      { id: '/notes?note=n1', path: '/notes?note=n1', label: 'Ghi chú tuần', kind: 'record' as const, visitedAt: 4 },
      { id: '/sign/envelopes/e1', path: '/sign/envelopes/e1', label: 'Hợp đồng A', kind: 'record' as const, visitedAt: 5 },
      { id: '/settings/accounting', path: '/settings/accounting', label: 'Kế toán và thuế', kind: 'screen' as const, visitedAt: 6 },
      { id: '/unknown-route', path: '/unknown-route', label: 'Broken', kind: 'screen' as const, visitedAt: 7 },
    ];

    const kernelOnly = recents.filterVisibleRecentItems(items, {
      modules: ['kernel'],
      visibility: managerVis,
    });
    expect(kernelOnly.map((i) => i.id)).toEqual(['/overview', '/inbox/p1']);

    const withFinanceAndNotes = recents.filterVisibleRecentItems(items, {
      modules: ['kernel', 'finance', 'notes'],
      visibility: managerVis,
    });
    expect(withFinanceAndNotes.map((i) => i.id)).toEqual([
      '/overview',
      '/inbox/p1',
      '/documents?q=00001284',
      '/notes?note=n1',
      '/settings/accounting',
    ]);
  });

  it('filters restricted HR, AI budget, AI connections, and Audit routes by role and config', async () => {
    const recents = await load();
    const items = [
      { id: '/hr/employees', path: '/hr/employees', label: 'Nhân viên', kind: 'screen' as const, visitedAt: 1 },
      { id: '/hr/my', path: '/hr/my', label: 'Cổng nhân viên', kind: 'screen' as const, visitedAt: 2 },
      { id: '/audit', path: '/audit', label: 'Nhật ký hoạt động', kind: 'screen' as const, visitedAt: 3 },
      { id: '/ai-usage', path: '/ai-usage', label: 'Mức dùng AI', kind: 'screen' as const, visitedAt: 4 },
      { id: '/ai-connections', path: '/ai-connections', label: 'Kết nối AI', kind: 'screen' as const, visitedAt: 5 },
      { id: '/tasks/t1', path: '/tasks/t1', label: 'Gửi báo cáo', kind: 'record' as const, visitedAt: 6 },
    ];
    const modules = ['kernel', 'hr'];

    expect(recents.filterVisibleRecentItems(items, { modules, visibility: managerVis }).map((i) => i.id)).toEqual([
      '/hr/employees',
      '/hr/my',
      '/audit',
      '/ai-usage',
      '/ai-connections',
      '/tasks/t1',
    ]);
    expect(recents.filterVisibleRecentItems(items, { modules, visibility: memberVis }).map((i) => i.id)).toEqual([
      '/hr/my',
      '/tasks/t1',
    ]);
    expect(recents.filterVisibleRecentItems(items, { modules, visibility: viewerVis }).map((i) => i.id)).toEqual([
      '/tasks/t1',
    ]);
  });

  it('detects parameterized detail record routes accurately without misclassifying static sibling routes', async () => {
    const recents = await load();
    expect(recents.detailSectionKeyForPath('/inbox/0190-abc')).toBe('inbox');
    expect(recents.detailSectionKeyForPath('/tasks/0190-abc')).toBe('tasks');
    expect(recents.detailSectionKeyForPath('/projects/0190-abc')).toBe('projects');
    expect(recents.detailSectionKeyForPath('/sign/envelopes/0190-abc')).toBe('signEnvelopes');
    expect(recents.detailSectionKeyForPath('/meetings/0190-abc')).toBe('meetings');
    expect(recents.detailSectionKeyForPath('/social/0190-abc')).toBe('social');

    expect(recents.detailSectionKeyForPath('/meetings/record')).toBeNull();
    expect(recents.detailSectionKeyForPath('/social/new')).toBeNull();
    expect(recents.detailSectionKeyForPath('/social/inbox')).toBeNull();
    expect(recents.detailSectionKeyForPath('/ledger')).toBeNull();
  });
});
