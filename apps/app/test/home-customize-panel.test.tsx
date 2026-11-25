// SPDX-License-Identifier: AGPL-3.0-only
// Interactive unit tests for HomeCustomizePanel drag guards, pending drop guards, and boundary focus retention (#4928).
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeLayoutBlock } from '@ludy/kernel-contract';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const hookDriver = vi.hoisted(() => ({
  states: [] as unknown[],
  stateCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initialState?: S | (() => S)) => {
      const idx = hookDriver.stateCursor++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initialState === 'function' ? (initialState as () => S)() : initialState);
      }
      const setState = (action: S | ((prev: S) => S)) => {
        const prev = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof action === 'function' ? (action as (p: S) => S)(prev) : action;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
    useRef: (<T,>(initialValue?: T) => {
      const idx = hookDriver.refCursor++;
      if (idx >= hookDriver.refs.length) {
        hookDriver.refs.push({ current: initialValue });
      }
      return hookDriver.refs[idx] as { current: T };
    }) as typeof actual.useRef,
  };
});

vi.mock('use-intl', () => ({
  useTranslations: (ns: string) => {
    const lookup = (root: Record<string, unknown>, path: string): unknown =>
      path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), root);
    const base = lookup(viMessages as unknown as Record<string, unknown>, ns) as Record<string, unknown>;
    return (key: string, params?: Record<string, string>) => {
      let msg = String(lookup(base, key) ?? `${ns}.${key}`);
      if (params) {
        for (const [k, v] of Object.entries(params)) msg = msg.replaceAll(`{${k}}`, v);
      }
      return msg;
    };
  },
}));

vi.mock('../src/lib/api.ts', () => ({
  errorMessage: (e: unknown) => String(e),
}));

const { HomeCustomizePanel } = await import('../src/components/home-customize-panel.tsx');

class FakeElement {
  private readonly matched: string;
  constructor(matched: string) {
    this.matched = matched;
  }
  closest(selector: string): this | null {
    return this.matched && selector.includes(this.matched) ? this : null;
  }
}

function findElements(node: ReactNode, testId: string): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const visit = (cur: ReactNode) => {
    if (!cur || typeof cur !== 'object') return;
    if (Array.isArray(cur)) {
      for (const child of cur) visit(child);
      return;
    }
    if (!isValidElement(cur)) return;
    const props = cur.props as Record<string, unknown>;
    if (props['data-testid'] === testId) out.push(cur as ReactElement<Record<string, unknown>>);
    if ('children' in props) visit(props.children as ReactNode);
  };
  visit(node);
  return out;
}

function mustFindElement(node: ReactNode, testId: string): ReactElement<Record<string, unknown>> {
  const [found] = findElements(node, testId);
  if (!found) throw new Error(`Missing element with data-testid=${testId}`);
  return found;
}

function renderPanel(props: {
  initialBlocks: readonly HomeLayoutBlock[];
  isPending?: boolean;
  onSave?: (blocks: HomeLayoutBlock[]) => void;
}) {
  hookDriver.stateCursor = 0;
  hookDriver.refCursor = 0;
  return HomeCustomizePanel({
    initialBlocks: props.initialBlocks,
    isPending: props.isPending ?? false,
    error: null,
    onSave: props.onSave ?? (() => undefined),
    onReset: () => undefined,
    onCancel: () => undefined,
  });
}

describe('HomeCustomizePanel interactions (#4928)', () => {
  beforeEach(() => {
    hookDriver.states = [];
    hookDriver.stateCursor = 0;
    hookDriver.refs = [];
    hookDriver.refCursor = 0;
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables row dragging when only one block exists', () => {
    const tree = renderPanel({ initialBlocks: [{ id: 'teamwork_my_work', visible: true }] });
    const row = mustFindElement(tree, 'home-customize-row-teamwork_my_work');
    expect(row.props.draggable).toBe(false);
  });

  it('blocks dragStart from [role="switch"], label, and button targets and clears the guard on pointerUp / dragEnd', () => {
    const blocks: HomeLayoutBlock[] = [
      { id: 'finance_tax_deadlines', visible: true },
      { id: 'teamwork_my_work', visible: true },
    ];
    const tree = renderPanel({ initialBlocks: blocks });
    const row = mustFindElement(tree, 'home-customize-row-finance_tax_deadlines');
    expect(row.props.draggable).toBe(true);

    const onPointerDown = row.props.onPointerDown as (e: { target: unknown }) => void;
    const onPointerUp = row.props.onPointerUp as () => void;
    const onDragStart = row.props.onDragStart as (e: { preventDefault: () => void; dataTransfer: { effectAllowed: string; setData: (t: string, v: string) => void } }) => void;

    for (const selector of ['[role="switch"]', 'label', 'button']) {
      onPointerDown({ target: new FakeElement(selector) });
      const preventDefault = vi.fn();
      const setData = vi.fn();
      onDragStart({ preventDefault, dataTransfer: { effectAllowed: '', setData } });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(setData).not.toHaveBeenCalled();
    }

    // Pointer-down on a blocked control followed by pointerUp without drag restores normal row dragging.
    onPointerDown({ target: new FakeElement('[role="switch"]') });
    onPointerUp();
    onPointerDown({ target: new FakeElement('') });
    const allowPrevent = vi.fn();
    const allowSetData = vi.fn();
    onDragStart({ preventDefault: allowPrevent, dataTransfer: { effectAllowed: '', setData: allowSetData } });
    expect(allowPrevent).not.toHaveBeenCalled();
    expect(allowSetData).toHaveBeenCalledWith('text/plain', 'finance_tax_deadlines');
  });

  it('ignores dragOver and drop while save mutation isPending', () => {
    const blocks: HomeLayoutBlock[] = [
      { id: 'finance_tax_deadlines', visible: true },
      { id: 'teamwork_my_work', visible: true },
    ];
    const tree = renderPanel({ initialBlocks: blocks, isPending: true });
    const row = mustFindElement(tree, 'home-customize-row-teamwork_my_work');
    expect(row.props.draggable).toBe(false);

    const overPrevent = vi.fn();
    (row.props.onDragOver as (e: { preventDefault: () => void }) => void)({ preventDefault: overPrevent });
    expect(overPrevent).not.toHaveBeenCalled();

    const dropPrevent = vi.fn();
    (row.props.onDrop as (e: { preventDefault: () => void; dataTransfer: { getData: () => string } }) => void)({
      preventDefault: dropPrevent,
      dataTransfer: { getData: () => 'finance_tax_deadlines' },
    });
    expect(dropPrevent).not.toHaveBeenCalled();
  });

  it('retains focus on the sibling Move button when reaching the top or bottom boundary via keyboard', () => {
    const blocks: HomeLayoutBlock[] = [
      { id: 'finance_tax_deadlines', visible: true },
      { id: 'teamwork_my_work', visible: true },
      { id: 'esign_pending', visible: true },
    ];
    const tree1 = renderPanel({ initialBlocks: blocks });
    const upFocusSecond = vi.fn();
    const downFocusSecond = vi.fn();

    // Attach ref callbacks for the middle row before clicking Move Up to index 0.
    for (const [id, fn] of [
      ['finance_tax_deadlines', vi.fn()],
      ['teamwork_my_work', downFocusSecond],
      ['esign_pending', vi.fn()],
    ] as const) {
      const downBtn = mustFindElement(tree1, `home-customize-down-${id}`);
      (downBtn.props.ref as ((el: { focus: typeof fn }) => void) | undefined)?.({ focus: fn });
    }
    const upBtnMiddle = mustFindElement(tree1, 'home-customize-up-teamwork_my_work');
    (upBtnMiddle.props.onClick as () => void)();
    expect(downFocusSecond).toHaveBeenCalledWith({ preventScroll: true });

    // Re-render updated order ([teamwork_my_work, finance_tax_deadlines, esign_pending]), then move finance_tax_deadlines down to last index.
    const tree2 = renderPanel({ initialBlocks: blocks });
    const upFirstAfterMove = mustFindElement(tree2, 'home-customize-up-teamwork_my_work');
    expect(upFirstAfterMove.props.disabled).toBe(true);

    const upBtnMiddleAfter = mustFindElement(tree2, 'home-customize-up-finance_tax_deadlines');
    (upBtnMiddleAfter.props.ref as ((el: { focus: typeof upFocusSecond }) => void) | undefined)?.({ focus: upFocusSecond });
    const downBtnMiddleAfter = mustFindElement(tree2, 'home-customize-down-finance_tax_deadlines');
    (downBtnMiddleAfter.props.onClick as () => void)();
    expect(upFocusSecond).toHaveBeenCalledWith({ preventScroll: true });

    const tree3 = renderPanel({ initialBlocks: blocks });
    const downLastAfterMove = mustFindElement(tree3, 'home-customize-down-finance_tax_deadlines');
    expect(downLastAfterMove.props.disabled).toBe(true);
  });
});
