// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's sentence on the late sales of the VAT working (#3540): the template built from the lists shows with AI off, spent or refused; a coworker sentence replaces it only when it
// came back used; with nothing late there is no sentence at all; and the note says a person decides the supplementary declaration.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

let explained: { ai: string; text: string | null } | undefined;
const asked: unknown[] = [];
vi.mock('../src/lib/api.ts', () => ({
  orpc: {
    vat: {
      explain: {
        queryOptions: (options: { input: unknown }) => {
          asked.push(options.input);
          return { queryKey: ['vat-explain'], queryFn: () => Promise.resolve(null) };
        },
      },
    },
  },
  client: {},
  queryClient: {},
  apiFetch: () => undefined,
  getCurrentOrg: () => null,
  errorMessage: String,
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: explained }),
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null }),
}));

const { LateSummary } = await import('../src/routes/vat.tsx');

const sale = { documentId: '0192f0aa-1111-7222-8333-944445555777', series: 'C26TAA', number: '124', partyName: 'Công ty An Phát', issueDate: '2026-11-03', saleDate: '2026-10-28', originalPeriod: '2026-10', total: '13750000', vatAmount: '1250000', supplementary: true };
const data = { period: { period: '2026-11', kind: 'month' as const, from: '2026-11-01', to: '2026-11-30' }, lateSales: [sale], supplementary: { documents: [], totals: { byRate: [], taxable: '0', vat: '0', documents: 0 } } };
const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );
const summary = (d = data, locale: 'vi' | 'en' = 'vi') => render(<LateSummary data={d} legalEntityId={undefined} ready version={1} />, locale);

beforeEach(() => {
  explained = undefined;
  asked.length = 0;
});

describe('LateSummary', () => {
  it('shows the template, naming the invoice and its original period, when the AI answer has not come or is off', () => {
    for (const state of [undefined, { ai: 'off', text: null }, { ai: 'busy', text: null }, { ai: 'budget', text: null }, { ai: 'failed', text: null }, { ai: 'quiet', text: null }]) {
      explained = state;
      const html = summary();
      expect(html).toContain('C26TAA-124 (kỳ 2026-10, cần kê khai bổ sung)');
      expect(html).toContain('data-testid="vat-late-summary"');
    }
  });

  it('shows the coworker sentence above the template, which always stays with each invoice\'s status', () => {
    explained = { ai: 'used', text: 'Hóa đơn C26TAA-124 lập muộn cho kỳ 2026-10.' };
    const html = summary();
    expect(html).toContain('data-testid="vat-late-summary-sentence"');
    expect(html).toContain('Hóa đơn C26TAA-124 lập muộn cho kỳ 2026-10.');
    expect(html).toContain('C26TAA-124 (kỳ 2026-10, cần kê khai bổ sung)');
    explained = { ai: 'off', text: null };
    expect(summary()).not.toContain('vat-late-summary-sentence');
  });

  it('says a person decides the supplementary declaration, in both languages', () => {
    expect(summary()).toContain('do người có trách nhiệm quyết định');
    expect(summary(data, 'en')).toContain('for the responsible person to decide');
    expect(summary(data, 'en')).toContain('needs a supplementary declaration');
  });

  it('asks for the sentence of the working\'s period, entity and language', () => {
    summary(data, 'en');
    expect(asked).toEqual([{ period: '2026-11', legalEntityId: undefined, lang: 'en' }]);
  });

  it('is nothing at all when no sale is late', () => {
    expect(summary({ ...data, lateSales: [] })).toBe('');
  });
});
