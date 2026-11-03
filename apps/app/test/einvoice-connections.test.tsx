// SPDX-License-Identifier: AGPL-3.0-only
// The e-invoice connection card in Settings (#2501), rendered on the server with the API's answers seeded in the cache: what an owner or admin can do, what a member or
// viewer sees, the state of the last test in words, the series read in words with the default marked, and no card at all where nothing is offered. Plus the small
// pure helpers the card uses.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EInvoiceConnection, EInvoiceProviderInfo, EInvoiceSeries, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { decodeSymbol, fieldIsSecret, seriesOf, templateWord } from '../src/lib/einvoice-connections.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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

const { EInvoiceConnectionsCard } = await import('../src/routes/einvoice-connections.tsx');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
// The markup escapes an apostrophe.
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
const at = '2026-11-03T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean, taxCode: string | null = '0100109100'): LegalEntity => ({ id, name, kind: 'company', taxCode, parentId: null, isDefault, createdAt: at, updatedAt: at });
const sandbox: EInvoiceProviderInfo = { id: 'sandbox', offline: true, connectFields: [] };
const connection = (over: Partial<EInvoiceConnection> = {}): EInvoiceConnection => ({
  id: 'k1',
  connectionId: 'c1',
  legalEntityId: 'e1',
  provider: 'sandbox',
  sellerTaxCode: '0100109100',
  displayName: 'Nhà cung cấp hóa đơn thử nghiệm',
  status: 'active',
  lastTestState: null,
  lastTestedAt: null,
  ...over,
});
const series = (id: string, templateNo: string, symbol: string, isDefault: boolean, legalEntityId = 'e1'): EInvoiceSeries => ({ id, legalEntityId, provider: 'sandbox', templateNo, symbol, description: '', isDefault });

interface Seed {
  providers?: EInvoiceProviderInfo[];
  connections?: EInvoiceConnection[];
  series?: EInvoiceSeries[];
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}
function card(role: Role, seed: Seed = {}): string {
  const qc = client.current;
  qc.setQueryData(['einvoice', 'providers'], seed.providers ?? [sandbox]);
  qc.setQueryData(['einvoice', 'connections', 'list'], seed.connections ?? [connection()]);
  qc.setQueryData(['einvoice', 'series', 'list'], seed.series ?? []);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity('e1', 'Công ty TNHH Mẫu', true)]);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <EInvoiceConnectionsCard role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('EInvoiceConnectionsCard', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['owner', 'admin'])('as %s: lists the connection with its status, the buttons to test and disconnect, and the connect form', (role) => {
    const html = card(role);
    expect(html).toContain(`aria-label="${en.einvoiceConnections.title}"`);
    expect(html).toContain('Nhà cung cấp hóa đơn thử nghiệm');
    expect(html).toContain(`>${en.einvoiceConnections.status.active}<`);
    expect(html).toContain(en.einvoiceConnections.neverTested);
    // The seller's tax code is shown from the connection's own row (it is in no channel name).
    expect(html).toContain('Seller tax code 0100109100');
    expect(html).toContain(`>${en.einvoiceConnections.test}<`);
    expect(html).toContain(`>${en.einvoiceConnections.disconnect}<`);
    expect(html).toContain(`aria-label="${en.einvoiceConnections.connectTitle}"`);
    expect(html).toContain(en.einvoiceConnections.offlineNote);
    // One provider and one entity with a tax code: nothing to choose, nothing to type.
    expect(html).not.toContain(`aria-label="${en.einvoiceConnections.provider}"`);
    expect(html).not.toContain(`aria-label="${en.einvoiceConnections.entity}"`);
    expect(html).not.toContain(`aria-label="${en.einvoiceConnections.taxCode}"`);
    // No series yet: the card says to make one at the provider's own page.
    expect(html).toContain(esc(en.einvoiceConnections.noSeries));
  });

  it.each<Role>(['member', 'viewer'])('as %s: reads the connection and its test, with no button and no form', (role) => {
    const html = card(role, { connections: [connection({ lastTestState: 'works', lastTestedAt: at })], series: [series('s1', '1', 'C26TSB', true)] });
    expect(html).toContain(en.einvoiceConnections.states.works);
    expect(html).toContain('C26TSB');
    expect(html).not.toContain(`>${en.einvoiceConnections.test}<`);
    expect(html).not.toContain(`>${en.einvoiceConnections.disconnect}<`);
    expect(html).not.toContain(`>${en.einvoiceConnections.makeDefault}<`);
    expect(html).not.toContain(`aria-label="${en.einvoiceConnections.connectTitle}"`);
  });

  it('says what the last test found, in words and never in the provider\'s own text', () => {
    for (const state of ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable', 'signing_needs_person'] as const) {
      const html = card('owner', { connections: [connection({ lastTestState: state, lastTestedAt: at })] });
      expect(html).toContain(esc(en.einvoiceConnections.states[state]));
    }
    expect(card('owner', { connections: [connection({ status: 'expired' })] })).toContain(en.einvoiceConnections.status.expired);
    // A connection that is no longer active has no test to run.
    expect(card('owner', { connections: [connection({ status: 'error' })] })).not.toContain(`>${en.einvoiceConnections.test}<`);
  });

  it('reads each series in words, marks the default, and offers the others as the default to an owner only', () => {
    const rows = [series('s1', '1', 'C26TSB', true), series('s2', '2', 'K26TAB', false), series('s3', '1', 'C26TXX', true, 'other')];
    const html = card('admin', { series: rows });
    expect(html).toContain('Template 1, symbol C26TSB');
    expect(html).toContain(en.einvoiceConnections.symbolCoded);
    expect(html).toContain('year 2026');
    expect(html).toContain('type T');
    expect(html).toContain(en.einvoiceConnections.symbolUncoded);
    expect(html).toContain(en.einvoiceConnections.tpl1);
    expect(html).toContain(en.einvoiceConnections.tpl2);
    expect(html.match(new RegExp(`>${en.einvoiceConnections.defaultSeries}<`, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`>${en.einvoiceConnections.makeDefault}<`, 'g'))).toHaveLength(1);
    // The series of another entity is not this connection's.
    expect(html).not.toContain('C26TXX');
  });

  it('asks for the entity when the org has several, and for the seller tax code when the chosen entity has none', () => {
    const several = card('owner', { entities: [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false, null)] });
    expect(several).toContain(`aria-label="${en.einvoiceConnections.entity}"`);
    expect(several).toContain('Chi nhánh Hà Nội');
    // The default entity (the one the form starts on) has a tax code.
    expect(several).not.toContain(`aria-label="${en.einvoiceConnections.taxCode}"`);
    const bare = card('owner', { entities: [entity('e1', 'Công ty TNHH Mẫu', true, null)] });
    expect(bare).toContain(`aria-label="${en.einvoiceConnections.taxCode}"`);
    expect(bare).toContain(esc(en.einvoiceConnections.taxCodeHint));
  });

  it('shows a password field for a provider that names its fields, with a word that they are sealed', () => {
    const html = card('owner', { providers: [{ id: 'misa', offline: false, connectFields: ['user', 'password'] }], connections: [] });
    expect(html).toContain('aria-label="user"');
    expect(html).toContain('aria-label="password"');
    expect(html).toMatch(/type="password"[^>]*aria-label="password"|aria-label="password"[^>]*type="password"/);
    expect(html).toMatch(/type="text"[^>]*aria-label="user"|aria-label="user"[^>]*type="text"/);
    expect(html).toContain(en.einvoiceConnections.fieldsNote);
    expect(html).not.toContain(en.einvoiceConnections.offlineNote);
  });

  it('draws no card when the deployment offers no provider and nothing is connected, and an empty one for a member', () => {
    expect(card('owner', { providers: [], connections: [] })).toBe('');
    // A viewer of an org with a connection still reads it even when the provider was turned off since.
    expect(card('viewer', { providers: [], connections: [connection()] })).toContain('Nhà cung cấp hóa đơn thử nghiệm');
    expect(card('member', { providers: [sandbox], connections: [] })).toContain(en.einvoiceConnections.noConnections);
  });

  it('is in Vietnamese with the same keys', () => {
    const html = card('owner', { locale: 'vi', connections: [connection({ lastTestState: 'works', lastTestedAt: at })] });
    expect(html).toContain('Kết nối dùng được');
    expect(html).toContain('Kiểm tra kết nối');
  });
});

describe('the helpers of the card', () => {
  it('reads a symbol in parts and leaves any other shape alone', () => {
    expect(decodeSymbol('C26TSB')).toEqual({ coded: true, year: '2026', typeLetter: 'T' });
    expect(decodeSymbol('K25MAA')).toEqual({ coded: false, year: '2025', typeLetter: 'M' });
    for (const bad of ['', 'C26TS', 'X26TSB', 'C2TSB1', 'c26tsb', 'C26TSBB']) expect(decodeSymbol(bad)).toBeNull();
  });
  it('names the template numbers the rules name and no other', () => {
    expect(['1', '2', '7'].map(templateWord)).toEqual(['tpl1', 'tpl2', 'tpl7']);
    expect(templateWord('3')).toBeNull();
    expect(templateWord('constructor')).toBeNull();
  });
  it('hides what is typed unless the field is a plain identifier', () => {
    for (const name of ['user', 'username', 'appId', 'clientId', 'taxCode', 'email']) expect(fieldIsSecret(name)).toBe(false);
    for (const name of ['password', 'secret', 'clientSecret', 'apiKey', 'token', 'pin']) expect(fieldIsSecret(name)).toBe(true);
  });
  it('takes the series of the connection\'s entity and provider', () => {
    const rows = [series('s1', '1', 'C26TSB', true), series('s2', '1', 'C26TXX', true, 'e2'), { ...series('s3', '1', 'C26TYY', false), provider: 'misa' }];
    expect(seriesOf(rows, { legalEntityId: 'e1', provider: 'sandbox' }).map((s) => s.id)).toEqual(['s1']);
  });
});

// The messages of the card exist in both languages with the same shape (the catalog test covers the rest).
describe('the card\'s messages', () => {
  it('have the same keys in English and Vietnamese', async () => {
    const { vi: vietnamese } = await import('../src/i18n/messages/vi.ts');
    const shape = (value: unknown): unknown => (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value);
    expect(shape(vietnamese.einvoiceConnections)).toEqual(shape(en.einvoiceConnections));
  });
});
