// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of a staged marketplace income report (#2516), rendered on the server with the API's answers seeded in the cache: what the card shows (platform, period, totals, what no
// column explains), the net the file states or plainly that it states none, each blocker in words, the confirm button held while the report cannot be confirmed, the cap of the list, and
// nothing for a viewer. Confirm and reject through the real stack are in e2e/tests/marketplace-income.spec.ts.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MarketplaceIncomePreview, MarketplaceIncomeStaged } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { StagedMarketplaceIncome, INCOME_STAGED_CAP } = await import('../src/components/staged-marketplace-income.tsx');

const staged = (id: string, over: Partial<MarketplaceIncomeStaged['summary']> = {}): MarketplaceIncomeStaged => ({
  fileId: id,
  filename: `bao-cao-thu-nhap-${id}.xlsx`,
  createdAt: '2026-11-08T01:00:00.000Z',
  entity: { id: 'e1', name: 'Công ty bán trên sàn' },
  summary: {
    state: 'staged',
    platform: 'shopee',
    profileVersion: 'shopee-income-1',
    profileConfirmed: false,
    filename: `bao-cao-thu-nhap-${id}.xlsx`,
    sheet: 'Income',
    orders: 2,
    lines: 2,
    periodStart: '2026-11-03',
    periodEnd: '2026-11-04',
    totals: { sales: '150000', sellerDiscount: '10000', commission: '7500', serviceFee: '3000', paymentFee: '2250', shipping: '0', taxWithheld: '1500', refund: '0', other: '0', net: '125750' },
    statedNet: '125750',
    ignoredRows: 0,
    ...over,
  },
});
const preview = (over: Partial<MarketplaceIncomePreview> = {}): MarketplaceIncomePreview => ({
  reportNet: '125750',
  fileStatesNet: true,
  linesNet: '125750',
  unknownOrders: 0,
  unknownOrderNos: [],
  overlap: null,
  repeatedLines: 0,
  blockers: [],
  ...over,
});

function card(list: MarketplaceIncomeStaged[], p: MarketplaceIncomePreview | null, opts: { canDecide?: boolean; locale?: 'en' | 'vi' } = {}): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['marketplace', 'incomeStaged'], list);
  if (p) qc.setQueryData(['marketplace', 'incomePreview'], p);
  const locale = opts.locale ?? 'vi';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <StagedMarketplaceIncome canDecide={opts.canDecide ?? true} refetchMs={false} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// The opening tag of one button, and whether it carries the disabled attribute (a class such as "disabled:opacity-50" is not one).
const buttonTag = (html: string, testId: string) => {
  const tag = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no button ${testId} in: ${html}`);
  return tag;
};
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);
const confirmDisabled = (html: string) => isDisabled(buttonTag(html, 'staged-income-confirm'));

describe('the staged income report card', () => {
  it('shows the platform, entity, period, orders, every total and the stated net, and nothing of a buyer', () => {
    const html = card([staged('f1')], preview());
    expect(html).toContain('Báo cáo thu nhập của sàn chờ nhập');
    expect(html).toContain('Shopee');
    expect(html).toContain('Công ty bán trên sàn');
    expect(html).toContain('2 đơn, 2 dòng');
    for (const key of ['sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'taxWithheld', 'refund', 'other', 'net']) expect(html).toContain(`staged-income-total-${key}`);
    expect(html).toContain('Tệp ghi tổng sàn thực trả là');
    expect(html).toContain('Cột chưa đối chiếu với tệp thật');
    expect(html).not.toContain('staged-income-blockers');
    expect(confirmDisabled(html)).toBe(false);
    expect(html).toContain('staged-income-reject');
  });

  it('says plainly when the file states no total, and which sum is used instead', () => {
    const html = card([staged('f1', { statedNet: null })], preview({ fileStatesNet: false, reportNet: '125750' }));
    expect(html).toContain('Tệp không ghi tổng');
    expect(html).toContain('Ludy dùng tổng các dòng');
    expect(html).not.toContain('Tệp ghi tổng sàn thực trả là');
    expect(card([staged('f1', { statedNet: null })], preview({ fileStatesNet: false }), { locale: 'en' })).toContain('The file states no total');
  });

  it('flags what no column explains', () => {
    const quiet = card([staged('f1')], preview());
    expect(quiet).not.toContain('Khoản &quot;chưa giải thích được&quot;');
    const html = card([staged('f1', { totals: { ...staged('f1').summary.totals, other: '1200' } })], preview());
    expect(html).toContain('chưa giải thích được');
    expect(html).toContain('Hãy xem lại tệp trước khi nhập');
  });

  it('words every blocker with the platform, and holds the confirm button', () => {
    const html = card(
      [staged('f1')],
      preview({
        blockers: ['PERIOD_UNKNOWN', 'TOTAL_MISMATCH', 'UNKNOWN_ORDERS', 'OVERLAP', 'REPEATED_LINES'],
        linesNet: '120000',
        unknownOrders: 12,
        unknownOrderNos: ['2611A1', '2611A2', '2611A3', '2611A4', '2611A5', '2611A6', '2611A7', '2611A8', '2611A9', '2611B0'],
        overlap: { periodStart: '2026-11-01', periodEnd: '2026-11-07' },
        repeatedLines: 3,
      }),
    );
    for (const code of ['PERIOD_UNKNOWN', 'TOTAL_MISMATCH', 'UNKNOWN_ORDERS', 'OVERLAP', 'REPEATED_LINES']) expect(html).toContain(`staged-income-blocker-${code}`);
    expect(html).toContain('có dòng không có ngày thanh toán');
    expect(html).toContain('không khớp với tổng');
    expect(html).toContain('2611B0, và 2 đơn khác');
    expect(html).toContain('hãy nhập báo cáo đơn hàng của cùng kỳ trước');
    expect(html).toContain('đã có trong một báo cáo thu nhập khác');
    expect(confirmDisabled(html)).toBe(true);
  });

  it('holds the confirm button while the preview is not there yet, and still lets a person skip', () => {
    const html = card([staged('f1')], null);
    expect(confirmDisabled(html)).toBe(true);
    expect(isDisabled(buttonTag(html, 'staged-income-reject'))).toBe(false);
  });

  it('says the list is capped when it is full, and not before', () => {
    const many = Array.from({ length: INCOME_STAGED_CAP }, (_v, i) => staged(`f${i}`));
    expect(card(many, preview())).toContain('staged-income-cap');
    expect(card(many.slice(1), preview())).not.toContain('staged-income-cap');
  });

  it('shows nothing when nothing waits, and nothing to a viewer', () => {
    expect(card([], null)).toBe('');
    expect(card([staged('f1')], preview(), { canDecide: false })).toBe('');
  });
});
