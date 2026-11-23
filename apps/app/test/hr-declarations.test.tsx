// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrDeclarationDocument } from '@ludy/kernel-contract';
import { setActiveLocale } from '../src/i18n/runtime.ts';

interface DrivenMutationSlot {
  isPending: boolean;
  error: unknown;
  variables: unknown;
  inFlight: Promise<void> | null;
}

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const routerState = vi.hoisted(() => ({ slug: 'org-a' }));
const apiSpies = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  laborCheck: vi.fn(),
  getCurrentOrg: vi.fn(() => routerState.slug),
}));
const hookDriver = vi.hoisted(() => ({
  inTargetComponent: false,
  states: [] as unknown[],
  stateCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  mutations: [] as DrivenMutationSlot[],
  mutationCursor: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup?: () => void }>,
  effectCursor: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initialState?: S | (() => S)) => {
      if (!hookDriver.inTargetComponent) return actual.useState(initialState as S);
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
    useRef: (<T,>(initialValue: T) => {
      if (!hookDriver.inTargetComponent) return actual.useRef(initialValue);
      const idx = hookDriver.refCursor++;
      if (idx >= hookDriver.refs.length) {
        hookDriver.refs.push({ current: initialValue });
      }
      return hookDriver.refs[idx] as { current: T };
    }) as typeof actual.useRef,
    useEffect: ((effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hookDriver.inTargetComponent) return actual.useEffect(effect, deps);
      const idx = hookDriver.effectCursor++;
      const prev = hookDriver.effects[idx];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        prev?.cleanup?.();
        const cleanup = effect();
        hookDriver.effects[idx] = { deps, ...(typeof cleanup === 'function' ? { cleanup } : {}) };
      }
    }) as typeof actual.useEffect,
  };
});

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: routerState.slug }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useMutation: ((options: {
      mutationFn?: (variables: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown, variables: unknown) => Promise<unknown> | unknown;
    }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useMutation(options as Parameters<typeof actual.useMutation>[0]);
      }
      const idx = hookDriver.mutationCursor++;
      if (idx >= hookDriver.mutations.length) {
        hookDriver.mutations.push({ isPending: false, error: null, variables: undefined, inFlight: null });
      }
      const slot = hookDriver.mutations[idx] as DrivenMutationSlot;
      return {
        isPending: slot.isPending,
        error: slot.error,
        variables: slot.variables,
        reset: () => {
          slot.isPending = false;
          slot.error = null;
          slot.variables = undefined;
        },
        mutate: (variables?: unknown) => {
          slot.isPending = true;
          slot.error = null;
          slot.variables = variables;
          slot.inFlight = (async () => {
            try {
              const data = await options.mutationFn?.(variables);
              await options.onSuccess?.(data, variables);
              slot.isPending = false;
            } catch (err) {
              slot.error = err;
              slot.isPending = false;
            }
          })();
        },
      };
    }) as typeof actual.useMutation,
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  return {
    apiFetch: apiSpies.apiFetch,
    client: { hr: { payroll: { laborCheck: apiSpies.laborCheck } } },
    clientForOrg: () => ({ hr: { payroll: { laborCheck: apiSpies.laborCheck } } }),
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    getCurrentOrg: apiSpies.getCurrentOrg,
    isStepUpRequired: (e: unknown) => Boolean(e && typeof e === 'object' && (e as { code?: string }).code === 'STEP_UP_REQUIRED'),
  };
});

const { HrDeclarationsContent, HrDeclarationsPage, isCurrentDeclarationRequest } = await import('../src/routes/hr-declarations.tsx');
const { DataTable } = await import('../src/components/ui.tsx');
const { TableCell, TableRow } = await import('@ludy/ui/components/table');
const { I18nProvider } = await import('../src/i18n/provider.tsx');

function resetHooks() {
  for (const entry of hookDriver.effects) entry.cleanup?.();
  hookDriver.inTargetComponent = false;
  hookDriver.states = [];
  hookDriver.stateCursor = 0;
  hookDriver.refs = [];
  hookDriver.refCursor = 0;
  hookDriver.mutations = [];
  hookDriver.mutationCursor = 0;
  hookDriver.effects = [];
  hookDriver.effectCursor = 0;
}

function wrap(ui: ReactNode, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
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

const sampleDoc = (title: string): HrDeclarationDocument => ({
  kind: 'kk',
  notice: 'Bảng kê để khai báo',
  notSent: 'Ludy không nộp và không ký tờ khai: bạn tự khai và ký trên kênh chính thức của cơ quan bảo hiểm xã hội hoặc cơ quan thuế.',
  layout: { form: '05/KK-TNCN và bảng kê (Thông tư 89/2026/TT-BTC)', version: 'ludy-hr-05kk/1' },
  draft: null,
  title,
  header: [{ label: 'Đơn vị', value: title }],
  sheets: [],
  notes: ['Ghi chú'],
  used: { months: ['2026-01'] },
});

describe('HR declarations org isolation, stale-request guards, and print styling (#2748)', () => {
  beforeEach(() => {
    resetHooks();
    cache.current.clear();
    apiSpies.apiFetch.mockReset();
    apiSpies.laborCheck.mockReset();
    routerState.slug = 'org-a';
  });

  it('(item 1) isCurrentDeclarationRequest rejects stale orgSlug, kind, period, or requestId tokens', () => {
    const current = { orgSlug: 'org-a', kind: 'kk' as const, period: '2026-Q1' };
    expect(isCurrentDeclarationRequest({ ...current, requestId: 2 }, current, 2)).toBe(true);
    expect(isCurrentDeclarationRequest({ ...current, requestId: 1 }, current, 2)).toBe(false);
    expect(isCurrentDeclarationRequest({ ...current, orgSlug: 'org-b', requestId: 2 }, current, 2)).toBe(false);
    expect(isCurrentDeclarationRequest({ ...current, kind: 'd02lt', requestId: 2 }, current, 2)).toBe(false);
    expect(isCurrentDeclarationRequest({ ...current, period: '2026-Q2', requestId: 2 }, current, 2)).toBe(false);
    expect(isCurrentDeclarationRequest(undefined, current, 2)).toBe(false);
  });

  it('(item 1) HrDeclarationsPage keys content by orgSlug so navigating org-a -> org-b cleanly remounts', () => {
    routerState.slug = 'org-a';
    const treeA = HrDeclarationsPage() as ReactElement<{ orgSlug: string }>;
    expect(treeA.key).toBe('org-a');
    expect(treeA.props.orgSlug).toBe('org-a');

    routerState.slug = 'org-b';
    const treeB = HrDeclarationsPage() as ReactElement<{ orgSlug: string }>;
    expect(treeB.key).toBe('org-b');
    expect(treeB.props.orgSlug).toBe('org-b');
  });

  it('(item 1) clears loaded document when orgSlug changes and ignores stale in-flight read responses for a previous org/period', async () => {
    let resolveDeferred!: (res: Response) => void;
    const deferredResponse = new Promise<Response>((resolve) => {
      resolveDeferred = resolve;
    });
    apiSpies.apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleDoc('Tài liệu Org A')), { status: 200 }))
      .mockReturnValueOnce(deferredResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(sampleDoc('Tài liệu Org B mới')), { status: 200 }));

    let capturedTree: ReactNode = null;
    function Probe({ orgSlug }: { orgSlug: string }) {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.refCursor = 0;
      hookDriver.mutationCursor = 0;
      hookDriver.effectCursor = 0;
      try {
        capturedTree = HrDeclarationsContent({ orgSlug });
        return capturedTree;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }
    const renderProbe = (orgSlug: string) => wrap(<Probe orgSlug={orgSlug} />);

    let html = renderProbe('org-a');
    const viewBtn = findElements(capturedTree, (el) => el.props['data-testid'] === 'hr-decl-view')[0]!;
    (viewBtn.props.onClick as () => void)();
    await hookDriver.mutations[0]?.inFlight;

    html = renderProbe('org-a');
    expect(html).toContain('Tài liệu Org A');
    expect(apiSpies.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/payroll-export/kk.json?period='), { orgSlug: 'org-a' });

    // Switching org clears any previously loaded document.
    html = renderProbe('org-b');
    expect(html).not.toContain('Tài liệu Org A');

    // Trigger read 1 in org-b (kept in flight), change period before it resolves, trigger read 2, then resolve read 1 late.
    const viewBtnB1 = findElements(capturedTree, (el) => el.props['data-testid'] === 'hr-decl-view')[0]!;
    (viewBtnB1.props.onClick as () => void)();
    const inFlightRead1 = hookDriver.mutations[0]?.inFlight;

    const quarterSelect = findElements(capturedTree, (el) => el.props.id === 'hr-decl-quarter')[0]!;
    (quarterSelect.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '2' } });
    renderProbe('org-b');

    const viewBtnB2 = findElements(capturedTree, (el) => el.props['data-testid'] === 'hr-decl-view')[0]!;
    expect(viewBtnB2.props.loading).toBe(false);
    (viewBtnB2.props.onClick as () => void)();
    await hookDriver.mutations[0]?.inFlight;

    // Now resolve the stale read 1: its stale request token and period must prevent it from overwriting read 2's Q2 doc.
    resolveDeferred(new Response(JSON.stringify(sampleDoc('Phản hồi cũ Q1')), { status: 200 }));
    await inFlightRead1;

    html = renderProbe('org-b');
    expect(html).toContain('Tài liệu Org B mới');
    expect(html).not.toContain('Phản hồi cũ Q1');

    // Moving back to org-c wipes org-b's document as well.
    html = renderProbe('org-c');
    expect(html).not.toContain('Tài liệu Org B mới');
  });

  it('(item 9) renders declaration-sheet print wrapper, print:hidden controls, DataTable print overflow overrides, and landscape print CSS', () => {
    const html = wrap(
      <>
        <HrDeclarationsPage />
        <DataTable head={['Cột 1', 'Cột 2']}>
          <TableRow>
            <TableCell>A</TableCell>
            <TableCell>B</TableCell>
          </TableRow>
        </DataTable>
      </>,
    );
    expect(html).toContain('print:hidden');
    expect(html).toContain('print:overflow-visible');
    expect(html).toContain('print:max-h-none');
    expect(html).toContain('print:min-w-0');

    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    expect(css).toContain('@page declaration');
    expect(css).toContain('size: landscape');
    expect(css).toContain('.declaration-sheet');
    expect(css).toContain('max-height: none;');
    expect(css).toContain('overflow: visible;');
    expect(css).toContain('break-inside: avoid;');
    const declarationsSrc = readFileSync(resolve(here, '../src/routes/hr-declarations.tsx'), 'utf8');
    expect(declarationsSrc).toContain('className="declaration-sheet"');
  });
});
