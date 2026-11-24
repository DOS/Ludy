// SPDX-License-Identifier: AGPL-3.0-only
// Shared J/K list keyboard navigation and Peek Sheet selection state (#4645).
// Supports single-queue screens (Documents, SignEnvelopes, TodayList) and multi-queue screens (HR approvals)
// without triggering inside text inputs, comboboxes, or when another modal/drawer is open (WCAG 2.1.4).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { steppedIndex } from './review.ts';

export const TEXT_INPUT_GUARD_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="textbox"]';

export const OVERLAY_GUARD_SELECTOR = [
  'dialog[open]',
  '[role="dialog"]:not([data-closed])',
  '[role="alertdialog"]:not([data-closed])',
  '[data-slot="dialog-content"]:not([data-closed])',
  '[data-slot="sheet-content"]:not([data-closed])',
  '[data-slot="popover-content"]:not([data-closed])',
  '[data-slot="select-content"]:not([data-closed])',
  '[data-slot="menu-content"]:not([data-closed])',
  '[data-slot="dropdown-menu-content"]:not([data-closed])',
  '[role="menu"]:not([data-closed])',
].join(', ');

const INTERACTIVE_ROW_CHILD_SELECTOR =
  'a, button, input, select, textarea, label, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"]';

export function isInteractiveRowTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE_ROW_CHILD_SELECTOR));
}

export function isPeekNavInputTarget(node: EventTarget | Element | null): boolean {
  if (!node) return false;
  const el = node as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  const contentEditable = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
  if (contentEditable !== null && contentEditable !== 'false') return true;
  return typeof el.closest === 'function' && el.closest(TEXT_INPUT_GUARD_SELECTOR) !== null;
}

export function hasBlockingOverlayForPeek(peekId: string, root: Pick<Document, 'querySelectorAll'> | null | undefined): boolean {
  if (!root) return false;
  for (const overlay of root.querySelectorAll(OVERLAY_GUARD_SELECTOR)) {
    if (overlay.getAttribute('data-peek-sheet') === peekId) continue;
    if (typeof overlay.closest === 'function' && overlay.closest('dialog:not([open])')) continue;
    if (overlay.getAttribute('aria-hidden') === 'true' || overlay.getAttribute('hidden') !== null) continue;
    return true;
  }
  return false;
}

export interface PeekKeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

export function peekDirectionFromKey(event: PeekKeyEventLike, activeElement: Element | null = null): 1 | -1 | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented || event.isComposing) {
    return null;
  }
  const lower = event.key.toLowerCase();
  if (lower !== 'j' && lower !== 'k') return null;
  if (isPeekNavInputTarget(event.target) || isPeekNavInputTarget(activeElement)) return null;
  return lower === 'j' ? 1 : -1;
}

export function nextPeekIndex(currentIndex: number, length: number, step: 1 | -1): number | null {
  return steppedIndex(currentIndex, length, step);
}

interface RegistryEntry {
  id: string;
  enabled: () => boolean;
  isOpen: () => boolean;
  hasItems: () => boolean;
  containsActive: (active: Element | null) => boolean;
  orderElement: () => HTMLElement | null;
}

const activeRegistry = new Set<RegistryEntry>();

function isOwnerEntry(entry: RegistryEntry, active: Element | null): boolean {
  const candidates = [...activeRegistry].filter((item) => item.enabled());
  const opened = candidates.find((item) => item.isOpen());
  if (opened) return opened.id === entry.id;

  const nonEmpty = candidates.filter((item) => item.hasItems());
  if (nonEmpty.length === 0) return false;

  const focused = nonEmpty.find((item) => item.containsActive(active));
  if (focused) return focused.id === entry.id;

  // When focus is outside all containers (for example on document.body), let only the first mounted
  // non-empty queue in DOM order respond so multi-queue screens never open multiple Peek Sheets at once.
  const ordered = [...nonEmpty].sort((a, b) => {
    const elA = a.orderElement();
    const elB = b.orderElement();
    if (!elA || !elB || elA === elB) return 0;
    const pos = elA.compareDocumentPosition(elB);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return ordered[0]?.id === entry.id;
}

export interface UseListPeekNavOptions<T> {
  items: readonly T[];
  getId: (item: T) => string;
  containerRef?: RefObject<HTMLElement | null> | undefined;
  enabled?: boolean | undefined;
  resetKey?: string | number | undefined;
}

export interface ListPeekNav<T> {
  peekId: string;
  open: boolean;
  selectedId: string | null;
  activeItem: T | null;
  activeIndex: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  openPeek: (id: string, trigger?: HTMLElement | null) => void;
  closePeek: () => void;
  step: (delta: 1 | -1) => void;
  onRowClick: (id: string, event: { target: EventTarget | null; currentTarget: HTMLElement }) => void;
}

function escapeSelectorAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function useListPeekNav<T>({
  items,
  getId,
  containerRef,
  enabled = true,
  resetKey,
}: UseListPeekNavOptions<T>): ListPeekNav<T> {
  const peekId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const prevResetKeyRef = useRef(resetKey);
  const justResetRef = useRef(false);

  const ids = useMemo(() => items.map(getId), [items, getId]);
  const activeIndex = selectedId !== null ? ids.indexOf(selectedId) : -1;
  const activeItem = drawerOpen && activeIndex >= 0 ? (items[activeIndex] ?? null) : null;
  const effectiveOpen = activeItem !== null;

  const focusReturnTarget = useCallback(
    (id: string | null, fallbackToContainer = false) => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      window.setTimeout(() => {
        if (hasBlockingOverlayForPeek(peekId, document)) return;
        const container = containerRef?.current;
        if (id && container) {
          const safeId = escapeSelectorAttr(id);
          const trigger =
            container.querySelector<HTMLElement>(`[data-peek-trigger="${safeId}"]`) ??
            container.querySelector<HTMLElement>(`[data-peek-row="${safeId}"]`);
          if (trigger && trigger.isConnected && trigger.tabIndex >= 0) {
            trigger.focus();
            return;
          }
        }
        const opener = openerRef.current;
        if (opener && opener !== document.body && opener.isConnected) {
          opener.focus();
          return;
        }
        if (fallbackToContainer && container) {
          const nextTrigger = container.querySelector<HTMLElement>('[data-peek-trigger], a, button');
          if (nextTrigger && nextTrigger.isConnected && nextTrigger.tabIndex >= 0) {
            nextTrigger.focus();
          }
        }
      }, 0);
    },
    [containerRef, peekId],
  );

  useEffect(() => {
    if (Object.is(prevResetKeyRef.current, resetKey)) return;
    prevResetKeyRef.current = resetKey;
    justResetRef.current = true;
    openerRef.current = null;
    setDrawerOpen(false);
    setSelectedId(null);
  }, [resetKey]);

  useEffect(() => {
    if (justResetRef.current) {
      justResetRef.current = false;
      return;
    }
    if (!drawerOpen || activeIndex >= 0) return;
    setDrawerOpen(false);
    focusReturnTarget(null, true);
  }, [activeIndex, drawerOpen, focusReturnTarget]);

  const openPeek = useCallback((id: string, trigger?: HTMLElement | null) => {
    const resolvedTrigger =
      trigger ??
      (typeof document !== 'undefined' && typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    if (resolvedTrigger) openerRef.current = resolvedTrigger;
    setSelectedId(id);
    setDrawerOpen(true);
  }, []);

  const closePeek = useCallback(() => {
    const closingId = selectedId;
    setDrawerOpen(false);
    focusReturnTarget(closingId);
  }, [focusReturnTarget, selectedId]);

  const scrollRowIntoView = useCallback(
    (id: string) => {
      const container = containerRef?.current;
      if (!container) return;
      const safeId = escapeSelectorAttr(id);
      const row = container.querySelector<HTMLElement>(`[data-peek-row="${safeId}"]`);
      row?.scrollIntoView?.({ block: 'nearest' });
    },
    [containerRef],
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      const nextIdx = nextPeekIndex(activeIndex, items.length, delta);
      if (nextIdx === null) return;
      const target = items[nextIdx];
      if (!target) return;
      const nextId = getId(target);
      setSelectedId(nextId);
      setDrawerOpen(true);
      scrollRowIntoView(nextId);
    },
    [activeIndex, getId, items, scrollRowIntoView],
  );

  const onRowClick = useCallback(
    (id: string, event: { target: EventTarget | null; currentTarget: HTMLElement }) => {
      if (isInteractiveRowTarget(event.target)) return;
      const safeId = escapeSelectorAttr(id);
      const trigger = event.currentTarget.querySelector<HTMLElement>(`[data-peek-trigger="${safeId}"]`);
      openPeek(id, trigger ?? event.currentTarget);
    },
    [openPeek],
  );

  const latestRef = useRef({
    enabled,
    effectiveOpen,
    items,
    ids,
    selectedId,
    activeIndex,
    openPeek,
    scrollRowIntoView,
  });
  latestRef.current = {
    enabled,
    effectiveOpen,
    items,
    ids,
    selectedId,
    activeIndex,
    openPeek,
    scrollRowIntoView,
  };

  useEffect(() => {
    const entry: RegistryEntry = {
      id: peekId,
      enabled: () => latestRef.current.enabled,
      isOpen: () => latestRef.current.effectiveOpen,
      hasItems: () => latestRef.current.items.length > 0,
      containsActive: (active) => Boolean(active && containerRef?.current?.contains(active)),
      orderElement: () => containerRef?.current ?? null,
    };
    activeRegistry.add(entry);

    const onKeyDown = (event: KeyboardEvent) => {
      const current = latestRef.current;
      if (!current.enabled || current.items.length === 0) return;
      const direction = peekDirectionFromKey(event, document.activeElement);
      if (!direction) return;
      if (hasBlockingOverlayForPeek(peekId, document)) return;
      if (!isOwnerEntry(entry, document.activeElement)) return;

      let curIdx = current.activeIndex;
      if (!current.effectiveOpen && containerRef?.current && document.activeElement instanceof Element) {
        const rowAttr =
          document.activeElement.closest('[data-peek-trigger]')?.getAttribute('data-peek-trigger') ??
          document.activeElement.closest('[data-peek-row]')?.getAttribute('data-peek-row');
        if (rowAttr) {
          const focusedIdx = current.ids.indexOf(rowAttr);
          if (focusedIdx >= 0) curIdx = focusedIdx;
        }
      }

      const nextIdx = nextPeekIndex(curIdx, current.items.length, direction);
      if (nextIdx === null) return;
      const nextId = current.ids[nextIdx];
      if (!nextId) return;

      event.preventDefault();
      if (!current.effectiveOpen) {
        const container = containerRef?.current;
        const safeId = escapeSelectorAttr(nextId);
        const trigger =
          (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null) ?? container?.querySelector<HTMLElement>(`[data-peek-trigger="${safeId}"]`);
        current.openPeek(nextId, trigger ?? null);
      } else {
        setSelectedId(nextId);
        setDrawerOpen(true);
      }
      current.scrollRowIntoView(nextId);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      activeRegistry.delete(entry);
    };
  }, [containerRef, peekId]);

  return {
    peekId,
    open: effectiveOpen,
    selectedId: activeIndex >= 0 ? selectedId : null,
    activeItem,
    activeIndex,
    total: items.length,
    canPrevious: activeIndex > 0,
    canNext: activeIndex >= 0 && activeIndex < items.length - 1,
    openPeek,
    closePeek,
    step,
    onRowClick,
  };
}
