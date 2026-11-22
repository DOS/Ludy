// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayItem } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale, translatorFor } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: () => undefined } }),
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children?: unknown; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children as never}
    </a>
  ),
}));
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => ['hr'], useModulesVersion: () => 0 }));

const { TodayList } = await import('../src/components/today-list.tsx');

const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'hr.probationEnding', params: { count: 2 } },
  { key: 'hr.contractsExpiring', params: { count: 3 } },
  { key: 'hr.contractsExpired', params: { count: 1 } },
  { key: 'hr.workPermitsExpiring', params: { count: 2 } },
  { key: 'hr.workPermitsExpired', params: { count: 1 } },
  { key: 'hr.laborReport01Pli', params: { period: '2026', date: '2026-12-05' } },
  { key: 'hr.leaveApprovalsPending', params: { count: 4 } },
  { key: 'hr.deptLeave', params: { count: 2 } },
];

function hrKeysReferencedInTodayModule(): string[] {
  const sourcePath = fileURLToPath(new URL('../../../modules/hr/src/today.ts', import.meta.url));
  const src = readFileSync(sourcePath, 'utf8');
  const found = new Set<string>();
  const re = /(?:hrTitle\('|key:\s*'hr\.)([a-zA-Z0-9]+)'/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    found.add(`hr.${m[1]!}`);
  }
  return [...found].sort();
}

describe('HR Home Today copy', () => {
  beforeEach(() => {
    client.current.clear();
  });

  it('covers every today.items.hr key used by hr.today with clean vi/en copy and no coworker attribution in the text', () => {
    const referenced = hrKeysReferencedInTodayModule();
    expect(referenced).toEqual(TITLES.map((t) => t.key).sort());

    const viMap = viCatalog.today.items.hr as Record<string, string>;
    const enMap = en.today.items.hr as Record<string, string>;

    type Say = (key: string, values?: Record<string, string | number>) => string;
    const sayIn = (locale: 'vi' | 'en'): Say => translatorFor(locale) as unknown as Say;

    for (const { key, params } of TITLES) {
      const subKey = key.slice('hr.'.length);
      expect(typeof viMap[subKey]).toBe('string');
      expect(typeof enMap[subKey]).toBe('string');

      for (const locale of ['vi', 'en'] as const) {
        const translate = sayIn(locale);
        const rendered = translate(`today.items.${key}`, params);
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).not.toContain('{');
        expect(rendered).not.toMatch(/[—–]/);
        expect(rendered).not.toMatch(/\b(Vy|Ly|Dy|Uy|Hy)\b/u);
        expect(rendered.toLowerCase()).not.toContain('assistant');
        expect(rendered.toLowerCase()).not.toContain('trợ lý');
        for (const value of Object.values(params)) {
          expect(rendered).toContain(String(value));
        }
      }
    }

    // English singular vs plural check.
    const tEn = sayIn('en');
    expect(tEn('today.items.hr.probationEnding', { count: 1 })).toContain('1 employee finishes probation');
    expect(tEn('today.items.hr.deptLeave', { count: 1 })).toContain('1 department leave request is');
  });

  it('renders HR Today items in TodayList attributed to Ly and linked to HR screens', () => {
    const items: TodayItem[] = [
      {
        kind: 'flag',
        app: 'hr',
        id: 'contracts-expired',
        title: { key: 'hr.contractsExpired', params: { count: 1 } },
        count: 1,
        severity: 'block',
        href: '/hr/employees',
      },
      {
        kind: 'deadline',
        app: 'hr',
        id: 'pli-01:2026',
        title: { key: 'hr.laborReport01Pli', params: { period: '2026', date: '2026-12-05' } },
        dueAt: '2026-12-05T23:59:59+07:00',
        severity: 'info',
        href: '/hr/declarations',
      },
      {
        kind: 'proposal',
        app: 'hr',
        id: 'leave-approvals-l1',
        title: { key: 'hr.deptLeave', params: { count: 2 } },
        count: 2,
        href: '/hr/my',
      },
    ];
    const data = {
      items,
      coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' },
      dropped: 0,
      truncated: 0,
      failed: 0,
    };

    for (const locale of ['vi', 'en'] as const) {
      client.current.clear();
      client.current.setQueryData(['today', 'list'], data);
      setActiveLocale(locale);
      const html = renderToStaticMarkup(
        <I18nProvider>
          <QueryClientProvider client={client.current}>
            <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
              <TodayList slug="acme" />
            </IntlProvider>
          </QueryClientProvider>
        </I18nProvider>,
      );

      expect(html).toContain('href="/o/acme/hr/employees"');
      expect(html).toContain('href="/o/acme/hr/declarations"');
      expect(html).toContain('href="/o/acme/hr/my"');
      if (locale === 'vi') {
        expect(html).toContain('Từ Ly');
        expect(html).toContain('1 nhân sự đang làm việc có hợp đồng xác định thời hạn đã quá hạn');
        expect(html).toContain('Báo cáo tình hình thay đổi lao động mẫu 01/PLI kỳ 2026 cần nộp trước 2026-12-05');
        expect(html).toContain('2 đơn xin nghỉ phép của bộ phận đang chờ bạn duyệt');
      } else {
        expect(html).toContain('From Ly');
        expect(html).toContain('1 active employee has an expired fixed-term contract');
        expect(html).toContain('Report 01/PLI on labor changes for 2026 is due by 2026-12-05');
        expect(html).toContain('2 department leave requests are waiting for your review');
      }
    }
  });
});
