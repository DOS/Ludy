// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen (#2516 slice D), rendered on the server with the answer of marketplace.balance seeded in the cache: a platform shows its four figures, none posted yet says so, nothing is
// asked of a model and nothing on the screen can be pressed (it only reads the ledger); and the finance coworker's one line above it (slice E): the facts always, the checked sentence only when
// there is one, and the facts alone for every state with no sentence.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceBalance, MarketplaceFacts, MarketplaceLine } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: undefined }) }));

const { MarketplaceBalancePage } = await import('../src/routes/marketplace-balance.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';

function render(answer: MarketplaceBalance | null, locale: 'vi' | 'en' = 'en', line: MarketplaceLine | null = null, facts: MarketplaceFacts | null = line?.facts ?? null): string {
  setActiveLocale(locale);
  if (answer) cache.current.setQueryData(['marketplace', 'balance'], answer);
  if (facts) cache.current.setQueryData(['marketplace', 'facts'], facts);
  if (line) cache.current.setQueryData(['marketplace', 'line'], line);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceBalancePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the Sàn screen (#2516)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows each platform with its sales, what it paid out, what it still owes and the fees awaiting an invoice', () => {
    const html = render({
      rows: [
        { legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', salesPosted: '1500000', paidOut: '1000000', awaitingPayout: '500000', feesAwaitingInvoice: '100000' },
        { legalEntityId: entity, platform: 'tiktok_shop', platformName: 'TikTok Shop', salesPosted: '250000', paidOut: '600000', awaitingPayout: '-350000', feesAwaitingInvoice: '0' },
      ],
    });
    expect(html.match(/data-testid="marketplace-balance-row"/g)).toHaveLength(2);
    expect(html).toContain('Shopee');
    expect(html).toContain('TikTok Shop');
    expect(html).toContain('Sales posted (131)');
    expect(html).toContain('Cleared by payouts');
    expect(html).toContain('Still owed by the platform');
    expect(html).toContain('Fees awaiting an invoice (1388)');
    expect(html).toContain('data-testid="marketplace-balance-note"');
    expect(html).not.toContain('<button');
    expect(cache.calls).toEqual([]);
  });

  it('says plainly that no platform has been posted yet', () => {
    const html = render({ rows: [] });
    expect(html).not.toContain('marketplace-balance-row');
    expect(html).toContain('No platform has been posted yet');
  });

  it('reads in Vietnamese', () => {
    const html = render({ rows: [{ legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', salesPosted: '10', paidOut: '0', awaitingPayout: '10', feesAwaitingInvoice: '0' }] }, 'vi');
    expect(html).toContain('Còn chờ sàn trả');
    expect(html).toContain('Phí chờ hóa đơn (1388)');
  });

  describe('the coworker\'s line (#2516 slice E)', () => {
    const FACTS = { settlementsToPost: 2, awaitingPayout: '1600000', feesAwaitingInvoice: '120000' };
    const line = (over: Partial<MarketplaceLine> = {}): MarketplaceLine => ({ facts: FACTS, ai: 'used', text: '2 stored settlements are waiting to be posted.', ...over });

    it('shows the facts and the sentence, even before any platform is posted', () => {
      const html = render({ rows: [] }, 'en', line());
      expect(html).toContain('data-testid="marketplace-line"');
      expect(html).toContain('Stored settlements waiting to be posted: 2');
      expect(html).toContain('Platforms still owe');
      expect(html).toContain('Fees awaiting an invoice:');
      expect(html).toContain('data-testid="marketplace-line-text"');
      expect(html).toContain('2 stored settlements are waiting to be posted.');
      // The empty state of the table is still there, and nothing on the screen can be pressed.
      expect(html).toContain('No platform has been posted yet');
      expect(html).not.toContain('<button');
      expect(cache.calls).toEqual([]);
    });

    it('shows the facts as soon as they arrive, before the sentence is back and when it never comes', () => {
      // Only the facts are in the cache: the sentence is still being asked (or its call failed), and the line is not blank.
      const html = render({ rows: [] }, 'en', null, FACTS);
      expect(html).toContain('data-testid="marketplace-line"');
      expect(html).toContain('Stored settlements waiting to be posted: 2');
      expect(html).not.toContain('data-testid="marketplace-line-text"');
      expect(html).not.toContain('data-testid="marketplace-line-ai-state"');
      // Before the facts arrive the line says it is reading, and invents nothing.
      cache.current.clear();
      const waiting = render({ rows: [] }, 'en', null, null);
      expect(waiting).toContain('data-testid="marketplace-line-loading"');
      expect(waiting).not.toContain('data-testid="marketplace-line"');
    });

    it('does not show an older sentence beside facts that have changed since', () => {
      // The cached sentence was written for 2 settlements; the facts now say 1.
      const html = render({ rows: [] }, 'en', line(), { ...FACTS, settlementsToPost: 1 });
      expect(html).toContain('Stored settlements waiting to be posted: 1');
      expect(html).not.toContain('data-testid="marketplace-line-text"');
      cache.current.clear();
      const busy = render({ rows: [] }, 'en', line({ ai: 'busy', text: null }), { ...FACTS, settlementsToPost: 1 });
      expect(busy).not.toContain('data-testid="marketplace-line-ai-state"');
    });

    it('treats less than half a dong as nothing, as the coworker is told', () => {
      const html = render({ rows: [] }, 'en', line({ facts: { settlementsToPost: 0, awaitingPayout: '0.4', feesAwaitingInvoice: '0' }, ai: 'none', text: null }));
      expect(html).toContain('Nothing is waiting here.');
      expect(html).not.toContain('Platforms still owe');
    });

    it('shows the facts alone with AI off, and leaves out a fact that is zero', () => {
      const html = render({ rows: [] }, 'en', line({ facts: { ...FACTS, awaitingPayout: '0', feesAwaitingInvoice: '0' }, ai: 'off', text: null }));
      expect(html).toContain('Stored settlements waiting to be posted: 2');
      expect(html).not.toContain('Platforms still owe');
      expect(html).not.toContain('data-testid="marketplace-line-text"');
      expect(html).not.toContain('data-testid="marketplace-line-ai-state"');
    });

    it('names a busy, spent or refused coworker without a sentence, and keeps the facts', () => {
      for (const ai of ['busy', 'budget', 'failed'] as const) {
        cache.current.clear();
        const html = render({ rows: [] }, 'en', line({ ai, text: null }));
        expect(html).toContain('data-testid="marketplace-line-ai-state"');
        expect(html).not.toContain('data-testid="marketplace-line-text"');
        expect(html).toContain('Stored settlements waiting to be posted: 2');
      }
    });

    it('says nothing is waiting when every fact is zero, and shows no sentence for it', () => {
      const html = render({ rows: [] }, 'en', line({ facts: { settlementsToPost: 0, awaitingPayout: '0', feesAwaitingInvoice: '0' }, ai: 'none', text: null }));
      expect(html).toContain('Nothing is waiting here.');
    });

    it('reads in Vietnamese and says the coworker posts nothing', () => {
      const html = render({ rows: [] }, 'vi', line({ text: 'Có 2 kỳ đối soát đang chờ ghi sổ.' }));
      expect(html).toContain('Kỳ đối soát đã lưu đang chờ ghi sổ: 2');
      expect(html).toContain('Sàn còn nợ');
      expect(html).toContain('không ghi sổ giúp');
      expect(html).not.toContain('{finance}');
    });
  });
});
