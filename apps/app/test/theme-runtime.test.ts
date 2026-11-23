// SPDX-License-Identifier: AGPL-3.0-only
// Theme runtime synchronization (#4502, DESIGN.md 4.6): keeps localStorage, <html class="dark">,
// root.style.colorScheme, and useSyncExternalStore / ThemeSwitcher in step across initial load,
// storage events (including event.key === null storage clears), focus/pageshow, and print overrides.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ThemeRuntime = typeof import('../src/lib/theme-runtime.ts');

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

class FakeClassList {
  private readonly tokens = new Set<string>();
  toggle(token: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.tokens.has(token)) {
        this.tokens.delete(token);
        return false;
      }
      this.tokens.add(token);
      return true;
    }
    if (force) this.tokens.add(token);
    else this.tokens.delete(token);
    return force;
  }
  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

let storage: MemoryStorage;
let root: { classList: FakeClassList; style: { colorScheme: string } };
let prefersDark = false;
let mediaListeners: Array<() => void> = [];

async function load(options: { stored?: string; legacyStored?: string; systemDark?: boolean } = {}): Promise<ThemeRuntime> {
  storage = new MemoryStorage();
  if (options.stored) storage.values.set('ludy-theme', options.stored);
  if (options.legacyStored) storage.values.set('crove-theme', options.legacyStored);
  prefersDark = options.systemDark ?? false;
  mediaListeners = [];
  root = { classList: new FakeClassList(), style: { colorScheme: '' } };

  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('window', {
    matchMedia: () => ({
      get matches() {
        return prefersDark;
      },
      addEventListener: (_type: string, fn: () => void) => mediaListeners.push(fn),
      removeEventListener: (_type: string, fn: () => void) => {
        mediaListeners = mediaListeners.filter((item) => item !== fn);
      },
    }),
  });
  vi.resetModules();
  return import('../src/lib/theme-runtime.ts');
}

function storageEvent(key: string | null, newValue: string | null, storageArea: unknown = storage): Event {
  return Object.assign(new Event('storage'), { key, newValue, storageArea });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme-runtime synchronization', () => {
  it('re-reads localStorage on startThemeSync so initial memory cannot drift from dark DOM', async () => {
    const runtime = await load();
    expect(runtime.activeThemeSetting()).toBe('light');
    // Simulate storage updated before startThemeSync runs (or boot script applied dark).
    storage.setItem('ludy-theme', 'dark');
    root.classList.toggle('dark', true);

    const tab = new EventTarget();
    const stop = runtime.startThemeSync(tab as unknown as Window);
    expect(runtime.activeThemeSetting()).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    stop();
  });

  it('handles storage.clear() (event.key === null) and keeps ThemeSwitcher synced with DOM', async () => {
    const runtime = await load({ stored: 'dark' });
    const { I18nProvider } = await import('../src/i18n/provider.tsx');
    const { ThemeSwitcher } = await import('../src/components/theme-switcher.tsx');
    const renderSwitcher = () => renderToString(createElement(I18nProvider, null, createElement(ThemeSwitcher)));

    const tab = new EventTarget();
    const stop = runtime.startThemeSync(tab as unknown as Window);
    expect(runtime.activeThemeSetting()).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(renderSwitcher()).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*data-value="dark"/);

    // Unrelated key or sessionStorage event must not change theme.
    tab.dispatchEvent(storageEvent('ludy-locale', 'en'));
    expect(runtime.activeThemeSetting()).toBe('dark');
    tab.dispatchEvent(storageEvent('ludy-theme', 'light', new MemoryStorage()));
    expect(runtime.activeThemeSetting()).toBe('dark');

    // Another tab calls localStorage.clear() -> event.key === null, event.newValue === null.
    storage.clear();
    tab.dispatchEvent(storageEvent(null, null));
    expect(runtime.activeThemeSetting()).toBe('light');
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
    expect(renderSwitcher()).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*data-value="light"/);

    // Another tab switches to dark and then removes the key directly.
    storage.setItem('ludy-theme', 'dark');
    tab.dispatchEvent(storageEvent('ludy-theme', 'dark'));
    expect(runtime.activeThemeSetting()).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);
    storage.removeItem('ludy-theme');
    tab.dispatchEvent(storageEvent('ludy-theme', null));
    expect(runtime.activeThemeSetting()).toBe('light');
    expect(root.classList.contains('dark')).toBe(false);

    stop();
  });

  it('re-syncs on focus/pageshow, follows system changes when set to system, and preserves dark across print', async () => {
    const runtime = await load({ stored: 'system', systemDark: false });
    const tab = new EventTarget();
    const stop = runtime.startThemeSync(tab as unknown as Window);
    expect(root.classList.contains('dark')).toBe(false);

    prefersDark = true;
    for (const fn of mediaListeners) fn();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');

    // Same-tab external storage mutation reconciled on window focus.
    storage.setItem('ludy-theme', 'light');
    tab.dispatchEvent(new Event('focus'));
    expect(runtime.activeThemeSetting()).toBe('light');
    expect(root.classList.contains('dark')).toBe(false);

    // Print flow: beforeprint -> afterprint keeps dark setting intact.
    runtime.setThemeSetting('dark');
    expect(root.classList.contains('dark')).toBe(true);
    tab.dispatchEvent(new Event('beforeprint'));
    root.classList.toggle('dark', false);
    tab.dispatchEvent(new Event('afterprint'));
    expect(runtime.activeThemeSetting()).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);

    stop();
  });
});
