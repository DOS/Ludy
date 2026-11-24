// SPDX-License-Identifier: AGPL-3.0-only
// Shared PhoneActionBar, PeekSheet (desktop footer vs mobile thumb-zone bar), and J/K Peek navigation guards (#4645).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import {
  hasBlockingOverlayForPeek,
  isInteractiveRowTarget,
  isPeekNavInputTarget,
  nextPeekIndex,
  peekDirectionFromKey,
  useListPeekNav,
} from '../src/lib/list-peek-nav.ts';

const mediaMock = { wide: null as boolean | null };

vi.mock('../src/lib/media.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/media.ts')>();
  return {
    ...actual,
    useMediaQuery: (query: string) => (mediaMock.wide !== null ? mediaMock.wide : actual.useMediaQuery(query)),
  };
});

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: { invalidateQueries: () => Promise.resolve() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  fetchFile: vi.fn(),
  getCurrentOrg: () => 'acme',
}));

const hookState = {
  active: false,
  clientExternalStore: false,
  states: [] as unknown[],
  stateIdx: 0,
  refs: [] as Array<{ current: unknown }>,
  refIdx: 0,
  ids: [] as string[],
  idIdx: 0,
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
  memoIdx: 0,
  callbacks: [] as Array<{ deps: readonly unknown[]; fn: unknown }>,
  cbIdx: 0,
  effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup?: (() => void) | void }>,
  effectIdx: 0,
  pendingEffects: [] as Array<{ idx: number; fn: () => void | (() => void) }>,
};

function depsChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!prev || !next || prev.length !== next.length) return true;
  return prev.some((v, i) => !Object.is(v, next[i]));
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => {
      if (!hookState.active) return actual.useId();
      const idx = hookState.idIdx++;
      if (!hookState.ids[idx]) hookState.ids[idx] = `peek-id-${idx}`;
      return hookState.ids[idx];
    },
    useState: (<S,>(init?: S | (() => S)) => {
      if (!hookState.active) return actual.useState(init as S);
      const idx = hookState.stateIdx++;
      if (!(idx in hookState.states)) {
        hookState.states[idx] = typeof init === 'function' ? (init as () => S)() : init;
      }
      const setState = (next: S | ((prev: S) => S)) => {
        const cur = hookState.states[idx] as S;
        hookState.states[idx] = typeof next === 'function' ? (next as (p: S) => S)(cur) : next;
      };
      return [hookState.states[idx] as S, setState];
    }) as typeof actual.useState,
    useRef: (<T,>(init?: T) => {
      if (!hookState.active) return actual.useRef(init as T);
      const idx = hookState.refIdx++;
      if (!hookState.refs[idx]) hookState.refs[idx] = { current: init };
      return hookState.refs[idx] as { current: T };
    }) as typeof actual.useRef,
    useMemo: (<T,>(factory: () => T, deps: readonly unknown[]) => {
      if (!hookState.active) return actual.useMemo(factory, deps);
      const idx = hookState.memoIdx++;
      const entry = hookState.memos[idx];
      if (!entry || depsChanged(entry.deps, deps)) {
        const next = { deps, value: factory() };
        hookState.memos[idx] = next;
        return next.value as T;
      }
      return entry.value as T;
    }) as typeof actual.useMemo,
    useCallback: (<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) => {
      if (!hookState.active) return actual.useCallback(fn, deps);
      const idx = hookState.cbIdx++;
      const entry = hookState.callbacks[idx];
      if (!entry || depsChanged(entry.deps, deps)) {
        const next = { deps, fn };
        hookState.callbacks[idx] = next;
        return next.fn as T;
      }
      return entry.fn as T;
    }) as typeof actual.useCallback,
    useSyncExternalStore: (<T,>(
      subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T => {
      if (hookState.clientExternalStore) return getSnapshot();
      return actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    }) as typeof actual.useSyncExternalStore,
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!hookState.active) return actual.useEffect(fn, deps);
      const idx = hookState.effectIdx++;
      const prev = hookState.effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.pendingEffects.push({ idx, fn });
        hookState.effects[idx] = { deps, cleanup: prev?.cleanup };
      }
    },
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? h('div', { 'data-slot': 'sheet' }, children) : null,
    SheetContent: ({
      children,
      closeLabel,
      side = 'right',
      ...rest
    }: {
      children?: ReactNode;
      closeLabel: string;
      side?: string;
      [k: string]: unknown;
    }) => h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-side': side, 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('div', { 'data-slot': 'sheet-body', className }, children),
    SheetFooter: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('footer', { 'data-slot': 'sheet-footer', className }, children),
  };
});

const { PeekSheet, PhoneActionBar } = await import('../src/components/ui.tsx');

function renderIntl(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale) as never}>
      {node}
    </IntlProvider>,
  );
}

class FakeElement implements EventTarget {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  isContentEditable = false;
  tabIndex = 0;
  isConnected = true;
  focused = false;
  scrolled = false;

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (matchesFakeSelector(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  closest(selector: string): FakeElement | null {
    return closestInFakeChain(this, selector);
  }

  contains(other: FakeElement | null): boolean {
    return containsInFakeChain(this, other);
  }

  focus(): void {
    this.focused = true;
  }

  scrollIntoView(): void {
    this.scrolled = true;
  }
}

function closestInFakeChain(start: FakeElement | null, selector: string): FakeElement | null {
  const tokens = selector.split(',').map((s) => s.trim());
  let cur = start;
  while (cur) {
    for (const token of tokens) {
      if (matchesFakeSelector(cur, token)) return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function containsInFakeChain(root: FakeElement, other: FakeElement | null): boolean {
  let cur = other;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

function matchesFakeSelector(el: FakeElement, token: string): boolean {
  if (!token) return false;
  if (token === '[contenteditable]:not([contenteditable="false"])') {
    const v = el.getAttribute('contenteditable');
    return v !== null && v !== 'false';
  }
  const attrMatch = token.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const attrName = attrMatch[1];
    const attrVal = attrMatch[2];
    if (!attrName) return false;
    const actual = el.getAttribute(attrName);
    return attrVal === undefined ? actual !== null : actual === attrVal;
  }
  if (token === 'dialog[open]') return el.tagName === 'DIALOG' && el.getAttribute('open') !== null;
  return el.tagName === token.toUpperCase();
}

beforeEach(() => {
  hookState.active = false;
  hookState.states = [];
  hookState.refs = [];
  hookState.ids = [];
  hookState.memos = [];
  hookState.callbacks = [];
  hookState.effects = [];
  hookState.pendingEffects = [];
});

afterEach(() => {
  hookState.active = false;
  hookState.clientExternalStore = false;
  mediaMock.wide = null;
  vi.unstubAllGlobals();
});

describe('PhoneActionBar & PeekSheet primitives', () => {
  it('renders sticky mobile bottom bar by default for full-page thumb zones without border+shadow', () => {
    const html = renderIntl(
      <PhoneActionBar aria-label="Thao tác">
        <button type="button">Duyệt</button>
      </PhoneActionBar>,
    );
    expect(html).toContain('data-testid="phone-action-bar"');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('fixed inset-x-0 bottom-0 z-20');
    expect(html).toContain('pb-[calc(0.75rem+env(safe-area-inset-bottom))]');
    expect(html).toContain('border-t border-border bg-sidebar');
    expect(html).toContain('[&amp;_button]:max-md:min-h-11');
    expect(html).not.toContain('shadow-');
  });

  it('supports sticky placement inside drawers cleanly', () => {
    const html = renderIntl(
      <PhoneActionBar placement="sticky">
        <a href="/open">Mở</a>
      </PhoneActionBar>,
    );
    expect(html).toContain('sticky bottom-0 z-20');
    expect(html).not.toContain('fixed inset-x-0 bottom-0');
    expect(html).toContain('[&amp;_a]:max-md:min-h-11');
  });

  it('places PeekSheet actions once in PhoneActionBar on mobile (< 640px) and once in SheetFooter on desktop', () => {
    mediaMock.wide = false;
    const mobileHtml = renderIntl(
      <PeekSheet
        open
        onClose={() => undefined}
        peekId="p1"
        data-testid="demo-peek"
        title="Hóa đơn #1"
        description="NCC Minh Anh"
        positionLabel="1 / 3"
        canPrevious={false}
        canNext
        onPrevious={() => undefined}
        onNext={() => undefined}
        actions={
          <button type="button" data-testid="demo-primary-action">
            Duyệt
          </button>
        }
      >
        <p>Chi tiết</p>
      </PeekSheet>,
    );
    expect(mobileHtml).toContain('data-peek-sheet="p1"');
    expect(mobileHtml).toContain('data-close-label="Đóng"');
    expect(mobileHtml).toContain('data-testid="phone-action-bar"');
    expect(mobileHtml).not.toContain('data-slot="sheet-footer"');
    expect(mobileHtml.match(/data-testid="demo-primary-action"/g)).toHaveLength(1);

    mediaMock.wide = true;
    const desktopHtml = renderIntl(
      <PeekSheet
        open
        onClose={() => undefined}
        peekId="p1"
        data-testid="demo-peek"
        title="Hóa đơn #1"
        canPrevious={false}
        canNext
        onPrevious={() => undefined}
        onNext={() => undefined}
        actions={
          <button type="button" data-testid="demo-primary-action">
            Duyệt
          </button>
        }
      >
        <p>Chi tiết</p>
      </PeekSheet>,
      'en',
    );
    expect(desktopHtml).toContain('data-slot="sheet-footer"');
    expect(desktopHtml).not.toContain('data-testid="phone-action-bar"');
    expect(desktopHtml.match(/data-testid="demo-primary-action"/g)).toHaveLength(1);
    expect(desktopHtml).toContain('data-close-label="Close"');
  });
});

describe('list-peek-nav keyboard & pointer guards', () => {
  it('detects J/K direction and blocks modifiers, repeats, inputs, textboxes, and comboboxes', () => {
    vi.stubGlobal('Element', FakeElement);
    const plain = new FakeElement('div');
    const input = new FakeElement('input');
    const textarea = new FakeElement('textarea');
    const select = new FakeElement('select');
    const editable = new FakeElement('div', { contenteditable: 'true' });
    const nonEditable = new FakeElement('div', { contenteditable: 'false' });
    const combo = new FakeElement('div', { role: 'combobox' });
    const textbox = new FakeElement('div', { role: 'textbox' });
    const nestedChild = new FakeElement('span');
    nestedChild.parent = combo;

    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, target: plain })).toBe(1);
    expect(peekDirectionFromKey({ key: 'K', metaKey: false, ctrlKey: false, altKey: false, target: plain })).toBe(-1);
    expect(peekDirectionFromKey({ key: 'j', metaKey: true, ctrlKey: false, altKey: false, target: plain })).toBeNull();
    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: true, altKey: false, target: plain })).toBeNull();
    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: true, target: plain })).toBeNull();
    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, repeat: true, target: plain })).toBeNull();
    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, isComposing: true, target: plain })).toBeNull();

    for (const blocker of [input, textarea, select, editable, combo, textbox, nestedChild]) {
      expect(isPeekNavInputTarget(blocker)).toBe(true);
      expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, target: blocker })).toBeNull();
      expect(
        peekDirectionFromKey({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, target: plain }, blocker as unknown as Element),
      ).toBeNull();
    }
    expect(isPeekNavInputTarget(nonEditable)).toBe(false);
    expect(peekDirectionFromKey({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, target: nonEditable })).toBe(1);
  });

  it('ignores nested interactive targets in rows while allowing plain row taps', () => {
    vi.stubGlobal('Element', FakeElement);
    const link = new FakeElement('a');
    const btn = new FakeElement('button');
    const checkbox = new FakeElement('div', { role: 'checkbox' });
    const spanInButton = new FakeElement('span');
    spanInButton.parent = btn;
    const plainCell = new FakeElement('td');

    expect(isInteractiveRowTarget(link)).toBe(true);
    expect(isInteractiveRowTarget(btn)).toBe(true);
    expect(isInteractiveRowTarget(checkbox)).toBe(true);
    expect(isInteractiveRowTarget(spanInButton)).toBe(true);
    expect(isInteractiveRowTarget(plainCell)).toBe(false);
  });

  it('detects active overlays while ignoring own PeekSheet, closed <dialog> CommandPalette listboxes, and [data-closed] popups', () => {
    vi.stubGlobal('Element', FakeElement);
    const ownSheet = new FakeElement('section', { 'data-slot': 'sheet-content', 'data-peek-sheet': 'peek-1' });
    const closedDialog = new FakeElement('dialog');
    const closedPaletteListbox = new FakeElement('ul', { role: 'listbox' });
    closedDialog.append(closedPaletteListbox);
    const closingPopover = new FakeElement('div', { 'data-slot': 'popover-content', 'data-closed': '' });
    const openDialog = new FakeElement('dialog', { open: '' });
    const otherDialog = new FakeElement('div', { 'data-slot': 'dialog-content' });

    const rootWithClosed = {
      querySelectorAll: (selector: string) =>
        [ownSheet, closedDialog, closedPaletteListbox, closingPopover].filter((el) =>
          selector.split(',').some((tok) => {
            const clean = tok.trim();
            if (clean === 'dialog[open]') return el.tagName === 'DIALOG' && el.getAttribute('open') !== null;
            if (clean.includes(':not([data-closed])')) {
              const base = clean.replace(':not([data-closed])', '');
              return el.getAttribute('data-closed') === null && el.closest(base) === el;
            }
            return false;
          }),
        ) as unknown as NodeListOf<Element>,
    };
    expect(hasBlockingOverlayForPeek('peek-1', rootWithClosed)).toBe(false);

    expect(
      hasBlockingOverlayForPeek('peek-1', {
        querySelectorAll: () => [ownSheet, otherDialog] as unknown as NodeListOf<Element>,
      }),
    ).toBe(true);
    expect(
      hasBlockingOverlayForPeek('peek-1', {
        querySelectorAll: () => [openDialog] as unknown as NodeListOf<Element>,
      }),
    ).toBe(true);
    expect(nextPeekIndex(-1, 3, 1)).toBe(0);
    expect(nextPeekIndex(1, 3, -1)).toBe(0);
  });

  it('steps via window J/K across one active queue at a time and returns focus on close', () => {
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('Node', { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });

    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const scheduledTimeouts: Array<() => void> = [];
    const docBody = new FakeElement('body');
    const triggerA = new FakeElement('button', { 'data-peek-trigger': 'a' });
    const rowA = new FakeElement('div', { 'data-peek-row': 'a' });
    rowA.append(triggerA);

    const triggerB = new FakeElement('button', { 'data-peek-trigger': 'b' });
    const rowB = new FakeElement('div', { 'data-peek-row': 'b' });
    rowB.append(triggerB);

    const overlays: FakeElement[] = [];
    const docStub = {
      body: docBody,
      activeElement: docBody as unknown as Element,
      querySelector: (sel: string) => (sel.includes('dialog') && overlays.length > 0 ? overlays[0] : null),
      querySelectorAll: () => overlays as unknown as NodeListOf<Element>,
    };
    const winStub = {
      addEventListener: (type: string, cb: (ev: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: (ev: unknown) => void) => {
        listeners.get(type)?.delete(cb);
      },
      setTimeout: (fn: () => void) => {
        scheduledTimeouts.push(fn);
        return 1;
      },
    };
    vi.stubGlobal('document', docStub);
    vi.stubGlobal('window', winStub);

    const container1 = {
      contains: (el: FakeElement | null) => el === rowA || el === rowB || el === triggerA || el === triggerB,
      querySelector: (sel: string) => {
        if (sel.includes('[data-peek-trigger="a"]')) return triggerA;
        if (sel.includes('[data-peek-trigger="b"]')) return triggerB;
        if (sel.includes('[data-peek-row="a"]')) return rowA;
        if (sel.includes('[data-peek-row="b"]')) return rowB;
        return null;
      },
      compareDocumentPosition: () => 4,
    } as unknown as HTMLElement;

    const container2 = {
      contains: () => false,
      querySelector: () => null,
      compareDocumentPosition: () => 2,
    } as unknown as HTMLElement;

    const items1 = [{ id: 'a' }, { id: 'b' }];
    const items2 = [{ id: 'x' }];

    function renderHookPass() {
      hookState.active = true;
      hookState.stateIdx = 0;
      hookState.refIdx = 0;
      hookState.idIdx = 0;
      hookState.memoIdx = 0;
      hookState.cbIdx = 0;
      hookState.effectIdx = 0;
      hookState.pendingEffects = [];

      const nav1 = useListPeekNav({
        items: items1,
        getId: (i) => i.id,
        containerRef: { current: container1 },
      });
      const nav2 = useListPeekNav({
        items: items2,
        getId: (i) => i.id,
        containerRef: { current: container2 },
      });

      const pending = [...hookState.pendingEffects];
      hookState.pendingEffects = [];
      for (const eff of pending) {
        const oldCleanup = hookState.effects[eff.idx]?.cleanup;
        if (typeof oldCleanup === 'function') oldCleanup();
        hookState.effects[eff.idx] = { deps: hookState.effects[eff.idx]?.deps, cleanup: eff.fn() };
      }
      hookState.active = false;
      return { nav1, nav2 };
    }

    let state = renderHookPass();
    expect(state.nav1.open).toBe(false);
    expect(state.nav2.open).toBe(false);

    let prevented = false;
    const keyEvent = (key: string) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      repeat: false,
      defaultPrevented: false,
      target: docBody,
      preventDefault: () => {
        prevented = true;
      },
    });

    for (const cb of listeners.get('keydown') ?? []) cb(keyEvent('j'));
    expect(prevented).toBe(true);
    state = renderHookPass();
    expect(state.nav1.open).toBe(true);
    expect(state.nav1.selectedId).toBe('a');
    expect(state.nav2.open).toBe(false);
    expect(rowA.scrolled).toBe(true);

    for (const cb of listeners.get('keydown') ?? []) cb(keyEvent('j'));
    state = renderHookPass();
    expect(state.nav1.selectedId).toBe('b');
    expect(rowB.scrolled).toBe(true);

    // Clicking inside an interactive button inside a row does not trigger peek; tapping row body does.
    state.nav1.closePeek();
    state = renderHookPass();
    expect(state.nav1.open).toBe(false);
    for (const fn of scheduledTimeouts.splice(0)) fn();
    expect(triggerB.focused).toBe(true);

    const buttonInRow = new FakeElement('button');
    state.nav1.onRowClick('a', { target: buttonInRow, currentTarget: rowA as unknown as HTMLElement });
    state = renderHookPass();
    expect(state.nav1.open).toBe(false);

    const cellInRow = new FakeElement('td');
    state.nav1.onRowClick('a', { target: cellInRow, currentTarget: rowA as unknown as HTMLElement });
    state = renderHookPass();
    expect(state.nav1.open).toBe(true);
    expect(state.nav1.selectedId).toBe('a');

    // Blocking external dialog halts J/K stepping until closed.
    overlays.push(new FakeElement('div', { role: 'dialog', 'data-peek-sheet': 'other-dialog' }));
    for (const cb of listeners.get('keydown') ?? []) cb(keyEvent('j'));
    state = renderHookPass();
    expect(state.nav1.selectedId).toBe('a');

    // Cleanup removes listeners on unmount.
    for (const eff of hookState.effects) {
      if (typeof eff?.cleanup === 'function') eff.cleanup();
    }
  });

  it('closes stale drawerOpen when active item leaves list or resetKey switches and recovers container focus', () => {
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('Node', { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });

    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const scheduledTimeouts: Array<() => void> = [];
    const docBody = new FakeElement('body');
    const survivingTrigger = new FakeElement('button', { 'data-peek-trigger': 'b' });
    const container = {
      contains: () => false,
      querySelector: (sel: string) => (sel.includes('[data-peek-trigger]') ? survivingTrigger : null),
      compareDocumentPosition: () => 4,
    } as unknown as HTMLElement;

    vi.stubGlobal('document', {
      body: docBody,
      activeElement: docBody as unknown as Element,
      querySelector: () => null,
      querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    });
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: (ev: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: (ev: unknown) => void) => {
        listeners.get(type)?.delete(cb);
      },
      setTimeout: (fn: () => void) => {
        scheduledTimeouts.push(fn);
        return 1;
      },
    });

    let currentItems = [{ id: 'a' }, { id: 'b' }];
    let currentResetKey = 'org-1';

    function runPass() {
      hookState.active = true;
      hookState.stateIdx = 0;
      hookState.refIdx = 0;
      hookState.idIdx = 0;
      hookState.memoIdx = 0;
      hookState.cbIdx = 0;
      hookState.effectIdx = 0;
      hookState.pendingEffects = [];

      const nav = useListPeekNav({
        items: currentItems,
        getId: (i) => i.id,
        containerRef: { current: container },
        resetKey: currentResetKey,
      });

      const pending = [...hookState.pendingEffects];
      hookState.pendingEffects = [];
      for (const eff of pending) {
        const oldCleanup = hookState.effects[eff.idx]?.cleanup;
        if (typeof oldCleanup === 'function') oldCleanup();
        hookState.effects[eff.idx] = { deps: hookState.effects[eff.idx]?.deps, cleanup: eff.fn() };
      }
      hookState.active = false;
      return nav;
    }

    let nav = runPass();
    nav.openPeek('a');
    nav = runPass();
    expect(nav.open).toBe(true);

    // Simulate item 'a' approved & removed from queue: drawerOpen must reset cleanly and recover focus on surviving trigger.
    currentItems = [{ id: 'b' }];
    nav = runPass();
    nav = runPass();
    expect(nav.open).toBe(false);
    for (const fn of scheduledTimeouts.splice(0)) fn();
    expect(survivingTrigger.focused).toBe(true);

    // Re-adding an item with the same id later must NOT pop the drawer back open.
    currentItems = [{ id: 'a' }, { id: 'b' }];
    nav = runPass();
    expect(nav.open).toBe(false);

    // Switching resetKey clears open drawer and selection without jumping focus into containerRef.
    nav.openPeek('b');
    nav = runPass();
    expect(nav.open).toBe(true);
    survivingTrigger.focused = false;
    currentItems = [{ id: 'c' }];
    currentResetKey = 'org-2';
    nav = runPass();
    nav = runPass();
    expect(nav.open).toBe(false);
    expect(nav.selectedId).toBeNull();
    for (const fn of scheduledTimeouts.splice(0)) fn();
    expect(survivingTrigger.focused).toBe(false);
  });
});
