// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of an unrecognised marketplace order report (#4036), rendered on the server with the API's answers seeded in the cache: the button that reads the columns, the pickers (labelled, none for
// a buyer's column), Ly's suggestion only filling them, the same markup with the AI off, the named refusal, the parsed lines with their line keys and nothing saved, a verdict held back when the
// choices changed since, and nothing for a viewer. The check through the real worker and sandbox is CI's database test and the e2e stack.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MarketplaceColumnsFile, MarketplaceColumnsProposal, MarketplaceColumnsStatus } from '@crove/kernel-contract';
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

const { StagedMarketplaceColumns } = await import('../src/components/staged-marketplace-columns.tsx');

const FILE_ID = '01920000-0000-7000-8000-000000000001';
const file = (state: MarketplaceColumnsFile['state'] = 'none'): MarketplaceColumnsFile => ({ fileId: FILE_ID, filename: 'don-hang-la.xlsx', createdAt: '2026-11-08T01:00:00.000Z', state });
const SHEET = {
  headerRow: 1,
  columns: [
    { index: 0, header: 'Ma don hang', samples: ['aaaa9999'], buyer: false },
    { index: 1, header: '', samples: [], buyer: true },
    { index: 2, header: 'So luong', samples: ['9'], buyer: false },
  ],
};
const status = (over: Partial<MarketplaceColumnsStatus> = {}): MarketplaceColumnsStatus => ({
  state: 'done',
  failure: null,
  refusal: null,
  mapping: null,
  requestedAt: '2026-11-08T01:00:00.000Z',
  finishedAt: '2026-11-08T01:00:05.000Z',
  sheet: SHEET,
  preview: null,
  ...over,
});
const MAPPING = { platform: 'shopee' as const, assignments: [{ index: 0, field: 'orderNo' as const }, { index: 2, field: 'quantity' as const }] };
const PREVIEW = {
  lines: [
    { rowNo: 2, orderNo: 'SP001', lineKey: 'Dây sạc|Đen', sku: null, itemName: 'Dây sạc', quantity: '2', amount: '100000', status: 'Hoàn thành' },
    { rowNo: 3, orderNo: 'SP002', lineKey: 'Ốp lưng|Xanh', sku: 'OP1', itemName: 'Ốp lưng', quantity: '1', amount: null, status: null },
  ],
  total: 2,
  skipped: 1,
};
const proposal = (ai: MarketplaceColumnsProposal['ai'], assignments: MarketplaceColumnsProposal['assignments'] = []): MarketplaceColumnsProposal => ({ ai, assignments });

function card(opts: { files?: MarketplaceColumnsFile[]; status?: MarketplaceColumnsStatus; proposal?: MarketplaceColumnsProposal; canDecide?: boolean; locale?: 'en' | 'vi' } = {}): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['marketplace', 'columnsFiles'], opts.files ?? [file(opts.status ? 'done' : 'none')]);
  if (opts.status) qc.setQueryData(['marketplace', 'columns'], opts.status);
  if (opts.proposal) qc.setQueryData(['marketplace', 'columnsProposal'], opts.proposal);
  const locale = opts.locale ?? 'vi';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <StagedMarketplaceColumns canDecide={opts.canDecide ?? true} refetchMs={false} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const buttonTag = (html: string, testId: string) => {
  const tag = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no button ${testId} in: ${html}`);
  return tag;
};
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);
// The list of columns without which option is selected: the markup of the pickers apart from what they hold.
const pickers = (html: string) => (/<ul[^>]*data-testid="staged-columns-list"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '').replace(/ selected=""/g, '');

describe('the unrecognised report card', () => {
  it('shows only the file and the button that reads its columns before anyone asked', () => {
    const html = card();
    expect(html).toContain('Báo cáo đơn hàng của sàn chưa nhận ra');
    expect(html).toContain('don-hang-la.xlsx');
    expect(html).toContain('staged-columns-read');
    expect(html).not.toContain('staged-columns-list');
    expect(html).not.toContain('staged-columns-check');
  });

  it('shows nothing for a viewer and nothing when no report waits', () => {
    expect(card({ canDecide: false })).toBe('');
    expect(card({ files: [] })).toBe('');
  });

  it('labels every picker with its column, offers no picker for a buyer column, and never shows a value', () => {
    const html = card({ status: status() });
    expect(html).toContain('Ma don hang');
    expect(html).toContain('aaaa9999');
    // Two pickers (columns 0 and 2) with a label each, and the platform one; the buyer column has a badge and no picker.
    expect((html.match(/data-testid="staged-columns-field"/g) ?? []).length).toBe(2);
    expect(html).toContain('for="columns-' + FILE_ID + '-0"');
    expect(html).toContain('id="columns-' + FILE_ID + '-0"');
    expect(html).toContain('for="columns-platform-' + FILE_ID + '"');
    expect(html).toContain('staged-columns-buyer');
    expect(html).toContain('Thông tin người mua: không bao giờ được đọc');
    for (const field of ['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount']) expect(html).toContain(`value="${field}"`);
    // 44 px high on a phone.
    expect(html).toContain('[&amp;_select]:h-11');
    expect(html).toContain('min-h-11');
  });

  it('holds the check until a platform and a column are picked, and says what is missing', () => {
    const html = card({ status: status() });
    expect(isDisabled(buttonTag(html, 'staged-columns-check'))).toBe(true);
    expect(html).toContain('Hãy chọn sàn trước.');
  });

  it("fills the pickers with Ly's suggestion but never the platform", () => {
    const html = card({ status: status(), proposal: proposal('used', [{ index: 0, field: 'orderNo' }, { index: 2, field: 'quantity' }]) });
    expect(html).toContain('data-ai="used"');
    expect(html).toContain('Ly đã gợi ý cách ghép này');
    expect(html).toMatch(/value="orderNo" selected=""/);
    expect(html).toMatch(/value="quantity" selected=""/);
    // Each on its own column: the first picker holds the order number, the second the quantity.
    const fields = html.split('data-testid="staged-columns-field"').slice(1);
    expect(fields[0]).toMatch(/value="orderNo" selected=""/);
    expect(fields[1]).toMatch(/value="quantity" selected=""/);
    // The platform is still to pick, so the check is held.
    expect(html).toContain('Hãy chọn sàn trước.');
    expect(isDisabled(buttonTag(html, 'staged-columns-check'))).toBe(true);
  });

  it('never lets a suggestion fill a buyer column', () => {
    const html = card({ status: status(), proposal: proposal('used', [{ index: 1, field: 'sku' }]) });
    expect(html).not.toMatch(/value="sku" selected=""/);
    // Only the buyer column's badge is there, no picker for it, so the two pickers still hold nothing.
    expect(html).toContain('staged-columns-buyer');
    expect((html.match(/value="" selected=""/g) ?? []).length).toBe(3); // the platform and the two pickers
  });

  it('keeps the pickers the same with the AI off, busy, over budget or failed, with the reason in words', () => {
    const used = pickers(card({ status: status(), proposal: proposal('used', [{ index: 0, field: 'orderNo' }]) }));
    expect(used).not.toBe('');
    const reasons = { off: 'AI đang tắt', busy: 'Ly đang bận', budget: 'Ngân sách AI của tháng đã hết', failed: 'Ly chưa gợi ý được', none: 'quá ít cột' } as const;
    for (const [ai, words] of Object.entries(reasons) as Array<[MarketplaceColumnsProposal['ai'], string]>) {
      const html = card({ status: status(), proposal: proposal(ai) });
      expect(pickers(html)).toBe(used);
      expect(html).toContain(`data-ai="${ai}"`);
      expect(html).toContain(words);
    }
  });

  it('names the refusal in words and shows no lines', () => {
    const html = card({ status: status({ mapping: MAPPING, refusal: 'buyer_text' }) });
    expect(html).toContain('staged-columns-refusal');
    expect(html).toContain('data-refusal="buyer_text"');
    expect(html).toContain('email hoặc số điện thoại của người mua');
    expect(html).not.toContain('staged-columns-preview');
  });

  it('shows the parsed lines with their line keys, the counts and that nothing is saved, and no way to import', () => {
    const html = card({ status: status({ mapping: MAPPING, preview: PREVIEW }), proposal: proposal('used') });
    expect(html).toContain('staged-columns-preview');
    expect((html.match(/data-testid="staged-columns-line-key"/g) ?? []).length).toBe(2);
    expect(html).toContain('Dây sạc|Đen');
    expect(html).toContain('Ốp lưng|Xanh');
    expect(html).toContain('SP001');
    expect(html).toContain('Các dòng đọc được: hiện 2 trên 2 dòng');
    expect(html).toContain('Có 1 dòng bị bỏ qua');
    expect(html).toContain('Chưa lưu gì');
    expect(html).toContain('tối đa 7 ngày');
    expect(html).not.toContain('staged-marketplace-import');
    expect(html).not.toContain('staged-columns-save');
  });

  it('says a file that could not be read, and that a check is under way', () => {
    expect(card({ status: status({ state: 'failed', failure: 'unreadable', sheet: null }) })).toContain('Không đọc được tệp này');
    const waiting = card({ status: status({ state: 'requested', sheet: null, requestedAt: new Date().toISOString() }) });
    expect(waiting).toContain('staged-columns-reading');
    expect(waiting).toContain('Đang đọc tệp');
    expect(waiting).not.toContain('staged-columns-stuck');
    // A read that failed can be asked again.
    expect(card({ status: status({ state: 'failed', failure: 'unavailable', sheet: null }) })).toContain('staged-columns-read-again');
  });

  it('does not wait for ever on a check whose job was lost: after the server window it says so and lets the member ask again', () => {
    const longAgo = new Date(Date.now() - 11 * 60_000).toISOString();
    // No sheet was ever recorded: no spinner, a note, and a button to read the file again.
    const noSheet = card({ status: status({ state: 'requested', sheet: null, requestedAt: longAgo }) });
    expect(noSheet).toContain('staged-columns-stuck');
    expect(noSheet).toContain('Việc đọc tệp mất quá lâu');
    expect(noSheet).not.toContain('staged-columns-reading');
    expect(isDisabled(buttonTag(noSheet, 'staged-columns-read-again'))).toBe(false);
    // A sheet is there and a mapping was asked: the note shows and the check button is not held for the waiting job.
    const withSheet = card({ status: status({ state: 'requested', mapping: MAPPING, requestedAt: longAgo }) });
    expect(withSheet).toContain('staged-columns-stuck');
    expect(isDisabled(buttonTag(withSheet, 'staged-columns-check'))).toBe(false);
    // Just under the window it still waits.
    const recent = card({ status: status({ state: 'requested', mapping: MAPPING, requestedAt: new Date(Date.now() - 5 * 60_000).toISOString() }) });
    expect(recent).toContain('staged-columns-reading');
    expect(isDisabled(buttonTag(recent, 'staged-columns-check'))).toBe(true);
  });

  it('speaks English when the member does', () => {
    const html = card({ status: status({ mapping: MAPPING, refusal: 'no_order_no' }), locale: 'en' });
    expect(html).toContain('Marketplace order reports not recognised');
    expect(html).toContain('The Order number column must be picked.');
  });
});
