// SPDX-License-Identifier: AGPL-3.0-only
// The tabs of saved views (CRM K3 and K4, #2227, #2228), rendered on the server with the list answered from a seeded cache:
// "Tất cả" first, the member's own views, then the org's shared ones with their badge; what the tabs offer depends on
// whether the screen's filter moved away from the picked view and on who may change it.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterAst } from '@ludy/kernel-contract';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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

describe('ViewTabs', () => {
  beforeEach(() => client.current.clear());

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
});
