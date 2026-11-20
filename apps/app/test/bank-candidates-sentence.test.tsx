// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's one sentence under a bank line the matcher could not settle (#4219), rendered on the server with the answer of bank.candidatesLine seeded in the cache: with AI on the line shows the sentence
// and the note that it chooses nothing; with AI off, busy, over budget, refused or nothing to choose, nothing is rendered; the component never calls the client (only the query, which the server meters).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankCandidatesLine } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts: { input?: unknown }) => (cache.calls.push(JSON.stringify(opts.input)), { queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: cache.current };
});

const { BankCandidatesSentence } = await import('../src/components/bank-candidates-sentence.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const lineId = '00000000-0000-4000-8000-0000000000a1';

function render(answer: BankCandidatesLine | null, locale: 'vi' | 'en'): string {
  setActiveLocale(locale);
  if (answer) cache.current.setQueryData(['bank', 'candidatesLine'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <BankCandidatesSentence bankLineId={lineId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the sentence under a line with several candidates', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows the sentence and the note that it chooses nothing, in English and in Vietnamese, asking in the page language', () => {
    const en = render({ ai: 'used', text: 'Three candidates fit this line, so a person needs to choose.' }, 'en');
    expect(en).toContain('data-testid="match-look-sentence"');
    expect(en).toContain('Three candidates fit this line');
    expect(en).toContain('It chooses nothing');
    cache.current.clear();
    const vi_ = render({ ai: 'used', text: 'Có 3 ứng viên cho dòng này, cần một người chọn.' }, 'vi');
    expect(vi_).toContain('Có 3 ứng viên cho dòng này');
    expect(vi_).toContain('Câu này không chọn gì');
    expect(cache.calls).toEqual([JSON.stringify({ bankLineId: lineId, lang: 'en' }), JSON.stringify({ bankLineId: lineId, lang: 'vi' })]);
  });

  it('shows nothing with AI off, busy, over budget, refused, or nothing to choose, and nothing while loading', () => {
    for (const ai of ['off', 'busy', 'budget', 'failed', 'none'] as const) {
      cache.current.clear();
      expect(render({ ai, text: null }, 'en')).toBe('');
    }
    cache.current.clear();
    expect(render(null, 'en')).toBe('');
  });
});
