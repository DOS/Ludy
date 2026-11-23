// SPDX-License-Identifier: AGPL-3.0-only
// SSR UI, i18n, and helper tests for HrOkrPanel (#4529, Stage 6D).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrOkrObjectiveView, HrOkrTreeResult } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['hr', 'projects'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: [...path, opts?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        okr: {
          draftCheckin: vi.fn(),
          objective: { create: vi.fn(), update: vi.fn(), setStatus: vi.fn() },
          kr: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), checkin: vi.fn(), syncProjects: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  HrOkrPanel,
  buildQuarterOptions,
  currentDefaultQuarter,
  groupOkrTree,
  resolveDraftInsertText,
} = await import('../src/components/hr-okr-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

function makeObjective(over: Partial<HrOkrObjectiveView>): HrOkrObjectiveView {
  return {
    id: '00000000-0000-7000-8000-000000000901',
    legalEntityId: '00000000-0000-7000-8000-000000000902',
    quarter: '2026-Q4',
    scope: 'company',
    title: 'Mục tiêu mẫu',
    ownerEmployeeId: null,
    ownerEmployeeName: null,
    departmentId: null,
    departmentName: null,
    parentObjectiveId: null,
    status: 'active',
    progressPct: '50',
    keyResults: [],
    canManage: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function renderPanel(mode: 'manager' | 'self'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <HrOkrPanel mode={mode} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cache.current.clear();
  setActiveLocale('vi');
});

describe('HrOkrPanel SSR, i18n, and helpers (#4529 Stage 6D)', () => {
  it('computes Vietnam local quarter accurately around boundaries', () => {
    expect(currentDefaultQuarter(new Date('2026-03-31T16:59:00.000Z'))).toBe('2026-Q1');
    expect(currentDefaultQuarter(new Date('2026-03-31T17:05:00.000Z'))).toBe('2026-Q2');
    expect(buildQuarterOptions(['2025-Q1'], '2026-Q4')).toContain('2026-Q4');
  });

  it('orders Company -> Department -> Individual parent-first hierarchy cleanly', () => {
    const empObj = makeObjective({
      id: 'ind-1',
      scope: 'individual',
      parentObjectiveId: 'dept-1',
      title: 'Cá nhân 1',
    });
    const deptObj = makeObjective({
      id: 'dept-1',
      scope: 'department',
      parentObjectiveId: 'co-1',
      title: 'Phòng kinh doanh',
    });
    const compObj = makeObjective({
      id: 'co-1',
      scope: 'company',
      parentObjectiveId: null,
      title: 'Tăng doanh thu',
    });

    const tree = groupOkrTree([empObj, deptObj, compObj]);
    expect(tree.map((n) => [n.objective.id, n.depth, n.parentTitle])).toEqual([
      ['co-1', 0, null],
      ['dept-1', 1, 'Tăng doanh thu'],
      ['ind-1', 2, 'Phòng kinh doanh'],
    ]);
  });

  it('falls back to deterministicSummary cleanly when AI draft is null', () => {
    expect(resolveDraftInsertText('Nháp từ Ly', 'Tóm tắt số liệu')).toBe('Nháp từ Ly');
    expect(resolveDraftInsertText(null, 'Cập nhật 2026-Q4: đạt 3/4 (75%).')).toBe('Cập nhật 2026-Q4: đạt 3/4 (75%).');
  });

  it('keeps hrOkr vi and en translation keys aligned with no em/en dashes', () => {
    expect(Object.keys(viMessages.hrOkr).sort()).toEqual(Object.keys(en.hrOkr).sort());
    expect(viMessages.aiMeter.features.hr_okr_checkin_draft).toBeTruthy();
    expect(en.aiMeter.features.hr_okr_checkin_draft).toBeTruthy();
    expect(viMessages.audit.objects.hr.okr_objective).toBeTruthy();
    expect(en.audit.objects.hr.okr_key_result).toBeTruthy();
    const raw = JSON.stringify({ vi: viMessages.hrOkr, en: en.hrOkr });
    expect(raw).not.toMatch(/[\u2013\u2014]/);
  });

  it('renders manager OKR tree with linked Projects badge and self check-in with Projects-off fallback', () => {
    const q = currentDefaultQuarter();
    const sampleTree: HrOkrTreeResult = {
      quarter: q,
      availableQuarters: [q],
      projectsAvailable: true,
      canManageAny: true,
      selfEmployeeId: null,
      manageableDepartments: [{ id: 'dept-1', name: 'Kỹ thuật', legalEntityId: 'le-1' }],
      manageableEmployees: [{ id: 'emp-1', displayName: 'Nguyễn Văn A', departmentId: 'dept-1', jobTitle: 'Dev' }],
      objectives: [
        makeObjective({
          id: 'obj-co',
          quarter: q,
          scope: 'company',
          title: 'Tăng trưởng quý hiện tại',
          progressPct: '66.67',
          keyResults: [
            {
              id: 'kr-1',
              objectiveId: 'obj-co',
              title: 'Hoàn thành triển khai 3 tính năng',
              metricType: 'project_tasks',
              targetValue: '3',
              currentValue: '2',
              unit: 'việc',
              linkedProjectId: 'proj-1',
              linkedProjectName: 'Ludy Core',
              linkedProjectAccessible: true,
              linkedTaskIds: ['t-1', 't-2', 't-3'],
              linkedTasks: [],
              completedLinkedTasks: 2,
              totalLinkedTasks: 3,
              progressPct: '66.67',
              lastCheckinNote: 'Đang kiểm thử bản dựng cuối.',
              lastCheckinAt: '2026-10-12T00:00:00.000Z',
              lastCheckinBy: 'user-1',
              lastCheckinByName: 'Chủ doanh nghiệp',
              canCheckin: true,
              canEdit: true,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-12T00:00:00.000Z',
            },
          ],
        }),
      ],
    };

    cache.current.setQueryData(['hr', 'okr', 'tree', { quarter: q }], sampleTree);
    const mgrHtml = renderPanel('manager');
    expect(mgrHtml).toContain('data-testid="hr-okr-panel"');
    expect(mgrHtml).toContain('Ludy Công tác đang bật');
    expect(mgrHtml).toContain('Tăng trưởng quý hiện tại');
    expect(mgrHtml).toContain('Ludy Core: 2/3 việc xong');
    expect(mgrHtml).toContain('data-testid="hr-okr-checkin-open-kr-1"');

    // Now simulate Projects disabled on employee self view.
    cache.current.setQueryData(['hr', 'okr', 'tree', { quarter: q }], {
      ...sampleTree,
      projectsAvailable: false,
      canManageAny: false,
      objectives: [
        {
          ...sampleTree.objectives[0]!,
          canManage: false,
          keyResults: [
            {
              ...sampleTree.objectives[0]!.keyResults[0]!,
              linkedProjectAccessible: false,
              canEdit: false,
            },
          ],
        },
      ],
    });
    const selfHtml = renderPanel('self');
    expect(selfHtml).toContain('Ludy Công tác đang tắt');
    expect(selfHtml).toContain('Công tác đang tắt: cập nhật tiến độ thủ công');
    expect(selfHtml).toContain('data-testid="hr-okr-checkin-open-kr-1"');
    expect(selfHtml).not.toContain('hr-okr-new-objective-btn');
  });
});
