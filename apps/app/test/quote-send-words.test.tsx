// SPDX-License-Identifier: AGPL-3.0-only
// What the quote's "send" says (#3645): by link it makes a link and marks the quote sent, and nothing reaches the customer until the person pastes it.
// No string of that step may say the quote was sent to the customer.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote, QuoteLinkCreated } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node(['client']), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { NewLink, QuoteSendPanel } = await import('../src/components/quote-send.tsx');

const quote = { id: 'q', number: 'BG-2026-0001', revision: 1, total: '3300000', validUntil: '2026-12-31', status: 'sent', version: 2 } as unknown as Quote;
const link = { path: '/-/q/abc', linkId: 'l', expiresAt: '2026-12-31T00:00:00.000Z' } as unknown as QuoteLinkCreated;

function render(node: React.ReactNode, locale: 'vi' | 'en'): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={client.current}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('the send step of a quote', () => {
  // The link is made from the page's own address.
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://ludy.test' } }));
  afterEach(() => vi.unstubAllGlobals());

  it('names its button for what it does, and its result for what happened', () => {
    const vi = render(<QuoteSendPanel quote={{ ...quote, status: 'draft' }} dirty={false} onSent={() => undefined} />, 'vi');
    expect(vi).toContain('>Tạo liên kết và đánh dấu đã gửi<');
    expect(vi).not.toContain('Gửi và tạo liên kết');
    const result = render(<NewLink quote={quote} link={link} />, 'vi');
    expect(result).toContain('Đã tạo liên kết. Báo giá chuyển sang Đã gửi; bạn dán liên kết vào Zalo hoặc email để khách nhận được.');
  });

  it('says the same in English', () => {
    expect(render(<QuoteSendPanel quote={{ ...quote, status: 'draft' }} dirty={false} onSent={() => undefined} />, 'en')).toContain('>Make the link and mark as sent<');
    expect(render(<NewLink quote={quote} link={link} />, 'en')).toContain('The link is made. The quote is now Sent; paste the link into Zalo or an email so the customer gets it.');
  });

  it('has no string of the link step that says the customer was sent the quote', () => {
    for (const words of [viMessages.quotes.send, en.quotes.send]) {
      for (const key of ['sendLink', 'linkMade', 'viaLink'] as const) expect(words[key]).not.toMatch(/^(Đã gửi|Gửi và|Sent\.|Send and)/);
    }
  });
});
