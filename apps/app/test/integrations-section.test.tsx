// SPDX-License-Identifier: AGPL-3.0-only
// The "Tích hợp" (Integrations) section of Settings: one heading and a lead over the bank feed card and the e-invoice card, shown only while one of them has something
// to show (a deployment that offers a bank feed or a provider, or an org that has an e-invoice connection). Rendered on the server with the API's answers seeded.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EInvoiceConnection, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const config = vi.hoisted(() => ({ current: { modules: ['finance'], bankFeeds: { sandbox: false } } as { modules: string[]; bankFeeds?: { sandbox: boolean } } }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
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
vi.mock('../src/lib/auth.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/auth.ts')>()), getConfig: () => config.current }));

const { IntegrationsSection } = await import('../src/routes/integrations.tsx');

const at = '2026-11-03T00:00:00.000Z';
const entity: LegalEntity = { id: 'e1', name: 'Công ty TNHH Mẫu', kind: 'company', taxCode: '0100109100', parentId: null, isDefault: true, createdAt: at, updatedAt: at };
const connection: EInvoiceConnection = {
  id: 'k1',
  connectionId: 'c1',
  legalEntityId: 'e1',
  provider: 'sandbox',
  sellerTaxCode: '0100109100',
  displayName: 'Nhà cung cấp hóa đơn thử nghiệm',
  status: 'active',
  lastTestState: null,
  lastTestedAt: null,
};

function section(seed: { bank: boolean; providers: boolean; connections?: EInvoiceConnection[] }): string {
  config.current = { modules: ['finance'], bankFeeds: { sandbox: seed.bank } };
  const qc = client.current;
  qc.setQueryData(['einvoice', 'providers'], seed.providers ? [{ id: 'sandbox', offline: true, connectFields: [] }] : []);
  qc.setQueryData(['einvoice', 'connections', 'list'], seed.connections ?? []);
  qc.setQueryData(['einvoice', 'series', 'list'], []);
  qc.setQueryData(['legalEntities', 'list'], [entity]);
  qc.setQueryData(['bankFeeds', 'accounts'], []);
  qc.setQueryData(['bankFeeds', 'connections'], []);
  qc.setQueryData(['bankFeeds', 'listed'], []);
  qc.setQueryData(['accounts', 'list'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <IntegrationsSection role="owner" orgSlug="mau" />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('IntegrationsSection', () => {
  beforeEach(() => client.current.clear());

  it('puts the bank feed and the e-invoice provider under one heading with one lead', () => {
    const html = section({ bank: true, providers: true });
    expect(html.match(new RegExp(`>${en.integrations.title}<`, 'g'))).toHaveLength(1);
    expect(html).toContain('<h2');
    // The lead names the product by its brand, and the apostrophe is escaped in the markup.
    expect(html).toContain('Connect');
    expect(html).toContain('company&#x27;s bank and invoice provider.');
    expect(html).toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(html).toContain(`aria-label="${en.einvoiceConnections.title}"`);
  });

  it('draws the section for one card alone, and not at all when there is nothing to connect', () => {
    const bankOnly = section({ bank: true, providers: false });
    expect(bankOnly).toContain(`>${en.integrations.title}<`);
    expect(bankOnly).toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(bankOnly).not.toContain(`aria-label="${en.einvoiceConnections.title}"`);
    const invoiceOnly = section({ bank: false, providers: true });
    expect(invoiceOnly).toContain(`>${en.integrations.title}<`);
    expect(invoiceOnly).toContain(`aria-label="${en.einvoiceConnections.title}"`);
    expect(invoiceOnly).not.toContain(`aria-label="${en.bankFeeds.title}"`);
    expect(section({ bank: false, providers: false })).toBe('');
  });

  it('keeps showing an org\'s e-invoice connection when the deployment no longer offers a provider', () => {
    const html = section({ bank: false, providers: false, connections: [connection] });
    expect(html).toContain(`>${en.integrations.title}<`);
    expect(html).toContain('Nhà cung cấp hóa đơn thử nghiệm');
  });
});
