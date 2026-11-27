// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrSelfShiftsResult, HrShiftRosterResult } from '@ludy/kernel-contract';
import { HrSelfShiftsCard } from '../src/components/hr-self-shifts-card.tsx';
import { HrShiftsPanel, formatMinuteClock, parseClockToMinute } from '../src/components/hr-shifts-panel.tsx';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
        if (prop === 'mutationOptions') {
          return () => ({ mutationFn: vi.fn() });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
  };
});

function wrap(ui: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('HR Stage 7A Shifts UI & i18n (#5216)', () => {
  beforeEach(() => {
    cache.current.clear();
  });

  it('formats and parses clock minutes and translates all Stage 7A commands, objects, and AI meter features', () => {
    expect(formatMinuteClock(480)).toBe('08:00');
    expect(formatMinuteClock(1320)).toBe('22:00');
    expect(parseClockToMinute('08:30')).toBe(510);
    expect(parseClockToMinute('bad')).toBeNull();

    for (const msg of [viMessages, enMessages]) {
      expect(msg.aiMeter.features.hr_shift_coverage_suggest).toBeTruthy();
      expect(msg.audit.objects.hr.shift_template).toBeTruthy();
      expect(msg.audit.objects.hr.shift_assignment).toBeTruthy();
      expect(msg.audit.objects.hr.shift_swap_request).toBeTruthy();
      expect(msg.commands.hr.shift.template.seed_defaults).toBeTruthy();
      expect(msg.commands.hr.shift.roster.get).toBeTruthy();
      expect(msg.commands.hr.shift.assignment.upsert).toBeTruthy();
      expect(msg.commands.hr.shift_swap.approve).toBeTruthy();
      expect(msg.commands.hr.self.shifts.list).toBeTruthy();
      expect(msg.commands.hr.self.shift_swap.submit).toBeTruthy();
    }
  });

  it('renders embedded weekly roster and self shift cards without raw keys in vi and en', () => {
    const rosterData: HrShiftRosterResult = {
      legalEntityId: '00000000-0000-7000-8000-000000000001',
      weekStart: '2027-04-05',
      weekEnd: '2027-04-11',
      canManageOrgRoster: true,
      manageableDepartmentIds: [],
      templates: [
        {
          id: '00000000-0000-7000-8000-000000000010',
          legalEntityId: '00000000-0000-7000-8000-000000000001',
          code: 'CA_HC',
          name: 'Ca hành chính',
          startMinute: 480,
          endMinute: 1020,
          breakMinutes: 60,
          graceLateMinutes: 15,
          graceEarlyMinutes: 15,
          crossesMidnight: false,
          durationMinutes: 540,
          archivedAt: null,
          updatedAt: '2027-04-05T00:00:00.000Z',
        },
      ],
      employees: [
        {
          id: '00000000-0000-7000-8000-000000000020',
          displayName: 'Nguyễn Văn An',
          departmentId: null,
          departmentName: null,
        },
      ],
      assignments: [
        {
          id: '00000000-0000-7000-8000-000000000030',
          legalEntityId: '00000000-0000-7000-8000-000000000001',
          employeeId: '00000000-0000-7000-8000-000000000020',
          employeeName: 'Nguyễn Văn An',
          departmentId: null,
          departmentName: null,
          shiftTemplateId: '00000000-0000-7000-8000-000000000010',
          shiftCode: 'CA_HC',
          shiftName: 'Ca hành chính',
          startMinute: 480,
          endMinute: 1020,
          breakMinutes: 60,
          graceLateMinutes: 15,
          graceEarlyMinutes: 15,
          crossesMidnight: false,
          workDate: '2027-04-05',
          note: null,
          updatedAt: '2027-04-05T00:00:00.000Z',
        },
      ],
      pendingSwapsCount: 0,
    };

    const selfData: HrSelfShiftsResult = {
      employeeId: '00000000-0000-7000-8000-000000000020',
      legalEntityId: '00000000-0000-7000-8000-000000000001',
      departmentId: null,
      weekStart: '2027-04-05',
      weekEnd: '2027-04-11',
      assignments: rosterData.assignments,
      peerCandidates: [
        {
          id: '00000000-0000-7000-8000-000000000021',
          displayName: 'Trần Thị Bình',
          departmentId: null,
          departmentName: null,
        },
      ],
      swaps: [],
    };

    const monday = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const [y, m, d] = monday.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    const weekStartNow = new Date(Date.UTC(y!, m! - 1, d! - ((dow + 6) % 7))).toISOString().slice(0, 10);

    cache.current.setQueryData(
      ['hr', 'shifts', 'roster', 'get', { legalEntityId: '00000000-0000-7000-8000-000000000001', weekStart: weekStartNow }],
      rosterData,
    );
    cache.current.setQueryData(
      ['hr', 'shifts', 'swaps', 'list', { legalEntityId: '00000000-0000-7000-8000-000000000001' }],
      { legalEntityId: '00000000-0000-7000-8000-000000000001', swaps: [] },
    );
    cache.current.setQueryData(['hr', 'self', 'shifts', 'list', { weekStart: weekStartNow }], selfData);

    const panelHtml = wrap(
      <HrShiftsPanel legalEntityId="00000000-0000-7000-8000-000000000001" canManageOrgRoster={true} />,
      'vi',
    );
    expect(panelHtml).toContain('data-testid="hr-shifts-panel"');
    expect(panelHtml).toContain('Nguyễn Văn An');
    expect(panelHtml).toContain('CA_HC');

    const selfHtml = wrap(<HrSelfShiftsCard enabled={true} />, 'en');
    expect(selfHtml).toContain('data-testid="hr-my-shifts-card"');
    expect(selfHtml).toContain('CA_HC');
    expect(selfHtml).toContain('Request swap');
  });
});
