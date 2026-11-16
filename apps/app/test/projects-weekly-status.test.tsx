// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWeeklyStatus as ProjectWeeklyStatusData } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const queryHolder = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryHolder.current = new QC();
  return {
    orpc: {},
    client: {},
    queryClient: queryHolder.current,
    errorMessage: (e: unknown) => String(e),
  };
});

const { ProjectWeeklyStatus, projectWeeklyStatusQueryKey } = await import('../src/components/project-weekly-status.tsx');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function fixture(overrides: Partial<ProjectWeeklyStatusData> = {}): ProjectWeeklyStatusData {
  return {
    ai: 'used',
    project: { id: PROJECT_ID, name: 'Ra mắt Q4', status: 'active' },
    window: { from: '2026-11-10', to: '2026-11-16', nextFrom: '2026-11-17', nextTo: '2026-11-23', timeZone: 'Asia/Ho_Chi_Minh' },
    counts: { totalVisible: 6, doneThisWeek: 2, overdue: 1, waiting: 1, dueNextWeek: 2 },
    tasks: {
      doneThisWeek: [
        { id: '22222222-2222-4222-8222-222222222201', title: 'Chốt bảng giá', status: 'done', due: '2026-11-12T03:00:00.000Z', commentCount: 2, latestComment: 'Đã ký duyệt.' },
      ],
      overdue: [
        { id: '22222222-2222-4222-8222-222222222202', title: 'Kiểm tra hợp đồng', status: 'in_progress', due: '2026-11-08T03:00:00.000Z', commentCount: 0, latestComment: null },
      ],
      waiting: [
        { id: '22222222-2222-4222-8222-222222222203', title: 'Chờ khách duyệt mẫu', status: 'waiting', due: null, commentCount: 0, latestComment: null },
      ],
      dueNextWeek: [
        { id: '22222222-2222-4222-8222-222222222204', title: 'Họp tổng kết', status: 'todo', due: '2026-11-20T03:00:00.000Z', commentCount: 0, latestComment: null },
      ],
    },
    hiddenByEntityCount: 0,
    sentences: [
      'Tuần này dự án hoàn thành 2 việc gồm Chốt bảng giá.',
      'Hiện có 1 việc quá hạn là Kiểm tra hợp đồng.',
      'Tuần tới có 2 việc đến hạn gồm Họp tổng kết.',
    ],
    truncated: false,
    ...overrides,
  };
}

function renderCard({
  locale = 'vi',
  defaultOpen = true,
  data,
}: {
  locale?: 'vi' | 'en';
  defaultOpen?: boolean;
  data?: ProjectWeeklyStatusData;
}): string {
  const qc = queryHolder.current;
  qc.clear();
  if (data) {
    qc.setQueryData(projectWeeklyStatusQueryKey('acme', PROJECT_ID, locale), data);
  }
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={catalog(locale) as never}>
          <ProjectWeeklyStatus slug="acme" projectId={PROJECT_ID} defaultOpen={defaultOpen} />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  queryHolder.current.clear();
});

describe('ProjectWeeklyStatus component (#2597)', () => {
  it('stays collapsed behind the on-demand trigger button until clicked', () => {
    const htmlVi = renderCard({ locale: 'vi', defaultOpen: false });
    expect(htmlVi).toContain('Tình hình tuần này');
    expect(htmlVi).not.toContain('project-weekly-status-card');

    const htmlEn = renderCard({ locale: 'en', defaultOpen: false });
    expect(htmlEn).toContain('This week');
    expect(htmlEn).not.toContain('project-weekly-status-card');
  });

  it('renders deterministic counts, visible task titles, AI badge and Vy sentences when available', () => {
    const html = renderCard({ locale: 'vi', defaultOpen: true, data: fixture({ hiddenByEntityCount: 3 }) });
    expect(html).toContain('data-testid="project-weekly-status-card"');
    expect(html).toContain('data-testid="project-weekly-status-ai-badge"');
    expect(html).toContain('Vy (AI)');
    expect(html).toContain('Tuần này dự án hoàn thành 2 việc gồm Chốt bảng giá.');
    expect(html).toContain('Chốt bảng giá');
    expect(html).toContain('Đã ký duyệt.');
    expect(html).toContain('Kiểm tra hợp đồng');
    expect(html).toContain('Chờ khách duyệt mẫu');
    expect(html).toContain('Họp tổng kết');
    expect(html).toContain('2 bình luận');
    expect(html).toContain('Có 3 việc thuộc đơn vị bạn chưa có quyền xem');
  });

  it('keeps counts and task lists visible and explains why Vy is unavailable on off, paused, budget, refused and forbidden states', () => {
    for (const [state, expectedPhrase] of [
      ['off', 'AI đang tắt trên máy chủ này'],
      ['paused', 'Vy đang tạm dừng theo công tắc ngắt AI'],
      ['budget', 'Vy đã dùng hết ngân sách AI tháng này'],
      ['refused', 'không đạt kiểm tra đối chiếu số liệu'],
      ['forbidden', 'Tài khoản chỉ xem không gọi được tóm tắt AI'],
      ['empty', 'Dự án chưa có công việc nào để tổng hợp tuần này'],
    ] as const) {
      const html = renderCard({
        locale: 'vi',
        defaultOpen: true,
        data: fixture({ ai: state, sentences: [] }),
      });
      expect(html, state).toContain('data-testid="weekly-count-done"');
      expect(html, state).toContain('data-testid="weekly-count-overdue"');
      expect(html, state).toContain('data-testid="project-weekly-status-unavailable"');
      expect(html, state).toContain(expectedPhrase);
      expect(html, state).not.toContain('data-testid="project-weekly-status-ai-badge"');
      expect(html, state).toContain('Kiểm tra hợp đồng');
    }
  });
});
