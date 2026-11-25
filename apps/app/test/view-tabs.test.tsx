// SPDX-License-Identifier: AGPL-3.0-only
// The tabs of saved views (CRM K3 and K4, #2227, #2228), rendered on the server with the list answered from a seeded cache:
// "Tất cả" first, the member's own views, then the org's shared ones with their badge; what the tabs offer depends on
// whether the screen's filter moved away from the picked view and on who may change it.
import { QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider, createTranslator } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterAst, SavedViewSort } from '@ludy/kernel-contract';
import type { ViewState } from '../src/components/view-tabs.tsx';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { EMPTY_TASK_FILTER, astToTaskFilter, selectTaskDue, selectTaskStatus, taskFilterToAst } from '../src/lib/task-filter.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const hookDriver = vi.hoisted(() => ({
  active: false,
  states: [] as unknown[],
  stateIdx: 0,
  refs: [] as Array<{ current: unknown }>,
  refIdx: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initial?: S | (() => S)) => {
      if (!hookDriver.active) return actual.useState(initial as S);
      const idx = hookDriver.stateIdx++;
      if (!(idx in hookDriver.states)) {
        hookDriver.states[idx] = typeof initial === 'function' ? (initial as () => S)() : initial;
      }
      const setState = (next: S | ((prev: S) => S)) => {
        const cur = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof next === 'function' ? (next as (p: S) => S)(cur) : next;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
    useRef: (<T,>(initial?: T) => {
      if (!hookDriver.active) return actual.useRef(initial as T);
      const idx = hookDriver.refIdx++;
      if (!(idx in hookDriver.refs)) hookDriver.refs[idx] = { current: initial };
      return hookDriver.refs[idx] as { current: T };
    }) as typeof actual.useRef,
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!hookDriver.active) return actual.useEffect(effect, deps);
    },
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: ((opts: { queryKey: readonly unknown[] }) => {
      if (!hookDriver.active) return actual.useQuery(opts as Parameters<typeof actual.useQuery>[0]);
      const data = client.current.getQueryData(opts.queryKey);
      return { data, error: null, isSuccess: data !== undefined, isFetching: false };
    }) as typeof actual.useQuery,
    useMutation: ((opts: Parameters<typeof actual.useMutation>[0]) => {
      if (!hookDriver.active) return actual.useMutation(opts);
      return { isPending: false, error: null, mutate: vi.fn(), reset: vi.fn() };
    }) as typeof actual.useMutation,
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (o?: { input?: unknown }) => ({ queryKey: [...path, o?.input ?? null], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node(['client']), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { ViewTabs, completeSavedViewCreate } = await import('../src/components/view-tabs.tsx');

const ME = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';
const at = '2026-11-01T00:00:00.000Z';
const none: FilterAst = { v: 1, all: [] };
const views = [
  { id: '00000000-0000-7000-8000-0000000000a1', scope: 'crm.party', name: 'Công ty có email', filters: { v: 1, all: [{ field: 'kind', op: 'is', value: 'organization' }] }, sort: null, shared: false, ownerId: ME, mine: true, canChange: true, updatedAt: at },
  { id: '00000000-0000-7000-8000-0000000000a2', scope: 'crm.party', name: 'Của nhóm', filters: { v: 1, all: [] }, sort: { field: 'name', dir: 'desc' }, shared: true, ownerId: OTHER, mine: false, canChange: false, updatedAt: at },
];

function render(role: 'owner' | 'member' | 'viewer', filters: FilterAst = none): string {
  const qc = client.current;
  qc.setQueryData(['org', 'get', null], { role });
  qc.setQueryData(['savedViews', 'list', { scope: 'crm.party' }], views);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <ViewTabs scope="crm.party" filters={filters} sort={null} onApply={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function findElements(node: ReactNode, predicate: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (!n || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (isValidElement(n)) {
      const el = n as ReactElement<Record<string, unknown>>;
      if (predicate(el)) matches.push(el);
      if (el.props && 'children' in el.props) walk(el.props.children as ReactNode);
    }
  };
  walk(node);
  return matches;
}

describe('ViewTabs', () => {
  beforeEach(() => {
    client.current.clear();
    hookDriver.active = false;
    hookDriver.states = [];
    hookDriver.stateIdx = 0;
    hookDriver.refs = [];
    hookDriver.refIdx = 0;
  });

  it('shows no strip while there is no saved view and the filter is as it was (#3647): one lone "Tất cả" tab does nothing', () => {
    const qc = client.current;
    qc.setQueryData(['org', 'get', null], { role: 'member' });
    qc.setQueryData(['savedViews', 'list', { scope: 'crm.party' }], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')}>
          <ViewTabs scope="crm.party" filters={none} sort={null} onApply={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });

  it('comes with a changed filter, to offer saving it', () => {
    const qc = client.current;
    qc.setQueryData(['org', 'get', null], { role: 'member' });
    qc.setQueryData(['savedViews', 'list', { scope: 'crm.party' }], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')}>
          <ViewTabs scope="crm.party" filters={{ v: 1, all: [{ field: 'kind', op: 'is', value: 'person' }] }} sort={null} onApply={() => undefined} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain(viMessages.savedViews.all);
    expect(html).toContain(viMessages.savedViews.save);
  });

  it('lists "Tất cả", then the member’s own views, then the shared ones with their badge', () => {
    const html = render('member');
    const order = [viMessages.savedViews.all, 'Công ty có email', 'Của nhóm'].map((label) => html.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only the other member's shared view carries the badge: Công ty có email is private.
    expect(html.split(viMessages.savedViews.sharedBadge)).toHaveLength(2);
  });

  it('offers to save a filter that is not a view yet, and nothing while the list is unfiltered', () => {
    expect(render('member')).not.toContain(viMessages.savedViews.save);
    const moved = render('member', { v: 1, all: [{ field: 'search', op: 'contains', value: 'nguyen' }] });
    expect(moved).toContain(`>${viMessages.savedViews.save}<`);
  });

  it('renders for a viewer too, who reads the views and keeps private ones of their own', () => {
    const html = render('viewer', { v: 1, all: [{ field: 'kind', op: 'is', value: 'person' }] });
    expect(html).toContain('Của nhóm');
    expect(html).toContain(`>${viMessages.savedViews.save}<`);
  });

  it('activates the created tab only when no other tab was picked while refresh was pending', async () => {
    let seq = 1;
    let activated: string | null = null;
    let closed = 0;

    const applied = await completeSavedViewCreate({
      viewId: 'view-1',
      seqAtStart: seq,
      currentSeq: () => seq,
      refresh: () => Promise.resolve(),
      selectCreated: (id) => {
        activated = id;
      },
      closeForm: () => {
        closed += 1;
      },
    });
    expect(applied).toBe(true);
    expect(activated).toBe('view-1');
    expect(closed).toBe(1);

    // Simulate user picking "Tất cả" while refresh() is still in flight.
    activated = null;
    closed = 0;
    const seqAtSave = seq;
    let resolveRefresh!: () => void;
    const pending = completeSavedViewCreate({
      viewId: 'view-2',
      seqAtStart: seqAtSave,
      currentSeq: () => seq,
      refresh: () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
      selectCreated: (id) => {
        activated = id;
      },
      closeForm: () => {
        closed += 1;
      },
    });
    seq += 1;
    resolveRefresh();
    const cancelled = await pending;
    expect(cancelled).toBe(false);
    expect(activated).toBeNull();
    expect(closed).toBe(1);
  });

  it('does not mark an untouched API-created singleton status:in task view dirty, while real edits show Update (#3457)', () => {
    const qc = client.current;
    const viCatalog = catalog('vi');
    const tSavedViews = createTranslator({ locale: 'vi', messages: viCatalog, namespace: 'savedViews' });
    const singletonView = {
      id: '00000000-0000-7000-8000-0000000000b1',
      scope: 'kernel.task',
      name: 'Việc đã xong',
      filters: { v: 1 as const, all: [{ field: 'status', op: 'in', value: ['done'] }] },
      sort: null,
      shared: false,
      ownerId: ME,
      mine: true,
      canChange: true,
      updatedAt: at,
    };
    const multiView = {
      id: '00000000-0000-7000-8000-0000000000b2',
      scope: 'kernel.task',
      name: 'Việc đang xử lý',
      filters: { v: 1 as const, all: [{ field: 'status', op: 'in', value: ['todo', 'waiting'] }] },
      sort: null,
      shared: false,
      ownerId: ME,
      mine: true,
      canChange: true,
      updatedAt: at,
    };
    qc.setQueryData(['org', 'get', null], { role: 'owner' });
    qc.setQueryData(['savedViews', 'list', { scope: 'kernel.task' }], [singletonView, multiView]);

    let bar = EMPTY_TASK_FILTER;
    let sort: SavedViewSort | null = null;
    let capturedTree: ReactNode = null;
    const onApply = (next: ViewState) => {
      bar = astToTaskFilter(next.filters);
      sort = next.sort;
    };

    function Probe({ filters, currentSort }: { filters: FilterAst; currentSort: SavedViewSort | null }) {
      hookDriver.active = true;
      hookDriver.stateIdx = 0;
      hookDriver.refIdx = 0;
      try {
        capturedTree = ViewTabs({ scope: 'kernel.task', filters, sort: currentSort, onApply });
        return capturedTree;
      } finally {
        hookDriver.active = false;
      }
    }

    const renderProbe = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={viCatalog}>
            <Probe filters={taskFilterToAst(bar)} currentSort={sort} />
          </IntlProvider>
        </QueryClientProvider>,
      );

    // Initial render before picking a view, then select the singleton status:in view.
    renderProbe();
    const tabs = findElements(capturedTree, (el) => typeof el.props.onValueChange === 'function')[0]!;
    (tabs.props.onValueChange as (value: string) => void)(singletonView.id);

    // Serialized UI filters emit `status:is`, yet untouched view must not show Update or Save.
    expect(taskFilterToAst(bar)).toEqual({ v: 1, all: [{ field: 'status', op: 'is', value: 'done' }] });
    const untouchedHtml = renderProbe();
    const singletonUpdateLabel = tSavedViews('update', { name: singletonView.name });
    expect(untouchedHtml).toContain(`>${viMessages.savedViews.rename}<`);
    expect(untouchedHtml).toContain(`>${viMessages.savedViews.delete}<`);
    expect(untouchedHtml).not.toContain(singletonUpdateLabel);
    expect(untouchedHtml).not.toContain(`>${viMessages.savedViews.save}<`);

    // Genuine status change marks dirty and surfaces Update + Save.
    bar = selectTaskStatus(bar, 'todo');
    const changedStatusHtml = renderProbe();
    expect(changedStatusHtml).toContain(singletonUpdateLabel);
    expect(changedStatusHtml).toContain(`>${viMessages.savedViews.save}<`);

    // Reverting status back to 'done' clears dirty.
    bar = selectTaskStatus(bar, 'done');
    expect(renderProbe()).not.toContain(singletonUpdateLabel);

    // Clearing status or adding another filter / sort marks dirty.
    bar = selectTaskStatus(bar, '');
    expect(renderProbe()).toContain(singletonUpdateLabel);
    bar = selectTaskStatus(bar, 'done');
    bar = selectTaskDue(bar, 'overdue');
    expect(renderProbe()).toContain(singletonUpdateLabel);
    bar = selectTaskDue(bar, '');
    sort = { field: 'due', dir: 'asc' };
    expect(renderProbe()).toContain(singletonUpdateLabel);

    // Multi-value status:in view also starts non-dirty and becomes dirty on edit.
    const tabsForMulti = findElements(capturedTree, (el) => typeof el.props.onValueChange === 'function')[0]!;
    (tabsForMulti.props.onValueChange as (value: string) => void)(multiView.id);
    const multiUpdateLabel = tSavedViews('update', { name: multiView.name });
    const untouchedMultiHtml = renderProbe();
    expect(untouchedMultiHtml).toContain(`>${viMessages.savedViews.rename}<`);
    expect(untouchedMultiHtml).not.toContain(multiUpdateLabel);

    bar = selectTaskStatus(bar, 'done');
    expect(renderProbe()).toContain(multiUpdateLabel);
  });
});
