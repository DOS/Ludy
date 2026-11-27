// SPDX-License-Identifier: AGPL-3.0-only
// The "Tích hợp" (Integrations) section of Settings: one heading and a lead over the bank feed card and the e-invoice card, shown only while one of them has something
// to show (a deployment that offers a bank feed or a provider, or an org that has an e-invoice connection). Rendered on the server with the API's answers seeded.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EInvoiceConnection, EInvoiceProviderInfo, LegalEntity } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const config = vi.hoisted(() => ({ current: { modules: ['finance'], bankFeeds: { sandbox: false } } as { modules: string[]; bankFeeds?: { sandbox: boolean; tingee?: boolean } } }));

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

function section(seed: {
  bank: boolean;
  tingee?: boolean;
  providers: boolean;
  einvoiceProviders?: EInvoiceProviderInfo[];
  connections?: EInvoiceConnection[];
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}): string {
  config.current = { modules: ['finance'], bankFeeds: { sandbox: seed.bank, ...(seed.tingee ? { tingee: true } : {}) } };
  const qc = client.current;
  qc.setQueryData(['einvoice', 'providers'], seed.einvoiceProviders ?? (seed.providers ? [{ id: 'sandbox', offline: true, connectFields: [] }] : []));
  qc.setQueryData(['einvoice', 'connections', 'list'], seed.connections ?? []);
  qc.setQueryData(['einvoice', 'series', 'list'], []);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity]);
  qc.setQueryData(['bankFeeds', 'accounts'], []);
  qc.setQueryData(['bankFeeds', 'connections'], []);
  qc.setQueryData(['bankFeeds', 'listed'], []);
  qc.setQueryData(['accounts', 'list'], []);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
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

  it('draws the marketplace card under the same heading when an adapter is on or the org has a connection, and not otherwise', () => {
    const qc = client.current;
    const withMarketplace = (providers: unknown, connections: unknown[]) => {
      qc.setQueryData(['marketplace', 'providers'], providers);
      qc.setQueryData(['marketplace', 'connections', 'list'], connections);
      return section({ bank: false, providers: false });
    };
    const platforms = [{ platform: 'shopee', adapter: true, adapters: ['sandbox'] }];
    const on = withMarketplace({ adapters: [{ id: 'sandbox', offline: true, push: false, connectFields: [], platforms: ['shopee'] }], platforms }, []);
    expect(on).toContain(`>${en.integrations.title}<`);
    expect(on).toContain(`>${en.marketplaceConnections.title}<`);
    expect(on).toContain('role="group"');
    const off = withMarketplace({ adapters: [], platforms: [{ platform: 'shopee', adapter: false, adapters: [] }] }, []);
    expect(off).toBe('');
  });

  it('draws the MISA card where the deployment holds only the ASP ClientID (#4111), and not where it holds neither', () => {
    const qc = client.current;
    const withMisa = (status: { offered: boolean; pushOffered: boolean; aspOffered: boolean; aspPushOffered?: boolean }) => {
      qc.setQueryData(['misaAmis', 'status'], status);
      qc.setQueryData(['misaAmis', 'connections', 'list'], []);
      return section({ bank: false, providers: false });
    };
    const aspOnly = withMisa({ offered: false, pushOffered: false, aspOffered: true });
    expect(aspOnly).toContain(`>${en.integrations.title}<`);
    expect(aspOnly).toContain(`aria-label="${en.misaAmisConnections.connectTitleAsp}"`);
    expect(withMisa({ offered: false, pushOffered: false, aspOffered: false })).toBe('');
  });

  it('keeps showing an org\'s e-invoice connection when the deployment no longer offers a provider', () => {
    const html = section({ bank: false, providers: false, connections: [connection] });
    expect(html).toContain(`>${en.integrations.title}<`);
    expect(html).toContain('Nhà cung cấp hóa đơn thử nghiệm');
  });

  it('wires every control on every Settings Integrations connect form to a visible <label for="..."> (#4221)', () => {
    const qc = client.current;
    const entities: LegalEntity[] = [
      { ...entity, taxCode: null },
      { id: 'e2', name: 'Chi nhánh Hà Nội', kind: 'branch', taxCode: '0100109101', parentId: 'e1', isDefault: false, createdAt: at, updatedAt: at },
    ];
    qc.setQueryData(['marketplace', 'providers'], {
      adapters: [
        { id: 'lazada', offline: false, push: false, connectFields: ['appKey', 'appSecret'], platforms: ['lazada'] },
        { id: 'sandbox', offline: true, push: false, connectFields: [], platforms: ['shopee'] },
      ],
      platforms: [
        { platform: 'lazada', adapter: true, adapters: ['lazada'] },
        { platform: 'shopee', adapter: true, adapters: ['sandbox'] },
      ],
    });
    qc.setQueryData(['marketplace', 'connections', 'list'], []);
    qc.setQueryData(['misaAmis', 'status'], { offered: true, pushOffered: false, aspOffered: true });
    qc.setQueryData(['misaAmis', 'connections', 'list'], []);

    for (const locale of ['en', 'vi'] as const) {
      const html = section({
        bank: true,
        tingee: true,
        providers: true,
        einvoiceProviders: [
          { id: 'misa', offline: false, connectFields: ['user', 'password'] },
          { id: 'sandbox', offline: true, connectFields: [] },
        ],
        entities,
        locale,
      });
      const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
      expect(forms).toHaveLength(5);

      const seenLabels = new Map<string, string>();
      for (const m of html.matchAll(/<label\b([^>]*)>([^<]+)<\/label>/g)) {
        const attrs = m[1] ?? '';
        const text = (m[2] ?? '').trim();
        const forId = /\bfor="([^"]+)"/.exec(attrs)?.[1];
        expect(forId, `label "${text}" missing for`).toBeTruthy();
        expect(attrs).not.toContain('sr-only');
        seenLabels.set(forId!, text);
      }

      let controlCount = 0;
      for (const form of forms) {
        for (const tagMatch of form.matchAll(/<(input|select)\b[^>]*>/g)) {
          const tag = tagMatch[0];
          controlCount += 1;
          const id = /\bid="([^"]+)"/.exec(tag)?.[1];
          expect(id, `connect control missing id: ${tag}`).toBeTruthy();
          expect(seenLabels.get(id!), `connect control missing visible <label for="${id}">: ${tag}`).toBeTruthy();
          expect(tag).not.toContain('aria-label=');
          expect(tag).toContain('min-h-11');
        }
      }
      expect(controlCount).toBe(17);

      const labels = locale === 'en' ? en : viMessages;
      expect(html).toContain(`>${labels.bankFeeds.tingee.clientIdLabel}</label>`);
      expect(html).toContain(`>${labels.bankFeeds.tingee.secretLabel}</label>`);
      expect(html).toContain(`>${labels.bankFeeds.tingee.nameLabel}</label>`);
      expect(html).toContain(`>${labels.bankFeeds.nameLabel}</label>`);
      expect(html).toContain(`>${labels.einvoiceConnections.taxCode}</label>`);
      expect(html).toContain(`>${labels.marketplaceConnections.platform}</label>`);
    }
  });
});
