// SPDX-License-Identifier: AGPL-3.0-only
// Ads and Reports have icons of their own (NV-1, #3659): they no longer draw the banknote of the vouchers and the
// spreadsheet of the VAT return, which are Accounting items.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavIcon, type NavIconName } from '@ludy/ui/components/nav-icon';

const svg = (name: NavIconName) => renderToStaticMarkup(<NavIcon name={name} />);

describe('the Engage menu icons', () => {
  it('draws Ads and Reports differently from every Accounting icon they used to borrow', () => {
    for (const own of ['ads', 'reports'] as const) {
      for (const borrowed of ['vouchers', 'vat', 'payroll'] as const) expect(svg(own), `${own} vs ${borrowed}`).not.toBe(svg(borrowed));
    }
    expect(svg('ads')).not.toBe(svg('reports'));
  });

  it('keeps them decorative: hidden from screen readers', () => {
    for (const own of ['ads', 'reports'] as const) expect(svg(own)).toContain('aria-hidden="true"');
  });
});
