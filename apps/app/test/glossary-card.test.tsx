// SPDX-License-Identifier: AGPL-3.0-only
// The glossary's settings card (#4043, step 2): an owner or admin's list, rendered on the server with the list answered from a seeded cache. A term is whatever an admin typed, so it is tried
// with markup and markdown: it is shown as the text it is (escaped, no element made), and the card says in one line that it holds no people's names or personal details.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOSSARY_TERMS_MAX, type GlossaryTermView } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
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
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { GlossaryCard } = await import('../src/components/glossary-card.tsx');

const at = '2026-11-19T00:00:00.000Z';
const HOSTILE = '<img src=x onerror=alert(1)>';
const term = (n: number, text: string): GlossaryTermView => ({ id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, term: text, createdAt: at, updatedAt: at });

function render(terms: GlossaryTermView[], locale: 'vi' | 'en' = 'en'): string {
  const qc = client.current;
  qc.setQueryData(['meetings', 'glossary', 'list'], { terms });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <GlossaryCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the glossary card', () => {
  beforeEach(() => client.current.clear());

  it('lists each term with an edit and a remove button, and shows markup or markdown as the text it is', () => {
    const html = render([term(1, `Crove ${HOSTILE}`), term(2, '**MISA** AMIS')]);
    const rows = html.split('data-testid="glossary-term"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Crove &lt;img src=x onerror=alert(1)&gt;');
    expect(rows[1]).toContain('**MISA** AMIS');
    for (const row of rows) {
      expect(row).toContain(`>${en.glossary.edit}<`);
      expect(row).toContain(`>${en.glossary.remove}<`);
    }
    expect(html).toContain('2 of 60 terms');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror/i);
    expect(html).not.toContain('<strong');
  });

  it('shows the empty line and the add field with no term, and no add field at the limit', () => {
    const empty = render([]);
    expect(empty).toContain(en.glossary.empty);
    expect(empty).toContain('id="gl-new"');
    const full = render(Array.from({ length: GLOSSARY_TERMS_MAX }, (_, i) => term(i + 1, `Thuật ngữ ${i}`)));
    expect(full).not.toContain('id="gl-new"');
    expect(full.replace(/&#x27;/g, "'")).toContain(en.glossary.limit.replace('{max}', String(GLOSSARY_TERMS_MAX)));
  });

  it('says in one line, in Vietnamese and in English, that the list holds no names or contact details', () => {
    expect(viMessages.glossary.noPersonalData).toBe('Không ghi tên người, tên khách hàng, số điện thoại hay địa chỉ email vào đây');
    expect(render([], 'vi')).toContain(viMessages.glossary.noPersonalData);
    expect(render([]).replace(/&#x27;/g, "'")).toContain(en.glossary.noPersonalData);
  });

  it('has the same words in both languages, and a message for each error the commands answer', () => {
    expect(Object.keys(viMessages.glossary).sort()).toEqual(Object.keys(en.glossary).sort());
    for (const code of ['GLOSSARY_TERM_NOT_FOUND', 'GLOSSARY_TERM_TAKEN', 'GLOSSARY_MAX'] as const) {
      expect(viMessages.kernelErrors.codes[code], code).toBeTruthy();
      expect(en.kernelErrors.codes[code], code).toBeTruthy();
    }
  });
});
