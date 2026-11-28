// SPDX-License-Identifier: AGPL-3.0-only
// SSR deep-link tests for /contacts?c=<partyId> and /companies?c=<partyId> (#4994 SG2).
// Verifies ContactPanel opens for both person and organization targets loaded via crm.contacts.get
// (even when absent from paginated list), handles error state cleanly, and keeps >= 44 px phone targets.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const qcState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));
const searchState = vi.hoisted(() => ({ current: {} as { c?: string } }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  qcState.current = new QC({ defaultOptions: { queries: { retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'infiniteOptions') {
          return (args?: { input?: (cursor: string | undefined) => unknown }) => ({
            queryKey: [...path, 'infinite', args?.input?.(undefined) ?? {}],
            initialPageParam: undefined as string | undefined,
            getNextPageParam: () => undefined,
            queryFn: () => Promise.resolve({ items: [], next: null }),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: qcState.current, errorMessage: (e: unknown) => String(e) };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => searchState.current,
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, params, className }: { children?: ReactNode; to: string; params?: { slug: string }; className?: string }) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? 'acme'), className }, children),
  };
});

vi.mock('../src/components/add-contact-panel.tsx', () => ({ AddContactPanel: () => null }));
vi.mock('../src/components/view-tabs.tsx', () => ({ ViewTabs: () => null }));
vi.mock('../src/components/company-link.tsx', () => ({ CompanyPeople: () => null, PersonCompany: () => null }));
vi.mock('../src/components/contact-attention.tsx', () => ({
  ContactAttention: ({ partyId }: { partyId: string }) => <div data-testid="contact-attention-stub" data-party={partyId} />,
}));
vi.mock('../src/components/contact-deals.tsx', () => ({ ContactDeals: () => null }));
vi.mock('../src/components/linked-meetings.tsx', () => ({ LinkedMeetings: () => null, meetingsInstalled: () => false }));
vi.mock('../src/components/notes-panel.tsx', () => ({ RecordNotesPanel: () => null, notesInstalled: () => false }));
vi.mock('../src/components/party-edit.tsx', () => ({ EditParty: () => null }));

const { ContactsPage, CompaniesPage } = await import('../src/routes/contacts.tsx');

const PERSON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mkContact = (over: Partial<Contact> = {}): Contact => ({
  id: PERSON_ID,
  kind: 'person',
  name: 'Nguyễn Văn A',
  taxCode: null,
  address: null,
  email: 'a@example.test',
  phone: '0901234567',
  version: 1,
  createdAt: '2026-11-20T09:00:00.000Z',
  company: null,
  peopleCount: 0,
  openDeals: 1,
  actorOrigin: 'ui',
  tainted: false,
  ...over,
});

async function renderContacts(opts: { mode?: 'people' | 'companies'; target?: Contact; listItems?: Contact[]; errorTargetId?: string }): Promise<string> {
  const qc = qcState.current;
  qc.clear();
  qc.setQueryData(['org', 'get', {}], { role: 'member' });
  const askedKind = opts.mode === 'companies' ? 'organization' : 'person';
  qc.setQueryData(
    ['crm', 'contacts', 'list', 'infinite', { filters: { v: 1, all: [{ field: 'kind', op: 'is', value: askedKind }] } }],
    { pages: [{ items: opts.listItems ?? [], next: null }], pageParams: [undefined] },
  );
  if (opts.target) {
    searchState.current = { c: opts.target.id };
    qc.setQueryData(['crm', 'contacts', 'get', { partyId: opts.target.id }], opts.target);
  } else if (opts.errorTargetId) {
    searchState.current = { c: opts.errorTargetId };
    await qc
      .fetchQuery({
        queryKey: ['crm', 'contacts', 'get', { partyId: opts.errorTargetId }],
        queryFn: () => Promise.reject(new Error('Không tìm thấy liên hệ')),
        retry: false,
      })
      .catch(() => undefined);
  } else {
    searchState.current = {};
  }
  setActiveLocale('vi');
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          {opts.mode === 'companies' ? <CompaniesPage /> : <ContactsPage />}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  searchState.current = {};
  qcState.current.clear();
});

describe('Contacts & Companies ?c=<partyId> deep-link (#4994 SG2)', () => {
  it('opens a deep-linked person on /contacts even when absent from paginated list, keeping 44 px phone targets', async () => {
    const person = mkContact({ id: PERSON_ID, name: 'Trần Thị B' });
    const html = await renderContacts({ target: person, listItems: [] });
    expect(html).toContain('Trần Thị B');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`data-testid="contact-attention-stub" data-party="${PERSON_ID}"`);
    expect(html).toContain('max-md:min-h-11');
  });

  it('opens an organization linked from Home onto /contacts?c=<orgId> and supports /companies?c=<orgId>', async () => {
    const org = mkContact({ id: ORG_ID, kind: 'organization', name: 'Công ty Ánh Dương', taxCode: '0301234567', peopleCount: 3 });
    const onContacts = await renderContacts({ mode: 'people', target: org, listItems: [] });
    expect(onContacts).toContain('Công ty Ánh Dương');
    expect(onContacts).toContain(`data-party="${ORG_ID}"`);

    const onCompanies = await renderContacts({ mode: 'companies', target: org, listItems: [org] });
    expect(onCompanies).toContain('Công ty Ánh Dương');
    expect(onCompanies).toContain('0301234567');
  });

  it('shows the deep-link lookup error without crashing when ?c=<id> does not exist', async () => {
    const missingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const html = await renderContacts({ errorTargetId: missingId, listItems: [mkContact()] });
    expect(html).toContain('Không tìm thấy liên hệ');
    expect(html).toContain('Nguyễn Văn A');
  });
});
