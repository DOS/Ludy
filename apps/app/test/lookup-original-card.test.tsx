// SPDX-License-Identifier: AGPL-3.0-only
// The "original invoice needed" card (#2268), rendered on the server: the provider, the code and a link only for a host of
// the provider table, whatever the stored hint says; the XML upload button; nothing for a proposal with no hint.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { LookupHint } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
// What the intake hook (the router and the upload, which this test has none of) answers.
const intake = vi.hoisted(() => ({ current: { items: [] as Array<{ state: string; uploadError?: unknown }>, uploading: false } }));

vi.mock('../src/components/intake.tsx', () => ({
  useIntake: () => ({ ...intake.current, start: () => undefined, clear: () => undefined, refused: null }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  class ClientError extends Error {}
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), uploadDocument: () => Promise.reject(new Error('never called')), ClientError };
});

const { LookupOriginalCard, openableLink } = await import('../src/components/lookup-original-card.tsx');

const SELLER = '9900000016';
const OTHER = '9900000024';

function card(hints: LookupHint[], sellerTaxCode: string | null = SELLER, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <LookupOriginalCard hints={hints} sellerTaxCode={sellerTaxCode} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the original invoice card', () => {
  it('shows the provider, the code and a safe link to the provider page, and the upload button', () => {
    const html = card([{ provider: 'misa', url: 'https://www.meinvoice.vn/tra-cuu/', code: '4F7K2M9QXA3' }]);
    expect(html).toContain('data-testid="lookup-original-card"');
    expect(html).toContain('MISA meInvoice');
    expect(html).toContain('4F7K2M9QXA3');
    expect(html).toMatch(/<a href="https:\/\/www\.meinvoice\.vn\/tra-cuu\/" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('(www.meinvoice.vn)');
    expect(html).toContain('Copy code');
    expect(html).toContain('Upload XML');
    expect(html).toContain('accept=".xml,application/xml,text/xml"');
  });

  it('words the card in Vietnamese', () => {
    const html = card([{ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: '4F7K2M9QXA3' }], SELLER, 'vi');
    expect(html).toContain('Cần hóa đơn gốc (XML)');
    expect(html).toContain('Mở trang tra cứu');
    expect(html).toContain('Tải XML lên');
  });

  it('shows no link for an address that is not on a provider host, only the text', () => {
    for (const url of ['https://evil.test/meinvoice.vn', 'https://meinvoice.vn.evil.test/', 'http://meinvoice.vn@evil.test/x']) {
      const html = card([{ provider: 'misa', url, code: '4F7K2M9QXA3' }]);
      expect(html, url).not.toContain('<a ');
      expect(html, url).toContain('data-testid="lookup-text"');
    }
  });

  it('opens a VNPT page only for the invoice seller', () => {
    const own = `https://${SELLER}.vnpt-invoice.com.vn/`;
    const other = `https://${OTHER}.vnpt-invoice.com.vn/`;
    expect(card([{ provider: 'vnpt', url: own, code: 'HD7X2K9Q4M' }])).toContain(`href="${own}"`);
    expect(card([{ provider: 'vnpt', url: other, code: 'HD7X2K9Q4M' }])).not.toContain('<a ');
    // Without a seller to compare with, the table's own pattern is the check.
    expect(card([{ provider: 'vnpt', url: other, code: 'HD7X2K9Q4M' }], null)).toContain(`href="${other}"`);
  });

  it('shows a code with no link, and a link with no code', () => {
    const codeOnly = card([{ provider: 'viettel', url: null, code: '1A2B3C4D5E' }]);
    expect(codeOnly).toContain('1A2B3C4D5E');
    expect(codeOnly).not.toContain('<a ');
    const linkOnly = card([{ provider: 'easyinvoice', url: 'https://tracuu.easyinvoice.vn/', code: null }]);
    expect(linkOnly).toContain('href="https://tracuu.easyinvoice.vn/"');
    expect(linkOnly).not.toContain('data-testid="lookup-code"');
    expect(card([{ provider: null, url: null, code: '7Q8W9E1R2T' }])).toContain('Invoice provider not recognized');
  });

  it('says the file was sent only when it is being read, and otherwise what happened to it', () => {
    const hints: LookupHint[] = [{ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: '4F7K2M9QXA3' }];
    const withItem = (item: { state: string; uploadError?: unknown; error?: string | null }) => {
      intake.current = { items: [item], uploading: false };
      return card(hints);
    };
    for (const state of ['processing', 'proposed']) expect(withItem({ state }), state).toContain('Sent. The XML file will be read');
    // The same file twice: nothing new is read, so the card must not promise a proposal.
    const duplicate = withItem({ state: 'duplicate' });
    expect(duplicate).toContain('already in the system');
    expect(duplicate).not.toContain('Sent.');
    // A file the server could not read: its own words.
    const failed = withItem({ state: 'failed', error: 'Not an e-invoice' });
    expect(failed).toContain('Not an e-invoice');
    expect(failed).not.toContain('Sent.');
    expect(withItem({ state: 'failed', error: null })).toContain('This file could not be read.');
    expect(withItem({ state: 'waiting' })).toContain('waits for the next day');
    const uploadFailed = withItem({ state: 'upload_failed', uploadError: 'Error: file too large' });
    expect(uploadFailed).toContain('file too large');
    expect(uploadFailed).not.toContain('Sent.');
    // Nothing yet, or still uploading: no claim at all.
    for (const state of ['queued', 'uploading']) {
      const html = withItem({ state });
      expect(html, state).not.toContain('Sent.');
      expect(html, state).not.toContain('role="status"');
    }
    intake.current = { items: [], uploading: false };
  });

  it('gives each copy button a name that says which provider it is for', () => {
    const html = card([
      { provider: 'misa', url: null, code: '4F7K2M9QXA3' },
      { provider: 'easyinvoice', url: null, code: 'EZ98YX76WV' },
    ]);
    expect(html).toContain('aria-label="Copy code (MISA meInvoice)"');
    expect(html).toContain('aria-label="Copy code (EasyInvoice)"');
  });

  it('says that the link opens in a new tab, for a screen reader', () => {
    expect(card([{ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: null }])).toContain('opens in a new tab');
  });

  it('shows nothing when the proposal has no hint', () => {
    expect(card([])).toBe('');
  });
});

describe('openableLink', () => {
  it('gives the https address and its host, or nothing', () => {
    expect(openableLink({ provider: 'misa', url: 'http://meinvoice.vn/tra-cuu', code: null }, null)).toEqual({ url: 'https://meinvoice.vn/tra-cuu', host: 'meinvoice.vn' });
    expect(openableLink({ provider: 'misa', url: null, code: 'ABC12345' }, null)).toBeNull();
    expect(openableLink({ provider: 'misa', url: 'https://evil.test/', code: null }, null)).toBeNull();
  });
});
