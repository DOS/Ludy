// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's suggestions in the quote editor (#2698), rendered on the server: the button names the coworker (never "assistant"), the hint says where prices come from and that the person
// chooses, every state the server can answer has a sentence in both languages, and nothing is asked until the person presses the button.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QUOTE_SUGGEST_STATES } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const suggest = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  errorMessage: (e: unknown) => String(e),
  client: { crm: { quotes: { suggest: (...args: unknown[]) => suggest(...args) } } },
  orpc: {},
  queryClient: {},
}));

const { QuoteSuggestions } = await import('../src/components/deal-quotes.tsx');

const render = (locale: 'vi' | 'en', room = 10) => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <QuoteSuggestions dealId="0192c6a0-7b3e-7c1d-8a4f-2b9d3c5e6f70" room={room} vat="10%" onApply={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>,
  );
};

describe('the quote suggestions panel', () => {
  it('shows a button and a hint that name the coworker, asks nothing before it is pressed, and shows no suggestion', () => {
    const html = render('vi');
    expect(html).toContain('data-testid="quote-suggest-ask"');
    expect(html).toMatch(/Nhờ [^<]+ gợi ý dòng hàng/);
    expect(html).toContain('Bạn chọn dòng nào dùng');
    expect(html).not.toContain('{sales}');
    expect(html).not.toContain('data-testid="quote-suggest-line"');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('disables the button and says so when the quote already has the most lines', () => {
    const html = render('en', 0);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="quote-suggest-ask"|data-testid="quote-suggest-ask"[^>]*disabled/);
    expect(html).toContain('most lines it can hold');
  });
});

describe('the copy', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`has a sentence for every state the server answers, in ${locale}, with no leftover placeholder and no "assistant"`, () => {
      const suggestCopy = (catalog(locale) as unknown as { quotes: { suggest: { state: Record<string, string> } & Record<string, unknown> } }).quotes.suggest;
      expect(Object.keys(suggestCopy.state).sort()).toEqual([...QUOTE_SUGGEST_STATES].sort());
      const all = JSON.stringify(suggestCopy);
      expect(all).not.toContain('{sales}');
      expect(all).not.toMatch(/assistant|trợ lý/i);
    });
  }
});
