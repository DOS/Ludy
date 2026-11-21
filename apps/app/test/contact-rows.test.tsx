// SPDX-License-Identifier: AGPL-3.0-only
// A row of the People and Companies lists (#3649): the name is the open control, the phone and the email are links (tel: and mailto:), a person's row says how many deals are open, and
// there is no column of "Mở" buttons to scroll to on a phone.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: new QC(), errorMessage: (e: unknown) => String(e), takeOrgLeftNotice: () => null };
});

const { ContactRows } = await import('../src/routes/contacts.tsx');

const person = { id: '00000000-0000-4000-8000-000000000001', kind: 'person', name: 'Nguyễn Văn Khách', taxCode: null, address: null, email: 'khach@example.test', phone: '0901 234 567', version: 1, createdAt: '2026-11-01T00:00:00.000Z', company: { id: 'c', name: 'Công ty ABC' }, peopleCount: 0, openDeals: 2 } as Contact;
const company = { ...person, id: '00000000-0000-4000-8000-000000000002', kind: 'organization', name: 'Công ty ABC', taxCode: '0123456780', email: null, phone: null, company: null, peopleCount: 3, openDeals: 1 } as Contact;

function render(mode: 'people' | 'companies', contact: Contact, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <table>
            <tbody>
              <ContactRows mode={mode} contact={contact} open={false} onToggle={() => undefined} canEdit columns={5} />
            </tbody>
          </table>
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('a row of the contacts lists', () => {
  it("makes the name the open control, and the phone and the email links, with the person's open deals", () => {
    const html = render('people', person);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Mở Nguyễn Văn Khách"[^>]*>Nguyễn Văn Khách<\/button>/);
    expect(html).toContain('href="tel:0901234567"');
    expect(html).toContain('>0901 234 567</a>');
    expect(html).toContain('href="mailto:khach@example.test"');
    expect(html).toMatch(/data-label="Cơ hội mở"[^>]*>2</);
    // No separate "Mở" button.
    expect(html).not.toMatch(/>Mở<\/button>/);
  });

  it('shows a company by its tax code, its people and its open deals', () => {
    const html = render('companies', company);
    expect(html).toContain('0123456780');
    expect(html).toMatch(/data-label="Người liên hệ"[^>]*>3</);
    expect(html).toMatch(/data-label="Cơ hội mở"[^>]*>1</);
    expect(html).not.toContain('tel:');
  });

  it('says it in English', () => {
    expect(render('people', person, 'en')).toContain('aria-label="Open Nguyễn Văn Khách"');
  });
});
