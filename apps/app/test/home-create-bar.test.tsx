// SPDX-License-Identifier: AGPL-3.0-only
// The Home create row on a phone and the shared PhoneActionBar's labelling (#4784).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { activeLocale, catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { buildQuickCreateItems, homeCreateItems, type QuickCreateItem } from '../src/lib/quick-create.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: { invalidateQueries: () => Promise.resolve() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  fetchFile: vi.fn(),
  getCurrentOrg: () => 'acme',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      search,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
      [k: string]: unknown;
    }) => {
      let href = to;
      for (const [k, v] of Object.entries(params ?? {})) href = href.replace('$' + k, v);
      if (search) href += '?' + new URLSearchParams(search).toString();
      return createElement('a', { href, ...rest }, children);
    },
  };
});

const { HomeCreateBar } = await import('../src/components/home-create-bar.tsx');
const { PhoneActionBar } = await import('../src/components/ui.tsx');

function render(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  const prev = activeLocale();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale) as never}>
        {node}
      </IntlProvider>,
    );
  } finally {
    setActiveLocale(prev);
  }
}

const items = (modules: string[], role: 'owner' | 'member' | 'viewer' | 'unknown' = 'owner'): QuickCreateItem[] =>
  buildQuickCreateItems({
    modules,
    role: role === 'unknown' ? undefined : role,
    canCreateTeamTask: role !== 'unknown' && role !== 'viewer',
    canQuickCapture: true,
  });
const ids = (list: readonly QuickCreateItem[]) => list.map((i) => i.id);

describe('homeCreateItems', () => {
  it('picks the four weekly jobs in order when finance and crm are on', () => {
    expect(ids(homeCreateItems(items(['finance', 'crm', 'notes', 'sign'])))).toEqual([
      'uploadDocument',
      'recordExpense',
      'createSalesInvoice',
      'newContact',
    ]);
  });

  it('shows only what the apps that are on offer, and never the quick-capture action', () => {
    expect(ids(homeCreateItems(items(['notes'])))).toEqual(['newTeamTask', 'newNote']);
    expect(ids(homeCreateItems(items(['crm'])))).toEqual(['newContact', 'newTeamTask', 'newDeal']);
  });

  it('shows nothing to a viewer or while the role is unknown', () => {
    expect(homeCreateItems(items(['finance', 'crm'], 'viewer'))).toEqual([]);
    expect(homeCreateItems(items(['finance', 'crm'], 'unknown'))).toEqual([]);
  });

  it('never exceeds the asked maximum', () => {
    expect(homeCreateItems(items(['finance', 'crm']), 2)).toHaveLength(2);
  });
});

describe('HomeCreateBar', () => {
  it('renders a labelled group of 44 px links to the create screens, phone only', () => {
    const html = render(<HomeCreateBar slug="acme" items={items(['finance', 'crm'])} />);
    expect(html).toContain('data-testid="home-create-bar"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Việc hay làm"');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('href="/o/acme/inbox"');
    expect(html).toContain('href="/o/acme/vouchers?type=cash_payment"');
    expect(html).toContain('href="/o/acme/sales-invoices"');
    expect(html).toContain('href="/o/acme/contacts"');
    const q = viMessages.nav.quickCreate;
    for (const label of [q.uploadDocument, q.recordExpense, q.createSalesInvoice, q.newContact]) {
      expect(html).toContain('<span>' + label + '</span>');
    }
    // Every job is a real anchor, so it opens in a new tab and is announced as a link.
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).toContain('min-h-11');
  });

  it('an odd last link takes the whole row', () => {
    expect(render(<HomeCreateBar slug="acme" items={items(['notes'])} />).match(/<a /g)).toHaveLength(2);
    // A member with finance only: the three finance jobs, then the team task the role may create, so four; a member of a
    // finance-only org that cannot create tasks gets three.
    const three = render(<HomeCreateBar slug="acme" items={buildQuickCreateItems({ modules: ['finance'], role: 'member', canCreateTeamTask: false, canQuickCapture: false })} />);
    expect(three.match(/<a /g)).toHaveLength(3);
    expect(three.match(/col-span-2/g)).toHaveLength(1);
  });

  it('leaves room under the last of Home so the bar does not hide it', () => {
    expect(render(<HomeCreateBar slug="acme" items={items(['finance'])} />)).toContain('aria-hidden="true" class="h-36 sm:hidden"');
  });

  it('renders nothing for a viewer or an org with no app that creates', () => {
    expect(render(<HomeCreateBar slug="acme" items={items(['finance'], 'viewer')} />)).toBe('');
    expect(render(<HomeCreateBar slug="acme" items={[]} />)).toBe('');
  });

  it('is named in English too', () => {
    const html = render(<HomeCreateBar slug="acme" items={items(['finance'])} />, 'en');
    expect(html).toContain('aria-label="' + enMessages.nav.quickCreate.homeRow + '"');
    expect(html).toContain('<span>' + enMessages.nav.quickCreate.uploadDocument + '</span>');
  });
});

describe('PhoneActionBar labelling', () => {
  it('is a group with a default name a screen reader announces, and keeps the safe-area inset and the phone-only class', () => {
    const html = render(
      <PhoneActionBar>
        <button type="button">Duyệt</button>
      </PhoneActionBar>,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="' + viMessages.common.phoneActions + '"');
    expect(html).toContain('data-testid="phone-action-bar"');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('[&amp;_button]:max-md:min-h-11');
  });

  it("takes the caller's own label over the default", () => {
    const html = render(
      <PhoneActionBar aria-label="Quyết định">
        <button type="button">Duyệt</button>
      </PhoneActionBar>,
    );
    expect(html).toContain('aria-label="Quyết định"');
    expect(html).not.toContain(viMessages.common.phoneActions);
  });
});
