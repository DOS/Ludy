// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's offers on a deal after its quote is sent or accepted (#3420), rendered on the server from a seeded cache: the move to "Báo giá" or to the won stage and
// "Đặt giá trị cơ hội bằng tổng báo giá" show only where the rule says, never to a viewer, each with its own button and a way to dismiss it, and nothing is requested until a click.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const mutated = vi.hoisted(() => [] as string[]);

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions')
          return () => ({
            mutationFn: () => {
              mutated.push(path.join('.'));
              return Promise.resolve({});
            },
          });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { QuoteDealOffers } = await import('../src/components/quote-deal-offers.tsx');

const stage = (n: number, name: string, kind: 'open' | 'won' | 'lost') => ({ id: `00000000-0000-4000-8000-0000000002${n}0`, name, kind, position: n });
const STAGES = [stage(1, 'Mới', 'open'), stage(2, 'Đã liên hệ', 'open'), stage(3, 'Báo giá', 'open'), stage(4, 'Thương lượng', 'open'), stage(5, 'Thắng', 'won'), stage(6, 'Thua', 'lost')];
const dealAt = (n: number, over: Record<string, unknown> = {}) => ({ id: 'deal-1', partyId: 'party-1', title: 'Gói kế toán năm', amount: '1500000', stageId: STAGES[n - 1]!.id, stageKind: STAGES[n - 1]!.kind, expectedClose: null, ownerUserId: null, version: 3, ...over });
const quote = (over: Record<string, unknown> = {}) => ({ id: 'quote-1', dealId: 'deal-1', number: 'BG-2026-0001', revision: 1, status: 'sent', expired: false, total: '1650000', updatedAt: '2026-11-15T02:00:00.000Z', ...over }) as never;

function render(opts: { deal: unknown; quotes: unknown[]; canEdit?: boolean; locale?: 'vi' | 'en' }): string {
  setActiveLocale(opts.locale ?? 'vi');
  client.current.setQueryData(['crm', 'deals', 'get'], opts.deal);
  client.current.setQueryData(['crm', 'pipeline', 'stages'], STAGES);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <QuoteDealOffers dealId="deal-1" quotes={opts.quotes as never} canEdit={opts.canEdit ?? true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the offers on a deal after a quote (#3420)', () => {
  beforeEach(() => {
    client.current.clear();
    mutated.length = 0;
  });

  it('after a send, offers "Báo giá" and the quote total to a deal in "Mới", each with a dismiss, and moves nothing by itself', () => {
    const html = render({ deal: dealAt(1), quotes: [quote()] });
    expect(html).toContain('data-testid="quote-deal-offers"');
    expect(html).toContain('Chuyển sang Báo giá');
    expect(html).toContain('Đặt giá trị cơ hội bằng tổng báo giá');
    expect(html.split('>Bỏ qua<').length - 1).toBe(2);
    expect(html).toContain('BG-2026-0001');
    expect(mutated).toEqual([]);
  });

  it('offers no move to a deal already at "Báo giá", only the amount when it differs; and nothing when the deal holds the total', () => {
    const html = render({ deal: dealAt(3), quotes: [quote()] });
    expect(html).not.toContain('Chuyển sang');
    expect(html).toContain('Đặt giá trị cơ hội bằng tổng báo giá');
    expect(render({ deal: dealAt(3, { amount: '1650000.00' }), quotes: [quote()] })).not.toContain('quote-deal-offers');
  });

  it('after an acceptance, offers the won stage and the amount', () => {
    const html = render({ deal: dealAt(3), quotes: [quote({ status: 'accepted' })] });
    expect(html).toContain('Chuyển sang Thắng');
    expect(html).toContain('Khách đã đồng ý báo giá BG-2026-0001');
    expect(html).toContain('Đặt giá trị cơ hội bằng tổng báo giá');
  });

  it('shows nothing for a closed deal, a draft quote or a viewer', () => {
    expect(render({ deal: dealAt(5), quotes: [quote({ status: 'accepted' })] })).not.toContain('quote-deal-offers');
    expect(render({ deal: dealAt(1), quotes: [quote({ status: 'draft' })] })).not.toContain('quote-deal-offers');
    expect(render({ deal: dealAt(1), quotes: [quote()], canEdit: false })).not.toContain('quote-deal-offers');
  });

  it('speaks English too, in the coworker\'s name', () => {
    const html = render({ deal: dealAt(1), quotes: [quote()], locale: 'en' });
    expect(html).toContain('Move to Báo giá');
    expect(html).toContain('Set the deal value to the quote total');
    expect(html).toContain('Dismiss');
  });
});
