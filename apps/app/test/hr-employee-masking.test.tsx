// SPDX-License-Identifier: AGPL-3.0-only
// Pins N5 from the #2689 security review (#2691):
// - Detail masks identityNumber, accountNumber, taxCode, and insuranceNumber as '••••••••' by default.
// - Clicking data-testid="hr-employee-reveal" toggles between masked and revealed numbers.
// - The employee detail query specifies gcTime: 0 (plus ONCE flags) so opened numbers leave the query cache on unmount.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrEmployee } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const capturedQueries = vi.hoisted(() => [] as Array<{ queryKey?: unknown; gcTime?: unknown; staleTime?: unknown; refetchOnWindowFocus?: unknown; refetchOnReconnect?: unknown }>);
const hookDriver = vi.hoisted(() => ({
  inTargetComponent: false,
  states: [] as unknown[],
  stateCursor: 0,
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
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: ((options: Parameters<typeof actual.useQuery>[0]) => {
      if (hookDriver.inTargetComponent) {
        capturedQueries.push(options as { queryKey?: unknown; gcTime?: unknown; staleTime?: unknown; refetchOnWindowFocus?: unknown; refetchOnReconnect?: unknown });
      }
      return actual.useQuery(options);
    }) as typeof actual.useQuery,
  };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        employee: { contractPdf: vi.fn() },
        payroll: {
          employees: { edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
          employments: { add: vi.fn() },
          dependents: { add: vi.fn(), end: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const { Detail } = await import('../src/routes/hr-employees.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const EMP_ID = '00000000-0000-7000-8000-000000000401';
const ENTITY_ID = '00000000-0000-7000-8000-000000000402';

// Synthetic test values passing tools/ci/pii-scan.mjs.
const SENSITIVE = {
  identityNumber: '079000000001',
  accountNumber: '190300000001',
  taxCode: '0100000001',
  insuranceNumber: '7900000001',
} as const;

const EMPLOYEE: HrEmployee = {
  id: EMP_ID,
  legalEntityId: ENTITY_ID,
  displayName: 'Nguyễn Thị Bảo Mật Canary',
  departmentId: null,
  departmentName: null,
  jobTitle: null,
  linkedUserId: null,
  linkedMemberName: null,
  status: 'active',
  endedOn: null,
  current: null,
  hasIdentityNumber: true,
  hasAccountNumber: true,
  contractAlerts: [],
  address: '10 Đường Thử Nghiệm',
  identityNumber: SENSITIVE.identityNumber,
  accountNumber: SENSITIVE.accountNumber,
  bankCode: 'VCB',
  birthDate: '1992-04-15',
  taxCode: SENSITIVE.taxCode,
  insuranceNumber: SENSITIVE.insuranceNumber,
  finalizationAuthorizedYears: [],
  erased: false,
  employments: [],
  dependents: [],
};

function wrap(ui: ReactNode, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function collectByTestId(node: ReactNode, testId: string, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectByTestId(item, testId, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as Record<string, unknown>;
  if (props['data-testid'] === testId) {
    out.push(node as ReactElement<Record<string, unknown>>);
  }
  if (props.children !== undefined) {
    collectByTestId(props.children as ReactNode, testId, out);
  }
  return out;
}

function requireByTestId(node: ReactNode, testId: string): ReactElement<Record<string, unknown>> {
  const found = collectByTestId(node, testId)[0];
  if (!found) throw new Error(`missing testId ${testId}`);
  return found;
}

describe('HR employee detail number masking and zero-gcTime caching (#2691 N5)', () => {
  beforeEach(() => {
    cache.current.clear();
    capturedQueries.length = 0;
    hookDriver.inTargetComponent = false;
    hookDriver.states = [];
    hookDriver.stateCursor = 0;
  });

  it('masks identityNumber, accountNumber, taxCode, and insuranceNumber by default, reveals on toggle click, and configures gcTime: 0', () => {
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], EMPLOYEE);

    let capturedTree: ReactNode = null;
    function Probe() {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      try {
        const rendered = Detail({ employeeId: EMP_ID, owner: true, departments: [], onClose: () => {} });
        capturedTree = rendered;
        return rendered;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }

    // 1. Default render: all four numbers are masked and raw values are absent from HTML.
    const maskedVi = wrap(<Probe />, 'vi');
    expect(maskedVi).toContain('data-testid="hr-employee-identity">••••••••</dd>');
    expect(maskedVi).toContain('data-testid="hr-employee-account">••••••••</dd>');
    expect(maskedVi).toContain('data-testid="hr-employee-tax">••••••••</dd>');
    expect(maskedVi).toContain('data-testid="hr-employee-insurance">••••••••</dd>');
    expect(maskedVi).toContain('data-testid="hr-employee-reveal"');
    expect(maskedVi).toContain(`>${viMessages.hrEmployees.showNumbers}</button>`);
    for (const raw of Object.values(SENSITIVE)) {
      expect(maskedVi).not.toContain(raw);
    }

    // Verify the employee detail query configures gcTime: 0 and no automatic refetches.
    const detailQuery = capturedQueries.find(
      (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey[0] === 'hr' &&
        q.queryKey[1] === 'payroll' &&
        q.queryKey[2] === 'employees' &&
        q.queryKey[3] === 'get',
    );
    expect(detailQuery).toMatchObject({
      queryKey: ['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }],
      gcTime: 0,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });

    // 2. Click reveal toggle: all four numbers appear and button switches to hideNumbers.
    (requireByTestId(capturedTree, 'hr-employee-reveal').props.onClick as () => void)();

    const revealedEn = wrap(<Probe />, 'en');
    expect(revealedEn).toContain(`data-testid="hr-employee-identity">${SENSITIVE.identityNumber}</dd>`);
    expect(revealedEn).toContain(`data-testid="hr-employee-account">${SENSITIVE.accountNumber}</dd>`);
    expect(revealedEn).toContain(`data-testid="hr-employee-tax">${SENSITIVE.taxCode}</dd>`);
    expect(revealedEn).toContain(`data-testid="hr-employee-insurance">${SENSITIVE.insuranceNumber}</dd>`);
    expect(revealedEn).toContain('data-testid="hr-employee-reveal"');
    expect(revealedEn).toContain(`>${en.hrEmployees.hideNumbers}</button>`);

    // 3. Click reveal toggle again: all four numbers return to masked state.
    (requireByTestId(capturedTree, 'hr-employee-reveal').props.onClick as () => void)();

    const remaskedVi = wrap(<Probe />, 'vi');
    expect(remaskedVi).toContain('data-testid="hr-employee-identity">••••••••</dd>');
    expect(remaskedVi).toContain('data-testid="hr-employee-account">••••••••</dd>');
    expect(remaskedVi).toContain('data-testid="hr-employee-tax">••••••••</dd>');
    expect(remaskedVi).toContain('data-testid="hr-employee-insurance">••••••••</dd>');
    for (const raw of Object.values(SENSITIVE)) {
      expect(remaskedVi).not.toContain(raw);
    }
  });

  it('omits the reveal button when all sealed numbers are null', () => {
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], {
      ...EMPLOYEE,
      hasIdentityNumber: false,
      hasAccountNumber: false,
      identityNumber: null,
      accountNumber: null,
      taxCode: null,
      insuranceNumber: null,
    });

    const html = wrap(<Detail employeeId={EMP_ID} owner departments={[]} onClose={() => {}} />, 'vi');
    expect(html).not.toContain('data-testid="hr-employee-reveal"');
    expect(html).not.toContain('••••••••');
  });
});
