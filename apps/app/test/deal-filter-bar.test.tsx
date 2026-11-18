// SPDX-License-Identifier: AGPL-3.0-only
// The deal filter bar (#3647): search and the owner are always there; the rest sit behind "Bộ lọc khác" with the count of those in
// use, and the board hides the stage, the status and the sort (the columns say them) unless a view has set one.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { DealFilterBar } from '../src/components/deal-filter-bar.tsx';
import { EMPTY_DEAL_FILTER, type DealFilterState } from '../src/lib/deal-filter.ts';

function render(view: 'board' | 'list', bar: DealFilterState = EMPTY_DEAL_FILTER, locale: 'vi' | 'en' = 'vi', sort: { field: 'amount'; dir: 'desc' } | null = null): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <DealFilterBar bar={bar} setBar={() => undefined} sort={sort} setSort={() => undefined} stages={[]} members={[]} view={view} />
    </IntlProvider>,
  );
}

describe('DealFilterBar', () => {
  it('shows only the search, the owner and "Bộ lọc khác" until something is in use', () => {
    for (const view of ['board', 'list'] as const) {
      const html = render(view);
      expect(html).toContain('id="deal-search"');
      expect(html).toContain('id="deal-owner"');
      expect(html).toContain('>Bộ lọc khác<');
      expect(html).toContain('aria-expanded="false"');
      for (const id of ['deal-stage', 'deal-status', 'deal-close', 'deal-amountMin', 'deal-sort']) expect(html).not.toContain(`id="${id}"`);
    }
  });

  it('opens by itself with a count when a folded filter is in use, and shows the list its stage, status and sort', () => {
    const html = render('list', { ...EMPTY_DEAL_FILTER, status: 'won', amountMin: '1000000' }, 'vi', { field: 'amount', dir: 'desc' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="3 điều kiện đang dùng"');
    for (const id of ['deal-stage', 'deal-status', 'deal-close', 'deal-amountMin', 'deal-amountMax', 'deal-sort']) expect(html).toContain(`id="${id}"`);
  });

  it('on the board leaves out the stage, the status and the sort the columns already say, and keeps the close date and the amounts', () => {
    const html = render('board', { ...EMPTY_DEAL_FILTER, close: 'overdue' });
    expect(html).toContain('aria-label="1 điều kiện đang dùng"');
    expect(html).toContain('id="deal-close"');
    expect(html).toContain('id="deal-amountMin"');
    for (const id of ['deal-stage', 'deal-status', 'deal-sort']) expect(html).not.toContain(`id="${id}"`);
  });

  it('on the board still shows a status a saved view has set, so the person can see why cards are missing', () => {
    expect(render('board', { ...EMPTY_DEAL_FILTER, status: 'open' })).toContain('id="deal-status"');
  });

  it('says it in English', () => {
    const html = render('list', { ...EMPTY_DEAL_FILTER, status: 'lost' }, 'en');
    expect(html).toContain('>More filters<');
    expect(html).toContain('aria-label="1 in use"');
  });
});
