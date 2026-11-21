// SPDX-License-Identifier: AGPL-3.0-only
// SSR and pure helper tests for NoteTaskProposals (#2598) in English and Vietnamese.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE, type Note, type ProjectTasksFromNoteStatus } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return { orpc: api, client: api, clientForOrg: () => api, queryClient: client.current, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => `date:${v.slice(0, 10)}`,
    number: (v: number | bigint | string) => String(v),
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? ''), ...rest }, children),
  };
});

const { NoteTaskProposals, isModuleOffError, noteProposalBlocked, noteProposalErrorKey, resolveBatchIdempotencyKey, toEditableRows } = await import(
  '../src/components/note-task-proposals.tsx'
);

const SAMPLE_NOTE: Pick<Note, 'id' | 'title' | 'body' | 'mine' | 'deletedAt'> = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Gặp khách hàng A',
  body: 'Ngày mai gửi báo giá và xác nhận lịch giao hàng.',
  mine: true,
  deletedAt: null,
};

function renderBox(
  locale: 'en' | 'vi',
  opts: {
    status?: ProjectTasksFromNoteStatus;
    statusError?: unknown;
    meter?: { aiOn: boolean; state: string };
    projects?: Array<{ id: string; name: string; status: string }>;
    projectsError?: unknown;
    saveBlocked?: boolean;
  } = {},
) {
  client.current.clear();
  if (opts.status) client.current.setQueryData(['projects', 'tasksFromNoteStatus'], opts.status);
  if (opts.meter) client.current.setQueryData(['ai', 'meter'], { ...opts.meter, scope: null, percent: 0, resetAt: '2026-12-01T00:00:00.000Z' });
  if (opts.projects !== undefined) client.current.setQueryData(['projects', 'list'], { projects: opts.projects });

  const cache = client.current.getQueryCache();
  if (opts.statusError !== undefined) {
    const q = cache.build(client.current, { queryKey: ['projects', 'tasksFromNoteStatus'] });
    q.setState({ status: 'error', error: opts.statusError as Error, fetchStatus: 'idle' });
  }
  if (opts.projectsError !== undefined) {
    const q = cache.build(client.current, { queryKey: ['projects', 'list'] });
    q.setState({ status: 'error', error: opts.projectsError as Error, fetchStatus: 'idle' });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        <NoteTaskProposals slug="acme" note={SAMPLE_NOTE} saveBlocked={opts.saveBlocked} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('noteProposalBlocked & helpers', () => {
  it('detects blocked reasons cleanly across server status and org meter', () => {
    expect(noteProposalBlocked(undefined, undefined)).toBe('off');
    expect(noteProposalBlocked(undefined, { aiOn: false })).toBe('noModel');
    expect(noteProposalBlocked({ available: false, reason: 'forbidden', resetOn: null }, { aiOn: true })).toBe('forbidden');
    expect(noteProposalBlocked({ available: false, reason: 'paused', resetOn: null }, { aiOn: true })).toBe('paused');
    expect(noteProposalBlocked({ available: false, reason: 'budget', resetOn: '2026-12-01' }, { aiOn: true })).toBe('budget');
    expect(noteProposalBlocked({ available: true, reason: null, resetOn: null }, { aiOn: false })).toBe('noModel');
    expect(noteProposalBlocked({ available: true, reason: null, resetOn: null }, { aiOn: true })).toBeNull();
  });

  it('maps known failure codes and MODULE_OFF errors cleanly', () => {
    expect(noteProposalErrorKey('PROPOSAL_TIMEOUT')).toBe('PROPOSAL_TIMEOUT');
    expect(noteProposalErrorKey('AI_STOPPED')).toBe('AI_STOPPED');
    expect(noteProposalErrorKey('UNSAVED_NOTE')).toBe('UNSAVED_NOTE');
    expect(noteProposalErrorKey('SOMETHING_UNEXPECTED')).toBe('default');
    expect(noteProposalErrorKey(null)).toBe('default');
    expect(isModuleOffError({ code: 'MODULE_OFF' })).toBe(true);
    expect(isModuleOffError({ code: 'NOT_FOUND' })).toBe(false);
  });

  it('builds checked editable rows preserving title, assigneePositionId and dueOn', () => {
    const rows = toEditableRows([
      { title: 'Send quote', assigneePositionId: 'seat-1', dueOn: '2026-11-20' },
      { title: 'Call client', assigneePositionId: null, dueOn: null },
    ]);
    expect(rows).toEqual([
      { key: 'row-0', selected: true, title: 'Send quote', assigneePositionId: 'seat-1', dueOn: '2026-11-20' },
      { key: 'row-1', selected: true, title: 'Call client', assigneePositionId: null, dueOn: null },
    ]);
  });

  it('reuses confirm idempotencyKey across retries of the same payload and rotates on edits or project changes', () => {
    let seq = 0;
    const nextKey = () => `key-${++seq}`;
    const items = [{ title: 'Send quote', assigneePositionId: 'seat-1', dueOn: '2026-11-20' }];
    const first = resolveBatchIdempotencyKey(null, SAMPLE_NOTE.id, 'proj-1', items, nextKey);
    const retry = resolveBatchIdempotencyKey(first, SAMPLE_NOTE.id, 'proj-1', items, nextKey);
    expect(retry.key).toBe(first.key);

    const edited = resolveBatchIdempotencyKey(retry, SAMPLE_NOTE.id, 'proj-1', [{ ...items[0]!, title: 'Send revised quote' }], nextKey);
    expect(edited.key).not.toBe(first.key);

    const otherProject = resolveBatchIdempotencyKey(edited, SAMPLE_NOTE.id, 'proj-2', [{ ...items[0]!, title: 'Send revised quote' }], nextKey);
    expect(otherProject.key).not.toBe(edited.key);
  });
});

describe('NoteTaskProposals UI', () => {
  it('renders Marked as AI badge, project picker and enabled CTA in EN & VI when Vy is available', () => {
    const htmlVi = renderBox('vi', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      projects: [{ id: 'p1', name: 'Dự án Q4', status: 'active' }],
    });
    expect(htmlVi).toContain('Vy đề xuất · AI');
    expect(htmlVi).toContain('Dự án Q4');
    expect(htmlVi).toContain('Nhờ Vy đề xuất việc');
    expect(htmlVi).not.toContain('trợ lý');

    const htmlEn = renderBox('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      projects: [{ id: 'p1', name: 'Q4 Launch', status: 'active' }],
    });
    expect(htmlEn).toContain('Proposed by Vy · AI');
    expect(htmlEn).toContain('Q4 Launch');
    expect(htmlEn).toContain('Ask Vy to propose tasks');
    expect(htmlEn.toLowerCase()).not.toContain('assistant');
  });

  it('renders paused and budget-exhausted notices with reset date and disables Ask Vy without breaking notes', () => {
    const pausedHtml = renderBox('vi', {
      status: { available: false, reason: 'paused', resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      projects: [{ id: 'p1', name: 'Dự án Q4', status: 'active' }],
    });
    expect(pausedHtml).toContain('AI đang tạm dừng');
    expect(pausedHtml).toMatch(/disabled=""[^>]*data-testid="note-task-proposals-ask"/);

    const budgetHtml = renderBox('en', {
      status: { available: false, reason: 'budget', resetOn: '2026-12-01' },
      meter: { aiOn: true, state: 'stop' },
      projects: [{ id: 'p1', name: 'Q4 Launch', status: 'active' }],
    });
    expect(budgetHtml).toContain('date:2026-12-01');

    const conflictHtml = renderBox('en', {
      status: { available: true, reason: null, resetOn: null },
      meter: { aiOn: true, state: 'ok' },
      projects: [{ id: 'p1', name: 'Q4 Launch', status: 'active' }],
      saveBlocked: true,
    });
    expect(conflictHtml).toMatch(/disabled=""[^>]*data-testid="note-task-proposals-ask"/);
  });

  it('handles pending loading without flashing off notice, hides on ADR-0053 MODULE_OFF, and surfaces query errors', () => {
    const pendingHtml = renderBox('en');
    expect(pendingHtml).toContain('aria-busy="true"');
    expect(pendingHtml).not.toContain('not turned on');

    const moduleOffHtml = renderBox('en', {
      statusError: Object.assign(new Error('Off'), { code: 'MODULE_OFF' }),
      projects: [],
    });
    expect(moduleOffHtml).toBe('');

    const errorHtml = renderBox('en', {
      status: { available: true, reason: null, resetOn: null },
      projectsError: new Error('Network unavailable'),
    });
    expect(errorHtml).toContain('Network unavailable');
    expect(errorHtml).not.toContain('No open project');
  });
});
