// SPDX-License-Identifier: AGPL-3.0-only
// Desktop sidebar rail state & `[` shortcut guard (#4519): localStorage persistence, storage error resilience,
// SSR safety, cross-tab storage sync, and editable-target/modifier/modal guards on `[`.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installedApps } from '../src/lib/apps.ts';
import { MODULE_SCREENS } from '@ludy/kernel-contract';

type SidebarRail = typeof import('../src/lib/sidebar-rail.ts');

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

let storage: MemoryStorage;
let windowListeners: Map<string, Set<(event: Event) => void>>;

async function load(options: { stored?: string; throwOnRead?: boolean; throwOnWrite?: boolean; noWindow?: boolean } = {}): Promise<SidebarRail> {
  storage = new MemoryStorage();
  if (options.stored !== undefined) storage.values.set('ludy-sidebar-collapsed', options.stored);
  windowListeners = new Map();

  if (options.noWindow) {
    vi.stubGlobal('window', undefined);
  } else {
    const wrappedStorage = {
      getItem: (key: string) => {
        if (options.throwOnRead) throw new Error('storage blocked');
        return storage.getItem(key);
      },
      setItem: (key: string, value: string) => {
        if (options.throwOnWrite) throw new Error('quota exceeded');
        storage.setItem(key, value);
      },
      removeItem: (key: string) => {
        if (options.throwOnWrite) throw new Error('quota exceeded');
        storage.removeItem(key);
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
  return import('../src/lib/sidebar-rail.ts');
}

function dispatchWindowStorage(key: string | null, newValue: string | null, storageArea?: unknown): void {
  const listeners = [...(windowListeners.get('storage') ?? [])];
  const event = { key, newValue, storageArea } as unknown as Event;
  for (const fn of listeners) fn(event);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidebar-rail persistence & SSR safety (#4519)', () => {
  it('defaults to expanded, persists collapsed state to localStorage, and clears key when expanded', async () => {
    const rail = await load();
    expect(rail.readSidebarCollapsed()).toBe(false);

    rail.setSidebarCollapsed(true);
    expect(rail.readSidebarCollapsed()).toBe(true);
    expect(storage.getItem(rail.SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1');

    // Reloading module reads persisted value from localStorage.
    vi.resetModules();
    const reloaded = await import('../src/lib/sidebar-rail.ts');
    expect(reloaded.readSidebarCollapsed()).toBe(true);

    reloaded.setSidebarCollapsed((prev) => !prev);
    expect(reloaded.readSidebarCollapsed()).toBe(false);
    expect(storage.getItem(reloaded.SIDEBAR_COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  it('gracefully falls back to in-memory state when localStorage throws on read and write or on write only', async () => {
    const railBoth = await load({ throwOnRead: true, throwOnWrite: true });
    expect(railBoth.readSidebarCollapsed()).toBe(false);
    expect(() => railBoth.setSidebarCollapsed(true)).not.toThrow();
    expect(railBoth.readSidebarCollapsed()).toBe(true);
    expect(() => railBoth.setSidebarCollapsed(false)).not.toThrow();
    expect(railBoth.readSidebarCollapsed()).toBe(false);

    // QuotaExceededError case: getItem succeeds (returns null) while setItem throws.
    const railWriteOnly = await load({ throwOnRead: false, throwOnWrite: true });
    expect(railWriteOnly.readSidebarCollapsed()).toBe(false);
    expect(() => railWriteOnly.setSidebarCollapsed(true)).not.toThrow();
    expect(railWriteOnly.readSidebarCollapsed()).toBe(true);
    expect(() => railWriteOnly.setSidebarCollapsed(false)).not.toThrow();
    expect(railWriteOnly.readSidebarCollapsed()).toBe(false);
  });

  it('renders cleanly in SSR without window', async () => {
    const rail = await load({ noWindow: true });
    expect(rail.readSidebarCollapsed()).toBe(false);

    function Probe() {
      const [collapsed] = rail.useSidebarCollapsed();
      return createElement('span', null, String(collapsed));
    }
    expect(renderToString(createElement(Probe))).toContain('false');
  });

  it('syncs across tabs on storage events and ignores unrelated or sessionStorage events', async () => {
    const rail = await load();
    let calls = 0;
    const stop = rail.subscribeSidebarCollapsed(() => {
      calls += 1;
    });

    // Unrelated key or different storageArea (e.g. sessionStorage) must not trigger listeners.
    storage.setItem('ludy-theme', 'dark');
    dispatchWindowStorage('ludy-theme', 'dark');
    expect(calls).toBe(0);
    dispatchWindowStorage(rail.SIDEBAR_COLLAPSED_STORAGE_KEY, '1', new MemoryStorage());
    expect(calls).toBe(0);

    // Another tab collapses the sidebar -> localStorage updates and listener fires.
    storage.setItem(rail.SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    dispatchWindowStorage(rail.SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    expect(calls).toBe(1);
    expect(rail.readSidebarCollapsed()).toBe(true);

    // Another tab calls localStorage.clear() -> event.key === null resets back to expanded.
    storage.clear();
    dispatchWindowStorage(null, null);
    expect(calls).toBe(2);
    expect(rail.readSidebarCollapsed()).toBe(false);

    stop();
  });
});

describe('hasSecondaryNav (#4519)', () => {
  const apps = installedApps(Object.keys(MODULE_SCREENS));

  it('returns false on no-app org screens and true on installed apps and Settings', async () => {
    const rail = await load();
    expect(rail.hasSecondaryNav(null, apps, '/o/acme/overview')).toBe(false);
    expect(rail.hasSecondaryNav(null, apps, '/o/acme/notifications')).toBe(false);
    expect(rail.hasSecondaryNav(null, apps, '/o/acme/audit')).toBe(false);
    expect(rail.hasSecondaryNav(null, apps, '/o/acme/personal-data')).toBe(false);

    expect(rail.hasSecondaryNav(null, apps, '/o/acme/settings')).toBe(true);
    expect(rail.hasSecondaryNav(null, apps, '/o/acme/settings/members')).toBe(true);
    expect(rail.hasSecondaryNav('finance', apps, '/o/acme/journal')).toBe(true);
    expect(rail.hasSecondaryNav('teamwork', [], '/o/acme/my-work')).toBe(false);
  });
});

describe('isSidebarToggleShortcut (`[` guard, #4519)', () => {
  const key = (more: Partial<Parameters<SidebarRail['isSidebarToggleShortcut']>[0]> = {}) => ({
    key: '[',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    target: { tagName: 'DIV' } as unknown as EventTarget,
    ...more,
  });

  it('allows plain `[` on desktop App/Settings routes when no modal or input is active', async () => {
    const rail = await load();
    expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: true, isDesktop: true })).toBe(true);
  });

  it('ignores `[` on no-app org routes, mobile widths, modals, modifiers, and other keys', async () => {
    const rail = await load();
    expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: false })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: true, modalOpen: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: true, isDesktop: false })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ ctrlKey: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ metaKey: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ altKey: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ repeat: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ defaultPrevented: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ isComposing: true }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ key: '{' }), { hasSecondary: true })).toBe(false);
    expect(rail.isSidebarToggleShortcut(key({ key: ']' }), { hasSecondary: true })).toBe(false);
  });

  it('ignores `[` when focus or target is inside input, textarea, select, or contenteditable', async () => {
    const rail = await load();
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(rail.isSidebarToggleShortcut(key({ target: { tagName } as unknown as EventTarget }), { hasSecondary: true }), tagName).toBe(false);
      expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: true, activeElement: { tagName } }), `active ${tagName}`).toBe(false);
    }

    const contentEditableEl = { tagName: 'DIV', isContentEditable: true };
    const plaintextEditableEl = { tagName: 'DIV', getAttribute: (n: string) => (n === 'contenteditable' ? 'plaintext-only' : null) };
    const childInsideEditable = { tagName: 'SPAN', closest: () => contentEditableEl };

    for (const node of [contentEditableEl, plaintextEditableEl, childInsideEditable]) {
      expect(rail.isSidebarToggleShortcut(key({ target: node as unknown as EventTarget }), { hasSecondary: true })).toBe(false);
      expect(rail.isSidebarToggleShortcut(key(), { hasSecondary: true, activeElement: node })).toBe(false);
    }
  });
});
