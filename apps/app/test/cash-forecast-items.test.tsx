// SPDX-License-Identifier: AGPL-3.0-only
// The owner-entered items of the cash forecast (#5326) on the card, rendered on the server with the API's answers seeded in the cache: everyone who reads the forecast sees the list, only an owner or an admin
// gets the add, edit and remove buttons (each with a name a screen reader can tell apart and a 44 px target), an empty list says so, the entries are checked the way the server checks them, and the
// Vietnamese and English texts are in step.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { CashForecastItems as Items, CashForecastItemView } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => {
  // orpc.<a>.<b>.queryOptions() gives the path as its key; nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), errorMessage: (e: unknown) => String(e), queryClient: {} };
});

const { CashForecastItems, draftErrors } = await import('../src/components/cash-forecast-items.tsx');

const ENTITY = '0192f0aa-1111-7222-8333-944445555777';
const ITEM: CashForecastItemView = {
  id: '0192f0aa-2222-7222-8333-944445555777',
  legalEntityId: ENTITY,
  label: 'Tiền thuê văn phòng',
  category: 'rent',
  direction: 'out',
  amount: '15000000',
  firstDate: '2026-12-05',
  recurrence: 'monthly',
  endDate: null,
  nextDate: '2026-12-05',
};
const LIST = (items: CashForecastItemView[]): Items => ({ legalEntityId: ENTITY, asOf: '2026-12-01', items, limit: 100 });

function render(items: CashForecastItemView[] | null, role: string | null, locale: 'vi' | 'en' = 'en'): string {
  const qc = new QueryClient();
  if (items) qc.setQueryData(['financeCashForecast', 'items'], LIST(items));
  if (role) qc.setQueryData(['org', 'get'], { role });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <CashForecastItems legalEntityId={ENTITY} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('CashForecastItems', () => {
  it('lists each item with its kind, repeat, next date and amount, to every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      const html = render([ITEM], role);
      expect(html).toContain(ITEM.label);
      expect(html).toContain('Rent');
      expect(html).toContain('Monthly');
      expect(html).toContain('next ');
      expect(html).toMatch(/Out .*15,000,000/);
    }
  });

  it('says so when there is none, and says an item with no occurrence in the 90 days has none', () => {
    const empty = render([], 'owner');
    expect(empty).toContain('data-testid="cash-forecast-items-empty"');
    expect(empty).toContain(en.financeCashForecast.items.empty);
    expect(render([{ ...ITEM, nextDate: null, endDate: '2026-11-30' }], 'owner')).toContain('none in the next 90 days');
    // While the list is still loading, no empty state is drawn.
    expect(render(null, 'owner')).not.toContain('cash-forecast-items-empty');
  });

  it('gives add, edit and remove to an owner or an admin only, each named for its item, and a read-only line to the others', () => {
    for (const role of ['owner', 'admin']) {
      const html = render([ITEM], role);
      expect(html).toContain('data-testid="cash-forecast-item-add"');
      expect(html).toContain(`aria-label="Edit ${ITEM.label}"`);
      expect(html).toContain(`aria-label="Remove ${ITEM.label}"`);
      expect(html).not.toContain(en.financeCashForecast.items.readOnly);
      // 44 px targets on the phone.
      expect(html.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(3);
    }
    for (const role of ['member', 'viewer']) {
      const html = render([ITEM], role);
      expect(html).not.toContain('cash-forecast-item-add');
      expect(html).not.toContain('aria-label="Edit');
      expect(html).not.toContain('aria-label="Remove');
      expect(html).toContain(en.financeCashForecast.items.readOnly);
    }
  });

  it('writes the Vietnamese list', () => {
    const html = render([{ ...ITEM, endDate: '2027-06-30' }], 'owner', 'vi');
    expect(html).toContain(viMessages.financeCashForecast.items.title);
    expect(html).toContain('Tiền thuê');
    expect(html).toContain('Hàng tháng');
    expect(html).toContain('đến ');
    expect(html).toContain('Thêm khoản dự kiến');
  });

  it('keeps the Vietnamese and English texts in step', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(viMessages.financeCashForecast.items).sort()).toEqual(keys(en.financeCashForecast.items).sort());
  });
});

describe('draftErrors', () => {
  const ok = { label: 'Rent', category: 'rent', direction: 'out', amount: '1000000', firstDate: '2026-12-05', recurrence: 'monthly', endDate: '' } as const;
  it('accepts a whole entry and an entry with an end date on or after the first date', () => {
    expect(draftErrors(ok)).toEqual({});
    expect(draftErrors({ ...ok, endDate: '2026-12-05' })).toEqual({});
  });
  it('refuses a missing or too long name, and one with a control character', () => {
    expect(draftErrors({ ...ok, label: '   ' })).toEqual({ label: true });
    expect(draftErrors({ ...ok, label: 'x'.repeat(81) })).toEqual({ label: true });
    expect(draftErrors({ ...ok, label: 'a\u0007b' })).toEqual({ label: true });
    expect(draftErrors({ ...ok, label: 'x'.repeat(80) })).toEqual({});
  });
  it('refuses an amount that is not whole dong above zero, with dots, signs or more than 15 digits', () => {
    for (const amount of ['', '0', '-5', '1.5', '1,000', '1 000', '1234567890123456']) expect(draftErrors({ ...ok, amount })).toEqual({ amount: true });
    expect(draftErrors({ ...ok, amount: '999999999999999' })).toEqual({});
  });
  it('refuses a missing or out-of-range first date, and an end date before it (a one-off ignores the end date)', () => {
    expect(draftErrors({ ...ok, firstDate: '' })).toEqual({ firstDate: true });
    expect(draftErrors({ ...ok, firstDate: '1999-12-31' })).toEqual({ firstDate: true });
    expect(draftErrors({ ...ok, firstDate: '2101-01-01' })).toEqual({ firstDate: true });
    expect(draftErrors({ ...ok, endDate: '2026-12-04' })).toEqual({ endDate: true });
    expect(draftErrors({ ...ok, recurrence: 'once', endDate: '2026-12-04' })).toEqual({});
  });
});
