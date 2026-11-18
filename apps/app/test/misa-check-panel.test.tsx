// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA export on the screen (#3848), rendered on the server: the panel offers the file kinds of its page and a button, makes no call until the button is pressed, and the result lists
// each group by kind and column with its count and the first examples, says plainly when nothing is flagged, and says the checks only warn. Rendering makes no call.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MisaCheck } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { client, errorMessage: (e: unknown) => String(e), orpc: {}, queryClient: cache.current };
});

const { MisaCheckPanel, MisaCheckResult } = await import('../src/components/misa-check-panel.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const wrap = (node: React.ReactNode, locale: 'vi' | 'en') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};

const result: MisaCheck = {
  format: 'misa_sme_purchases',
  rows: 30,
  findings: 63,
  groups: [
    { kind: 'MISSING_CODE', column: 'Mã dịch vụ (*)', limit: null, count: 30, examples: Array.from({ length: 20 }, (_, i) => ({ voucherNo: `CRMDV00000000${String(i).padStart(2, '0')}`, lineNo: 1 })) },
    { kind: 'ACCOUNT_NOT_IN_CHART', column: 'TK chi phí/TK kho', limit: null, count: 2, examples: [{ voucherNo: 'CRMDV000000099', lineNo: 2 }, { voucherNo: 'CRMDV000000100', lineNo: null }] },
    { kind: 'TOO_LONG', column: 'Tên nhà cung cấp', limit: 128, count: 1, examples: [{ voucherNo: 'CRMDV000000101', lineNo: 1 }] },
  ],
};

describe('the check before a MISA export on the screen (#3848)', () => {
  beforeEach(() => {
    cache.calls.length = 0;
  });

  it('offers the file kinds of its page and a button, and calls nothing until the button is pressed', () => {
    const html = wrap(<MisaCheckPanel formats={['misa_sme_cash_receipts', 'misa_sme_bank_debits']} from="2026-10-01" to="2026-10-31" legalEntityId={undefined} />, 'en');
    expect(html).toContain('data-testid="misa-check"');
    expect(html).toContain('Check a MISA file before you download it');
    expect(html).toContain('Cash receipts');
    expect(html).toContain('Bank debits');
    expect(html).not.toContain('Sales');
    expect(html).toContain('data-testid="misa-check-run"');
    expect(html).not.toContain('misa-check-result');
    expect(cache.calls).toEqual([]);
  });

  it('lists each group by kind and column with its count, the first five examples and how many more, and says the checks only warn', () => {
    const html = wrap(<MisaCheckResult result={result} />, 'en');
    expect(html).toContain('63 things to look at in 30 rows');
    expect(html.match(/data-testid="misa-check-group"/g)).toHaveLength(3);
    expect(html).toContain('Code to fill');
    expect(html).toContain('Mã dịch vụ (*)');
    expect(html).toContain('30 rows');
    // Five examples shown of the twenty the server sent; the rest are counted.
    expect(html).toContain('CRMDV0000000000 #1');
    expect(html).toContain('CRMDV0000000004 #1');
    expect(html).not.toContain('CRMDV0000000005 #1');
    expect(html).toContain('and 25 more');
    // A row without a line number is told by its voucher number alone.
    expect(html).toContain('CRMDV000000100');
    expect(html).not.toContain('CRMDV000000100 #');
    // The limit fills the message of a too-long group.
    expect(html).toContain('longer than the 128 characters');
    expect(html).toContain('These checks only warn. The download is not blocked.');
  });

  it('says plainly when nothing is flagged, when the range has no rows, and speaks Vietnamese', () => {
    expect(wrap(<MisaCheckResult result={{ format: 'misa_sme_sales', rows: 12, findings: 0, groups: [] }} />, 'en')).toContain('Nothing to flag in 12 rows');
    expect(wrap(<MisaCheckResult result={{ format: 'misa_sme_sales', rows: 0, findings: 0, groups: [] }} />, 'en')).toContain('nothing in this range');
    const vi = wrap(<MisaCheckResult result={result} />, 'vi');
    expect(vi).toContain('63 điểm cần xem trong 30 dòng');
    expect(vi).toContain('Các kiểm tra này chỉ cảnh báo');
    expect(vi).toContain('dài hơn 128 ký tự');
  });
});
