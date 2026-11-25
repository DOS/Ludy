// SPDX-License-Identifier: AGPL-3.0-only
// UI & i18n tests for continuous pre-lock payroll fluctuation preview and What-Changed diff (#4445, Stage 5E).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HR_ERASED_NAME,
  HR_PAYROLL_DIFF_REASONS,
  type HrPayrollPreviewDiff,
} from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, explainCalls: 0 }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    apiFetch: vi.fn(),
    client: {
      hr: {
        payroll: {
          coworker: {
            explainDiff: vi.fn(() => {
              cache.explainCalls += 1;
              return Promise.resolve({ ai: 'off', text: null, deterministicText: '' });
            }),
          },
        },
      },
    },
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    orpc: node([]),
    queryClient: cache.current,
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; [key: string]: unknown }) =>
      createElement('a', { ...rest, href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

const { HrPayrollPage, PayrollDiffPanel, PayrollDiffNarration, formatSignedMoney, localDiffSummary } = await import('../src/routes/hr-payroll.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const ENTITY_ID = '00000000-0000-7000-8000-000000000701';
const RUN_ID = '00000000-0000-7000-8000-000000000702';
const PRIOR_RUN_ID = '00000000-0000-7000-8000-000000000703';

function sampleDiff(over: Partial<HrPayrollPreviewDiff> = {}): HrPayrollPreviewDiff {
  return {
    mode: 'draft_run',
    legalEntityId: ENTITY_ID,
    legalEntityName: 'Công ty Mẫu Việt Nam',
    month: '2026-11',
    current: {
      runId: RUN_ID,
      month: '2026-11',
      status: 'draft',
      approvedAt: null,
      headcount: 3,
      refusedCount: 0,
      flaggedCount: 1,
    },
    prior: {
      runId: PRIOR_RUN_ID,
      month: '2026-10',
      status: 'approved',
      approvedAt: '2026-10-31T10:00:00.000Z',
      headcount: 3,
      refusedCount: 0,
      flaggedCount: 0,
    },
    totals: {
      headcount: 3,
      gross: '65000000',
      employeeInsurance: '6300000',
      pit: '1200000',
      otherDeductions: '1000000',
      employeeDeductions: '8500000',
      net: '56500000',
      employerInsurance: '12900000',
      unionFee: '1200000',
      employerStatutory: '14100000',
      employerCost: '79100000',
      taxableIncome: '64270000',
    },
    priorTotals: {
      headcount: 3,
      gross: '60000000',
      employeeInsurance: '6300000',
      pit: '1000000',
      otherDeductions: '0',
      employeeDeductions: '7300000',
      net: '52700000',
      employerInsurance: '12900000',
      unionFee: '1200000',
      employerStatutory: '14100000',
      employerCost: '74100000',
      taxableIncome: '60000000',
    },
    deltas: {
      headcountDelta: 0,
      grossDelta: '5000000',
      employeeInsuranceDelta: '0',
      pitDelta: '200000',
      otherDeductionDelta: '1000000',
      employeeDeductionDelta: '1200000',
      netDelta: '3800000',
      employerInsuranceDelta: '0',
      unionFeeDelta: '0',
      employerStatutoryDelta: '0',
      employerCostDelta: '5000000',
      taxableIncomeDelta: '4270000',
    },
    unchangedCount: 1,
    rows: [
      {
        employeeId: '00000000-0000-7000-8000-000000000801',
        employeeName: 'Nguyễn Văn An',
        erased: false,
        changed: true,
        reasons: ['new_hire', 'salary_change', 'allowance_change', 'deduction_change', 'retro_pay', 'offset_deduction'],
        prior: null,
        current: {
          gross: '25000000',
          employeeInsurance: '2625000',
          pit: '750000',
          otherDeductions: '1000000',
          employeeDeductions: '4375000',
          net: '20625000',
          employerInsurance: '5375000',
          unionFee: '500000',
          employerStatutory: '5875000',
          employerCost: '30875000',
          taxableIncome: '24270000',
        },
        grossDelta: '25000000',
        employeeInsuranceDelta: '2625000',
        pitDelta: '750000',
        otherDeductionDelta: '1000000',
        employeeDeductionDelta: '4375000',
        netDelta: '20625000',
        employerInsuranceDelta: '5375000',
        unionFeeDelta: '500000',
        employerStatutoryDelta: '5875000',
        employerCostDelta: '30875000',
        priorLeaveDays: null,
        currentLeaveDays: '0',
        hasRefused: false,
        hasFlags: true,
      },
      {
        employeeId: '00000000-0000-7000-8000-000000000802',
        employeeName: HR_ERASED_NAME,
        erased: true,
        changed: true,
        reasons: ['terminated', 'leave_change'],
        prior: {
          gross: '20000000',
          employeeInsurance: '2100000',
          pit: '300000',
          otherDeductions: '0',
          employeeDeductions: '2400000',
          net: '17600000',
          employerInsurance: '4300000',
          unionFee: '400000',
          employerStatutory: '4700000',
          employerCost: '24700000',
          taxableIncome: '20000000',
        },
        current: null,
        grossDelta: '-20000000',
        employeeInsuranceDelta: '-2100000',
        pitDelta: '-300000',
        otherDeductionDelta: '0',
        employeeDeductionDelta: '-2400000',
        netDelta: '-17600000',
        employerInsuranceDelta: '-4300000',
        unionFeeDelta: '-400000',
        employerStatutoryDelta: '-4700000',
        employerCostDelta: '-24700000',
        priorLeaveDays: '0',
        currentLeaveDays: '2',
        hasRefused: false,
        hasFlags: false,
      },
      {
        employeeId: '00000000-0000-7000-8000-000000000803',
        employeeName: 'Phạm Ổn Định',
        erased: false,
        changed: false,
        reasons: [],
        prior: {
          gross: '20000000',
          employeeInsurance: '2100000',
          pit: '250000',
          otherDeductions: '0',
          employeeDeductions: '2350000',
          net: '17650000',
          employerInsurance: '4300000',
          unionFee: '400000',
          employerStatutory: '4700000',
          employerCost: '24700000',
          taxableIncome: '20000000',
        },
        current: {
          gross: '20000000',
          employeeInsurance: '2100000',
          pit: '250000',
          otherDeductions: '0',
          employeeDeductions: '2350000',
          net: '17650000',
          employerInsurance: '4300000',
          unionFee: '400000',
          employerStatutory: '4700000',
          employerCost: '24700000',
          taxableIncome: '20000000',
        },
        grossDelta: '0',
        employeeInsuranceDelta: '0',
        pitDelta: '0',
        otherDeductionDelta: '0',
        employeeDeductionDelta: '0',
        netDelta: '0',
        employerInsuranceDelta: '0',
        unionFeeDelta: '0',
        employerStatutoryDelta: '0',
        employerCostDelta: '0',
        priorLeaveDays: '0',
        currentLeaveDays: '0',
        hasRefused: false,
        hasFlags: false,
      },
    ],
    ...over,
  };
}

function renderPanel(
  diff: HrPayrollPreviewDiff,
  locale: 'vi' | 'en',
  mode: 'run' | 'projected' = 'run',
  headingLevel: 'h2' | 'h3' = 'h2',
): string {
  setActiveLocale(locale);
  const input = mode === 'run' ? { runId: RUN_ID, includeUnchanged: true } : { month: diff.month, includeUnchanged: true };
  cache.current.setQueryData(['hr', 'payroll', 'previewDiff', input], diff);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        {mode === 'run' ? (
          <PayrollDiffPanel runId={RUN_ID} headingLevel={headingLevel} />
        ) : (
          <PayrollDiffPanel month={diff.month} headingLevel={headingLevel} />
        )}
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('PayrollDiffPanel UI & i18n (#4445)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.explainCalls = 0;
  });

  it('ships complete VI/EN diff translations with all 8 reasons and zero em/en dashes', () => {
    for (const reason of HR_PAYROLL_DIFF_REASONS) {
      expect(viMessages.hrPayroll.diff.reasons[reason]).toBeTruthy();
      expect(en.hrPayroll.diff.reasons[reason]).toBeTruthy();
    }
    const serialized = `${JSON.stringify(viMessages.hrPayroll.diff)} ${JSON.stringify(en.hrPayroll.diff)}`;
    expect(serialized).not.toMatch(/[\u2014\u2013]/);
  });

  it('renders accessible <thead>, <th scope="col">, all 8 reason badges, masked erased name, signed VND deltas, and zero auto AI call', () => {
    const diff = sampleDiff();
    const htmlVi = renderPanel(diff, 'vi', 'run');

    expect(cache.explainCalls).toBe(0);
    expect(htmlVi).toContain('data-testid="hr-diff-panel"');
    expect(htmlVi).toContain('<h2 class="text-base font-semibold">');
    expect(htmlVi).not.toContain('<h3');
    const htmlSheetLevel = renderPanel(diff, 'vi', 'run', 'h3');
    expect(htmlSheetLevel).toContain('<h3 class="text-base font-semibold">');
    expect(htmlVi).toContain('<thead');
    const colHeaders = htmlVi.match(/<th\b[^>]*scope="col"/g) ?? [];
    expect(colHeaders.length).toBe(8);
    expect(htmlVi).toContain('<tfoot');
    expect(htmlVi).toContain(viMessages.hrPayroll.diff.title);
    expect(htmlVi).toContain('2026-10');
    expect(htmlVi).toContain('Nguyễn Văn An');
    expect(htmlVi).toContain(HR_ERASED_NAME);
    expect(htmlVi).not.toContain('Phạm Ổn Định'); // unchanged hidden by default
    expect(htmlVi).toContain('data-testid="hr-diff-toggle-unchanged"');
    for (const reason of HR_PAYROLL_DIFF_REASONS) {
      expect(htmlVi).toContain(viMessages.hrPayroll.diff.reasons[reason]);
    }
    expect(htmlVi).toContain('+5.000.000');
    expect(htmlVi).toContain('-17.600.000');
    expect(htmlVi).not.toContain('bg-red-');
    expect(htmlVi).not.toContain('text-emerald-');

    cache.current.clear();
    const projectedDiff = sampleDiff({ mode: 'projected' });
    const htmlEn = renderPanel(projectedDiff, 'en', 'projected');
    expect(htmlEn).toContain(en.hrPayroll.diff.title);
    expect(htmlEn).toContain('Projected from employments and leave (2026-11)');
    expect(htmlEn).toContain('+₫5,000,000');
    expect(htmlEn).toContain('-₫17,600,000');
    for (const reason of HR_PAYROLL_DIFF_REASONS) {
      expect(htmlEn).toContain(en.hrPayroll.diff.reasons[reason]);
    }
  });

  it('handles first-month no-prior baseline, quiet empty diff, and verified vs fallback AI narration cleanly', () => {
    const baseline = sampleDiff({
      mode: 'projected',
      prior: null,
      priorTotals: null,
      unchangedCount: 0,
      rows: [],
      deltas: {
        headcountDelta: 0,
        grossDelta: '0',
        employeeInsuranceDelta: '0',
        pitDelta: '0',
        otherDeductionDelta: '0',
        employeeDeductionDelta: '0',
        netDelta: '0',
        employerInsuranceDelta: '0',
        unionFeeDelta: '0',
        employerStatutoryDelta: '0',
        employerCostDelta: '0',
        taxableIncomeDelta: '0',
      },
    });
    const htmlEmpty = renderPanel(baseline, 'en', 'projected');
    expect(htmlEmpty).toContain(en.hrPayroll.diff.noPrior);
    expect(htmlEmpty).toContain(en.hrPayroll.diff.emptyChanged);
    expect(htmlEmpty).not.toContain('+₫0');
    expect(htmlEmpty).not.toContain('+0');

    expect(formatSignedMoney({ money: (v) => `${v ?? '0'} ₫` }, '0')).toBe('0 ₫');
    expect(formatSignedMoney({ money: (v) => `${v ?? '0'} ₫` }, '0.00')).toBe('0 ₫');
    expect(formatSignedMoney({ money: (v) => `${v ?? '0'} ₫` }, '-0.00')).toBe('0 ₫');
    expect(formatSignedMoney({ money: (v) => `${v ?? '0'} ₫` }, '500000')).toBe('+500000 ₫');

    // Landing page must gate PayrollDiffPanel on runs.list success to prevent duplicate sensitive reads
    cache.current.clear();
    setActiveLocale('vi');
    const pendingPageHtml = renderToStaticMarkup(
      <QueryClientProvider client={cache.current}>
        <I18nProvider>
          <HrPayrollPage />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(pendingPageHtml).not.toContain('data-testid="hr-diff-panel"');

    cache.current.setQueryData(['hr', 'payroll', 'runs', 'list', { limit: 24 }], []);
    const loadedPageHtml = renderToStaticMarkup(
      <QueryClientProvider client={cache.current}>
        <I18nProvider>
          <HrPayrollPage />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(loadedPageHtml).toContain('data-testid="hr-diff-panel"');

    setActiveLocale('vi');
    const summaryVi = localDiffSummary(sampleDiff(), { money: (v) => `${v ?? '0'} ₫` }, 'vi');
    expect(summaryVi).toContain('Tổng chi phí công ty +5000000 ₫');
    expect(summaryVi).toContain('Nguyễn Văn An');

    const usedHtml = renderToStaticMarkup(
      <I18nProvider>
        <PayrollDiffNarration
          answer={{
            ai: 'used',
            text: 'Tổng chi phí công ty tăng 5.000.000 đồng, chủ yếu do tuyển mới Nguyễn Văn An.',
            deterministicText: summaryVi,
          }}
          fallback={summaryVi}
        />
      </I18nProvider>,
    );
    expect(usedHtml).toContain(viMessages.hrPayroll.diff.aiBadge);
    expect(usedHtml).toContain('tăng 5.000.000 đồng');

    const busyHtml = renderToStaticMarkup(
      <I18nProvider>
        <PayrollDiffNarration
          answer={{ ai: 'busy', text: null, deterministicText: '' }}
          fallback={summaryVi}
        />
      </I18nProvider>,
    );
    expect(busyHtml).toContain(viMessages.hrPayroll.diff.aiStates.busy);
    expect(busyHtml).toContain(summaryVi);
  });
});
