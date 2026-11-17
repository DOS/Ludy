// SPDX-License-Identifier: AGPL-3.0-only
// The draft form's warning of a late sale (#3535): the sale is older than the next working day of the invoice, so the form names the fine, asks for the reason and marks the field
// when it is missing.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { LateSaleNotice } = await import('../src/routes/sales-invoices.tsx');

const render = (reason: string, error: string | null, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <LateSaleNotice id="sales-invoice" reason={reason} error={error} onChange={() => undefined} />
    </IntlProvider>,
  );

describe('the late sale notice of the draft form', () => {
  it('says the invoice is late, names the heavy fine and the period of the sale, and asks for the reason', () => {
    const html = render('', 'Hóa đơn lập muộn: hãy ghi lý do trước khi phát hành.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('lập muộn');
    expect(html).toContain('mức phạt khá nặng');
    expect(html).toContain('Lý do lập muộn');
    // The error sits under the field and is linked to it, by an id of its own.
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="sales-invoice-late-reason-error"');
    expect(html).toContain('id="sales-invoice-late-reason-error"');
    expect(html).toContain('hãy ghi lý do trước khi phát hành');
  });

  it('holds the reason typed and is not marked invalid once there is one', () => {
    const html = render('Quên lập hóa đơn', null);
    expect(html).toContain('Quên lập hóa đơn');
    expect(html).not.toContain('aria-invalid="');
    expect(html).not.toContain('aria-describedby="');
    expect(html).not.toContain('late-reason-error');
  });

  it('is in English too', () => {
    expect(render('', null, 'en')).toContain('the fine is heavy');
  });
});
