// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { HrLineView } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { HR_TIMEKEEPING_MAX_ROWS, buildTimekeepingPreview, normalizeEmployeeName } from '../src/lib/hr-timekeeping.ts';

const queryClient = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClient.current = new QC();
  return {
    client: { hr: { payroll: { runs: { importTimekeeping: vi.fn() } } } },
    errorMessage: (e: unknown) => String(e),
  };
});

const { TimekeepingImportPanel } = await import('../src/components/hr-timekeeping-panel.tsx');

function payLine(id: string, employeeId: string, employeeName: string): HrLineView {
  return {
    id,
    employeeId,
    employeeName,
    kind: 'pay',
    status: 'calculated',
    refusal: null,
    inputs: {},
    figures: {
      gross: '15000000',
      employeeInsurance: '1575000',
      employerInsurance: '3225000',
      unionFee: '0',
      taxableIncome: '0',
      pit: '0',
      net: '13425000',
      employerCost: '18225000',
    },
    breakdown: null,
    checks: [],
    flags: [],
    note: null,
    adjustsMonth: null,
  };
}

function renderPanel(props: { initialText?: string; lines?: HrLineView[]; locale?: 'vi' | 'en' }) {
  const locale = props.locale ?? 'vi';
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <TimekeepingImportPanel
          runId="00000000-0000-7000-8000-000000000001"
          month="2026-11"
          lines={props.lines ?? [payLine('l1', 'emp-1', 'Nguyễn Thị Hằng'), payLine('l2', 'emp-2', 'Trần Văn Hai')]}
          initialText={props.initialText ?? ''}
          onImported={async () => {}}
          onClose={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('HR timekeeping matching and preview (#3371)', () => {
  it('normalizes names across NFC/NFD accents, whitespace, and case without guessing', () => {
    const nfd = '  Nguyễn   Văn  An '.normalize('NFD');
    expect(normalizeEmployeeName(nfd)).toBe('nguyễn văn an');
    expect(normalizeEmployeeName('NGUYỄN VĂN AN')).toBe('nguyễn văn an');
  });

  it('matches by employeeCode === line.employeeId first, else unique normalized displayName', () => {
    const lines = [
      payLine('line-a', 'emp-uuid-1', 'Trần Văn Trùng'),
      payLine('line-b', 'emp-uuid-2', 'Trần Văn Trùng'),
      payLine('line-c', 'emp-uuid-3', 'Lê Thu Cúc'),
    ];
    const sheet = [
      'Mã NV\tHọ tên\tNghỉ không lương\tNgày chưa làm\tGiờ làm đêm\tLàm thêm ngày thường',
      'emp-uuid-1\tTrần Văn Trùng\t1\t0\t4\t10',
      '\t  lê   thu cúc \t0.5\t2\t0\t45',
    ].join('\n');

    const preview = buildTimekeepingPreview(sheet, '2026-11', lines);
    expect(preview.errors).toEqual([]);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]?.code).toBe('overtime_cap_exceeded');
    expect(preview.matchedCount).toBe(2);
    expect(preview.canApply).toBe(true);
    expect(preview.validRows).toEqual([
      {
        lineId: 'line-a',
        unpaidLeaveDays: '1',
        daysNotEmployed: '0',
        nightHours: '4',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '10' }],
      },
      {
        lineId: 'line-c',
        unpaidLeaveDays: '0.5',
        daysNotEmployed: '2',
        nightHours: '0',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '45' }],
      },
    ]);
    expect(preview.rows[1]?.row.overtimeCapExceeded).toBe(true);
  });

  it('marks ambiguous names and unmatched rows without guessing', () => {
    const lines = [
      payLine('line-a', 'emp-1', 'Nguyễn Văn Bình'),
      payLine('line-b', 'emp-2', 'nguyễn  văn  bình'),
      payLine('line-c', 'emp-3', 'Phạm Thị Dung'),
    ];
    const sheet = [
      'Họ tên\tNghỉ không lương\tLàm thêm ngày thường',
      'Nguyễn Văn Bình\t1\t5',
      'Người Không Tồn Tại\t2\t0',
    ].join('\n');

    const preview = buildTimekeepingPreview(sheet, '2026-11', lines);
    expect(preview.ambiguousCount).toBe(1);
    expect(preview.unmatchedCount).toBe(1);
    expect(preview.matchedCount).toBe(0);
    expect(preview.validRows).toEqual([]);
    expect(preview.canApply).toBe(false);
    expect(preview.rows.map((r) => r.status)).toEqual(['ambiguous', 'unmatched']);
  });

  it('detects duplicate target lineId collisions and blocks apply', () => {
    const lines = [payLine('line-a', 'emp-uuid-1', 'Nguyễn Thị Hằng')];
    const sheet = [
      'Mã NV\tHọ tên\tNghỉ không lương\tLàm thêm ngày thường',
      'emp-uuid-1\t\t1\t5',
      '\tNguyễn Thị Hằng\t2\t8',
    ].join('\n');

    const preview = buildTimekeepingPreview(sheet, '2026-11', lines);
    expect(preview.duplicateTargetCount).toBe(2);
    expect(preview.matchedCount).toBe(0);
    expect(preview.validRows).toEqual([]);
    expect(preview.canApply).toBe(false);
    expect(preview.rows.map((r) => r.status)).toEqual(['duplicate_target', 'duplicate_target']);
  });

  it('rejects parser errors, invalid zHrDays decimals, and >200 matched rows', () => {
    const lines = [payLine('line-a', 'emp-1', 'Nguyễn Thị Hằng')];
    const badNumber = 'Họ tên\tNghỉ không lương\nNguyễn Thị Hằng\tabc';
    expect(buildTimekeepingPreview(badNumber, '2026-11', lines).canApply).toBe(false);

    const badDaysPrecision = 'Họ tên\tNghỉ không lương\nNguyễn Thị Hằng\t1.25';
    const invalidPreview = buildTimekeepingPreview(badDaysPrecision, '2026-11', lines);
    expect(invalidPreview.invalidValueCount).toBe(1);
    expect(invalidPreview.canApply).toBe(false);

    const manyLines = Array.from({ length: HR_TIMEKEEPING_MAX_ROWS + 1 }, (_, i) => payLine(`l${i}`, `e${i}`, `Nhân viên ${i}`));
    const manyRows = ['Mã NV\tNghỉ không lương', ...manyLines.map((l) => `${l.employeeId}\t1`)].join('\n');
    const manyPreview = buildTimekeepingPreview(manyRows, '2026-11', manyLines);
    expect(manyPreview.tooManyRows).toBe(true);
    expect(manyPreview.canApply).toBe(false);
  });

  it('renders TimekeepingImportPanel with preview table, >40h warning, disabled/enabled apply, and i18n flags', () => {
    const emptyHtml = renderPanel({});
    expect(emptyHtml).toContain('data-testid="hr-timekeeping-import"');
    expect(emptyHtml).toContain('data-testid="hr-timekeeping-file"');
    expect(emptyHtml).toContain('data-testid="hr-timekeeping-text"');
    expect(emptyHtml).toMatch(/disabled=""[^>]*data-testid="hr-timekeeping-apply"|data-testid="hr-timekeeping-apply"[^>]*disabled=""/);

    const otSheet = 'Họ tên\tNghỉ không lương\tLàm thêm ngày thường\nNguyễn Thị Hằng\t1\t45';
    const okHtml = renderPanel({ initialText: otSheet, locale: 'vi' });
    expect(okHtml).toContain('data-testid="hr-timekeeping-preview"');
    expect(okHtml).toContain('data-testid="hr-timekeeping-warning"');
    expect(okHtml).toContain('&gt;40h');
    expect(okHtml).toContain('Áp dụng (1 dòng)');
    expect(okHtml).not.toMatch(/disabled=""[^>]*data-testid="hr-timekeeping-apply"|data-testid="hr-timekeeping-apply"[^>]*disabled=""/);

    expect(viMessages.hrPayroll.flag.check_overtime_cap).toBeTruthy();
    expect(en.hrPayroll.flag.check_overtime_cap).toBeTruthy();
    expect(viMessages.hrPayroll.check.overtime_cap).toContain('{actual}');
    expect(en.hrPayroll.check.overtime_cap).toContain('{actual}');
  });
});
