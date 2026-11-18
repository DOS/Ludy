// SPDX-License-Identifier: AGPL-3.0-only
// Adding a contact inside the deal form and a deal from the contact's panel (#3292), rendered on the server: the deal form
// opened for a contact shows that contact and no way to change it, a plain deal form still searches, the inline group
// asks for the fields of the party command and is not a form of its own (the deal form around it is one), and the contact's
// panel offers "Thêm cơ hội" to a person who can edit and nothing to a viewer.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '@crove/kernel-contract';
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
  return { orpc: node([]), client: node([]), queryClient: new QC(), errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DealForm } = await import('../src/components/deal-form.tsx');
const { NewPartyGroup } = await import('../src/components/deal-party-new.tsx');
const { ContactDeals } = await import('../src/components/contact-deals.tsx');

const PARTY = { id: '00000000-0000-4000-8000-000000000010', name: 'Công ty ABC', kind: 'organization' as const, taxCode: '0123456780' };
const CONTACT = { id: PARTY.id, name: PARTY.name, kind: 'organization', taxCode: PARTY.taxCode } as unknown as Contact;

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the deal form and the party picker', () => {
  it('opens for a contact with that contact chosen and no way to change it', () => {
    const html = render(<DealForm deal={null} members={[]} presetParty={PARTY} onDone={() => undefined} />);
    expect(html).toContain('Công ty ABC');
    expect(html).not.toContain('Đổi khách hàng');
    expect(html).not.toContain('type="search"');
  });

  it('is still a search when no contact is given', () => {
    const html = render(<DealForm deal={null} members={[]} onDone={() => undefined} />);
    expect(html).toContain('type="search"');
    expect(html).not.toContain('Công ty ABC');
  });
});

describe('the inline new contact group', () => {
  it('asks for the name (filled from the search), kind, phone and email, with no tax code for a person and no form of its own', () => {
    const html = render(<NewPartyGroup initialName=" Nguyễn Văn Mới " onCreated={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('role="group"');
    expect(html).not.toContain('<form');
    expect(html).toContain('value="Nguyễn Văn Mới"');
    for (const word of ['Tên', 'Loại', 'Điện thoại', 'Email', 'Thêm liên hệ', 'Hủy']) expect(html).toContain(word);
    expect(html).not.toContain('Mã số thuế');
    // Its own buttons never submit the deal form around it.
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
  });

  it('turns a searched tax code into a company with that tax code, not a person named by it', () => {
    const html = render(<NewPartyGroup initialName="0123456780" onCreated={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('Mã số thuế');
    expect(html).toContain('value="0123456780"');
    expect(html).toMatch(/<option value="organization" selected/);
  });

  it('speaks English in an English session', () => {
    const html = render(<NewPartyGroup initialName="" onCreated={() => undefined} onCancel={() => undefined} />, 'en');
    expect(html).toContain('Add a new contact');
    expect(html).toContain('Add contact');
  });
});

describe("the contact panel's deals", () => {
  it('offers "Thêm cơ hội" to a person who can edit and nothing to a viewer', () => {
    const editor = render(<ContactDeals contact={CONTACT} canEdit />);
    expect(editor).toContain('aria-label="Thêm cơ hội cho Công ty ABC"');
    const viewer = render(<ContactDeals contact={CONTACT} canEdit={false} />);
    expect(viewer).not.toContain('Thêm cơ hội');
    expect(viewer).toContain('Mở màn Cơ hội');
  });
});

describe("the deals in the Inbox's contact panel (#3648)", () => {
  const deal = (id: string, title: string, stageKind: 'open' | 'won' | 'lost') => ({
    id,
    partyId: PARTY.id,
    partyName: PARTY.name,
    title,
    amount: '15000000.00',
    currency: 'VND',
    stageId: '00000000-0000-4000-8000-0000000000a0',
    stageKind,
    expectedClose: null,
    ownerUserId: null,
    lostReason: null,
    closedAt: null,
    version: 1,
    canDelete: true,
    followUp: null,
    partyDuplicateOf: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  function renderWith(node: React.ReactNode): string {
    const qc = new QueryClient();
    qc.setQueryData(['crm', 'deals', 'byParty'], [deal('00000000-0000-4000-8000-000000000001', 'Gói kế toán năm', 'open'), deal('00000000-0000-4000-8000-000000000002', 'Gói cũ đã thắng', 'won')]);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')}>
          {node}
        </IntlProvider>
      </QueryClientProvider>,
    );
  }

  it('lists the open deals with title, stage and amount, each title opening the deal, and "Thêm cơ hội"', () => {
    const html = renderWith(<ContactDeals contact={CONTACT} canEdit openOnly />);
    expect(html).toContain('Cơ hội đang mở');
    expect(html).toContain('>Gói kế toán năm</button>');
    expect(html).not.toContain('Gói cũ đã thắng');
    expect(html).toMatch(/15[.,]000[.,]000/);
    expect(html).toContain('aria-label="Thêm cơ hội cho Công ty ABC"');
  });

  it("lists every deal on the contact's own screen", () => {
    const html = renderWith(<ContactDeals contact={CONTACT} canEdit />);
    expect(html).toContain('>Gói kế toán năm</button>');
    expect(html).toContain('>Gói cũ đã thắng</button>');
  });
});
