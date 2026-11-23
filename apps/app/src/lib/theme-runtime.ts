// The active theme, kept outside React like the locale (i18n/runtime.ts): the setting lives in this browser only, the
// <html> element gets the resolved theme, and React follows through useSyncExternalStore (useThemeSetting).
import { useSyncExternalStore } from 'react';
import { readMigratedItem, writeMigratedItem } from './storage-migrate.ts';
import { LEGACY_THEME_STORAGE_KEY, resolveTheme, THEME_STORAGE_KEY, themeSetting, type ThemeSetting } from './theme.ts';

const listeners = new Set<() => void>();
let current: ThemeSetting = themeSetting(readStored());
// Held for the page's life: some browsers drop an unreferenced MediaQueryList, and its change listener with it.
let query: MediaQueryList | null = null;
let applying = false;
let printing = false;
let stopCurrentSync: (() => void) | null = null;
let activeObserver: MutationObserver | null = null;

function localStorageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return readMigratedItem(localStorage, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function systemQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  query ??= window.matchMedia('(prefers-color-scheme: dark)');
  return query;
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const dark = resolveTheme(current, systemQuery()?.matches ?? false) === 'dark';
  const nextScheme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  if (root.classList?.contains?.('dark') === dark && root.style?.colorScheme === nextScheme) return;
  applying = true;
  try {
    root.classList?.toggle?.('dark', dark);
    if (root.style) root.style.colorScheme = nextScheme;
    activeObserver?.takeRecords?.();
  } finally {
    applying = false;
  }
}

function notify(): void {
  apply();
  for (const listener of listeners) listener();
}

// Reconciles memory and DOM with localStorage so theme-boot.js, other tabs, storage.clear(), and React stay in step.
export function syncThemeFromStorage(): void {
  const next = themeSetting(readStored());
  if (next !== current) {
    current = next;
    notify();
    return;
  }
  apply();
}

export function activeThemeSetting(): ThemeSetting {
  return current;
}

export function setThemeSetting(setting: ThemeSetting): void {
  current = setting;
  try {
    writeMigratedItem(localStorage, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, setting);
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts until the page is reloaded.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Follows the system while the setting is "system", choices and clears in other tabs, and external DOM/storage drift.
export function startThemeSync(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  stopCurrentSync?.();
  syncThemeFromStorage();

  const media = systemQuery();
  const onMediaChange = () => {
    if (current === 'system') notify();
  };
  const onStorage = (event: StorageEvent) => {
    // key === null means storage.clear() in another tab. Ignore sessionStorage events.
    if (event.key !== THEME_STORAGE_KEY && event.key !== LEGACY_THEME_STORAGE_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== localStorageOrNull()) return;
    const next = event.key === THEME_STORAGE_KEY ? themeSetting(event.newValue) : themeSetting(readStored());
    if (next !== current) {
      current = next;
      notify();
      return;
    }
    apply();
  };
  const onWindowSync = () => {
    syncThemeFromStorage();
  };
  const onBeforePrint = () => {
    printing = true;
  };
  const onAfterPrint = () => {
    printing = false;
    apply();
  };

  media?.addEventListener?.('change', onMediaChange);
  target.addEventListener('storage', onStorage as EventListener);
  target.addEventListener('focus', onWindowSync);
  target.addEventListener('pageshow', onWindowSync);
  target.addEventListener('beforeprint', onBeforePrint);
  target.addEventListener('afterprint', onAfterPrint);

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined' && typeof Node !== 'undefined' && typeof document !== 'undefined' && document.documentElement instanceof Node) {
    observer = new MutationObserver(() => {
      if (applying || printing) return;
      syncThemeFromStorage();
    });
    activeObserver = observer;
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  const stop = () => {
    media?.removeEventListener?.('change', onMediaChange);
    target.removeEventListener('storage', onStorage as EventListener);
    target.removeEventListener('focus', onWindowSync);
    target.removeEventListener('pageshow', onWindowSync);
    target.removeEventListener('beforeprint', onBeforePrint);
    target.removeEventListener('afterprint', onAfterPrint);
    observer?.disconnect();
    if (activeObserver === observer) activeObserver = null;
    if (stopCurrentSync === stop) stopCurrentSync = null;
  };
  stopCurrentSync = stop;
  return stop;
}

export function useThemeSetting(): [ThemeSetting, (setting: ThemeSetting) => void] {
  const setting = useSyncExternalStore(subscribe, activeThemeSetting, activeThemeSetting);
  return [setting, setThemeSetting];
}
