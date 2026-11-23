// SPDX-License-Identifier: AGPL-3.0-only
// Desktop sidebar secondary-panel collapse state (#4519): persisted per device in localStorage,
// SSR-safe, storage-error-safe, synced across tabs, and guarded for the `[` focus shortcut.
import { useSyncExternalStore } from 'react';
import { isSettingsPath, type AppId, type InstalledApp } from './apps.ts';
import { isEditableTarget } from './quick-add.ts';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'ludy-sidebar-collapsed';

const listeners = new Set<() => void>();
let memoryCollapsed = false;
let stopStorageListener: (() => void) | null = null;

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseStoredCollapsed(value: string | null): boolean {
  return value === '1' || value === 'true';
}

export function readSidebarCollapsed(): boolean {
  const store = localStorageOrNull();
  if (!store) return memoryCollapsed;
  try {
    const raw = store.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    const parsed = parseStoredCollapsed(raw);
    memoryCollapsed = parsed;
    return parsed;
  } catch {
    return memoryCollapsed;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setSidebarCollapsed(next: boolean | ((prev: boolean) => boolean)): void {
  const resolved = typeof next === 'function' ? next(readSidebarCollapsed()) : next;
  memoryCollapsed = resolved;
  const store = localStorageOrNull();
  if (store) {
    try {
      if (resolved) store.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
      else store.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode or blocked quota): keep in memory for this session.
    }
  }
  notify();
}

function attachStorageSync(): void {
  if (stopStorageListener || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  memoryCollapsed = readSidebarCollapsed();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== localStorageOrNull()) return;
    const prev = memoryCollapsed;
    const next = event.key === SIDEBAR_COLLAPSED_STORAGE_KEY ? parseStoredCollapsed(event.newValue) : readSidebarCollapsed();
    if (next !== prev) {
      memoryCollapsed = next;
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  stopStorageListener = () => {
    window.removeEventListener('storage', onStorage);
    stopStorageListener = null;
  };
}

export function subscribeSidebarCollapsed(listener: () => void): () => void {
  listeners.add(listener);
  attachStorageSync();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopStorageListener?.();
  };
}

export function useSidebarCollapsed(): readonly [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const collapsed = useSyncExternalStore(subscribeSidebarCollapsed, readSidebarCollapsed, () => false);
  return [collapsed, setSidebarCollapsed] as const;
}

/** Whether the current route owns a secondary sidebar menu (an installed App or Settings). */
export function hasSecondaryNav(app: AppId | null, apps: readonly InstalledApp[], pathname: string): boolean {
  return (app !== null && apps.some((a) => a.id === app)) || isSettingsPath(pathname);
}

export interface SidebarToggleKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat?: boolean | undefined;
  defaultPrevented?: boolean | undefined;
  isComposing?: boolean | undefined;
  target?: EventTarget | null | undefined;
}

/**
 * True when pressing `[` should toggle the desktop secondary sidebar menu:
 * only on App or Settings routes, on desktop width, with no modal open, no Ctrl/Meta/Alt modifiers,
 * and never while focus or event target is inside an input, textarea, select, or contenteditable field.
 */
export function isSidebarToggleShortcut(
  event: SidebarToggleKeyLike,
  opts: {
    hasSecondary: boolean;
    modalOpen?: boolean | undefined;
    isDesktop?: boolean | undefined;
    activeElement?: unknown;
  },
): boolean {
  if (!opts.hasSecondary || opts.modalOpen || opts.isDesktop === false) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.key !== '[') return false;
  if (isEditableTarget(opts.activeElement) || isEditableTarget(event.target)) return false;
  return true;
}
