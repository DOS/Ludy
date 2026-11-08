// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace connection card in Settings (#2519), rendered on the server with the API's answers seeded in the cache: what an owner or admin can do, what a member or viewer
// sees, the platforms no adapter serves greyed with the words "bring the report file" and no connect button, the state of the last test and of the last pull in words, and no card at
// all where nothing is offered. Plus the small pure helpers the card uses.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalEntity, MarketplaceConnection, MarketplaceProviders } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { adapterIdOf, canPollNow, connectablePlatforms, fieldIsSecret, marketplaceCardShown } from '../src/lib/marketplace-connections.ts';

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

const { MarketplaceConnectionsCard } = await import('../src/routes/marketplace-connections.tsx');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
// The markup escapes an apostrophe.
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
const at = '2026-11-03T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean): LegalEntity => ({ id, name, kind: 'company', taxCode: '0100109100', parentId: null, isDefault, createdAt: at, updatedAt: at });
const offered: MarketplaceProviders = {
  adapters: [{ id: 'sandbox', offline: true, connectFields: [], platforms: ['lazada', 'shopee', 'tiktok_shop'] }],
  platforms: [
    { platform: 'shopee', adapter: true, adapters: ['sandbox'] },
    { platform: 'tiktok_shop', adapter: true, adapters: ['sandbox'] },
    { platform: 'lazada', adapter: true, adapters: ['sandbox'] },
  ],
};
// A deployment with no adapter: every platform stays on the report file.
const none: MarketplaceProviders = { adapters: [], platforms: offered.platforms.map((p) => ({ platform: p.platform, adapter: false, adapters: [] })) };
// One platform with an adapter and two without.
const partial: MarketplaceProviders = {
  adapters: [{ id: 'sandbox', offline: true, connectFields: [], platforms: ['shopee'] }],
  platforms: [
    { platform: 'shopee', adapter: true, adapters: ['sandbox'] },
    { platform: 'tiktok_shop', adapter: false, adapters: [] },
    { platform: 'lazada', adapter: false, adapters: [] },
  ],
};
const connection = (over: Partial<MarketplaceConnection> = {}): MarketplaceConnection => ({
  id: 'k1',
  connectionId: 'c1',
  legalEntityId: 'e1',
  provider: 'marketplace_sandbox',
  platform: 'shopee',
  displayName: 'Sàn thử nghiệm (shopee)',
  status: 'active',
  lastTestState: null,
  lastTestedAt: null,
  lastPolledAt: null,
  lastPollState: null,
  ordersWaiting: 0,
  ...over,
});

interface Seed {
  providers?: MarketplaceProviders;
  connections?: MarketplaceConnection[];
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}
function card(role: Role, seed: Seed = {}): string {
  const qc = client.current;
  qc.setQueryData(['marketplace', 'providers'], seed.providers ?? offered);
  qc.setQueryData(['marketplace', 'connections', 'list'], seed.connections ?? [connection()]);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity('e1', 'Công ty TNHH Mẫu', true)]);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MarketplaceConnectionsCard role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MarketplaceConnectionsCard', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['owner', 'admin'])('as %s: lists the connection with its status, the buttons to test, pull now and disconnect, and the connect form', (role) => {
    const html = card(role);
    // The card is a labelled group (a bare aria-label on a div is not announced), named by its visible title.
    expect(html).toMatch(/role="group"[^>]*aria-labelledby="([^"]+)"/);
    const labelId = /role="group"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(html).toMatch(new RegExp(`id="${labelId.replace(/[:]/g, '\\$&')}"[^>]*>${en.marketplaceConnections.title}<`));
    expect(html).toContain('Sàn thử nghiệm (shopee)');
    expect(html).toContain(`>${en.marketplaceConnections.status.active}<`);
    expect(html).toContain(en.marketplaceConnections.neverTested);
    expect(html).toContain(en.marketplaceConnections.neverPolled);
    expect(html).toContain(`>${en.marketplaceConnections.test}<`);
    expect(html).toContain(`>${en.marketplaceConnections.pollNow}<`);
    expect(html).toContain(`>${en.marketplaceConnections.disconnect}<`);
    expect(html).toContain(`aria-label="${en.marketplaceConnections.connectTitle}"`);
    expect(html).toContain(esc(en.marketplaceConnections.offlineNote));
    // One adapter and one entity: nothing to choose but the marketplace.
    expect(html).not.toContain(`aria-label="${en.marketplaceConnections.adapter}"`);
    expect(html).not.toContain(`aria-label="${en.marketplaceConnections.entity}"`);
    expect(html).toContain(`aria-label="${en.marketplaceConnections.platform}"`);
    // The card says a pull only stages orders for a person to confirm.
    expect(html).toContain(esc(en.marketplaceConnections.intro));
  });

  it.each<Role>(['member', 'viewer'])('as %s: reads the connection, its test and its last pull, with no button and no form', (role) => {
    const html = card(role, { connections: [connection({ lastTestState: 'works', lastTestedAt: at, lastPolledAt: at, lastPollState: 'ok', ordersWaiting: 3 })] });
    expect(html).toContain(en.marketplaceConnections.testStates.works);
    expect(html).toContain(en.marketplaceConnections.pollStates.ok);
    expect(html).toContain('3 orders');
    expect(html).toContain('waiting in the Inbox');
    expect(html).not.toContain(`>${en.marketplaceConnections.test}<`);
    expect(html).not.toContain(`>${en.marketplaceConnections.pollNow}<`);
    expect(html).not.toContain(`>${en.marketplaceConnections.disconnect}<`);
    expect(html).not.toContain(`aria-label="${en.marketplaceConnections.connectTitle}"`);
  });

  it('greys a platform no adapter serves with the words "bring the report file", and offers no connect for it', () => {
    const html = card('owner', { providers: partial, connections: [] });
    const rows = html.match(/<li[^>]*data-testid="marketplace-platform"[^>]*>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.includes('data-adapter="false"'))).toHaveLength(2);
    expect(html.match(new RegExp(esc(en.marketplaceConnections.fileOnly), 'g'))).toHaveLength(2);
    expect(html).toContain(`>${en.marketplaceConnections.adapterOn}<`);
    // The connect form offers only the platform an adapter serves.
    const form = html.slice(html.indexOf(`aria-label="${en.marketplaceConnections.connectTitle}"`));
    expect(form).toContain('>Shopee<');
    expect(form).not.toContain('>TikTok Shop<');
    expect(form).not.toContain('>Lazada<');
    // In Vietnamese the words are the ones the screen promises.
    expect(card('owner', { providers: partial, connections: [], locale: 'vi' })).toContain('nhập file báo cáo');
  });

  it('draws no card when no adapter is on and nothing is connected, and keeps showing what the org has when the adapter was turned off', () => {
    expect(card('owner', { providers: none, connections: [] })).toBe('');
    const viewer = card('viewer', { providers: none, connections: [connection()] });
    expect(viewer).toContain('Sàn thử nghiệm (shopee)');
    expect(viewer.match(new RegExp(esc(en.marketplaceConnections.fileOnly), 'g'))).toHaveLength(3);
    // No adapter: no connect form for an owner either, and no pull button (the adapter is not offered).
    const owner = card('owner', { providers: none, connections: [connection()] });
    expect(owner).not.toContain(`aria-label="${en.marketplaceConnections.connectTitle}"`);
    expect(owner).not.toContain(`>${en.marketplaceConnections.pollNow}<`);
    expect(card('member', { providers: offered, connections: [] })).toContain(en.marketplaceConnections.noConnections);
  });

  it('says what the last test and the last pull found, in words and never in the platform\'s own text', () => {
    for (const state of ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable'] as const) {
      expect(card('owner', { connections: [connection({ lastTestState: state, lastTestedAt: at })] })).toContain(esc(en.marketplaceConnections.testStates[state]));
    }
    for (const state of ['ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'] as const) {
      expect(card('owner', { connections: [connection({ lastPolledAt: at, lastPollState: state })] })).toContain(esc(en.marketplaceConnections.pollStates[state]));
    }
    expect(card('owner', { connections: [connection({ status: 'expired' })] })).toContain(en.marketplaceConnections.status.expired);
    // A connection that is no longer active has no test and no pull to run.
    const dead = card('owner', { connections: [connection({ status: 'error' })] });
    expect(dead).not.toContain(`>${en.marketplaceConnections.test}<`);
    expect(dead).not.toContain(`>${en.marketplaceConnections.pollNow}<`);
  });

  it('offers no pull button for an adapter that is not the offline one: the worker polls it', () => {
    const real: MarketplaceProviders = { ...offered, adapters: [{ id: 'sandbox', offline: false, connectFields: ['user', 'password'], platforms: ['shopee'] }] };
    expect(card('owner', { providers: real })).not.toContain(`>${en.marketplaceConnections.pollNow}<`);
  });

  it('asks for the entity when the org has several, and shows a password field for an adapter that names its fields', () => {
    const several = card('owner', { entities: [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false)] });
    expect(several).toContain(`aria-label="${en.marketplaceConnections.entity}"`);
    expect(several).toContain('Chi nhánh Hà Nội');
    const real = card('owner', { providers: { ...offered, adapters: [{ id: 'shopee_api', offline: false, connectFields: ['user', 'password'], platforms: ['shopee'] }] }, connections: [] });
    // The fields are named in words, not by the adapter's raw field name; a name with no words of its own is shown as it is.
    expect(real).toMatch(/type="password"[^>]*aria-label="Password"|aria-label="Password"[^>]*type="password"/);
    expect(real).toMatch(/type="text"[^>]*aria-label="Username"|aria-label="Username"[^>]*type="text"/);
    const odd = card('owner', { providers: { ...offered, adapters: [{ id: 'shopee_api', offline: false, connectFields: ['zzField'], platforms: ['shopee'] }] }, connections: [] });
    expect(odd).toContain('aria-label="zzField"');
    expect(real).toContain(en.marketplaceConnections.fieldsNote);
    expect(real).not.toContain(en.marketplaceConnections.offlineNote);
  });

  it('is in Vietnamese with the same keys', () => {
    const html = card('owner', { locale: 'vi', connections: [connection({ lastTestState: 'works', lastTestedAt: at })] });
    expect(html).toContain('Kết nối dùng được');
    expect(html).toContain('Lấy đơn ngay');
    expect(html).toContain('Kiểm tra kết nối');
  });
});

describe('the helpers of the card', () => {
  it('shows the card when an adapter is on or a connection exists', () => {
    expect(marketplaceCardShown(undefined, undefined)).toBe(false);
    expect(marketplaceCardShown([], [])).toBe(false);
    expect(marketplaceCardShown([{}], [])).toBe(true);
    expect(marketplaceCardShown([], [{}])).toBe(true);
  });
  it('reads the adapter of a connection and offers a pull only for a live connection of an offline adapter', () => {
    expect(adapterIdOf(connection())).toBe('sandbox');
    expect(canPollNow(connection(), offered.adapters)).toBe(true);
    expect(canPollNow(connection({ status: 'expired' }), offered.adapters)).toBe(false);
    expect(canPollNow(connection(), [])).toBe(false);
  });
  it('lists as connectable only the platforms an adapter serves', () => {
    expect(connectablePlatforms(partial.platforms).map((p) => p.platform)).toEqual(['shopee']);
  });
  it('hides what is typed unless the field is a plain identifier', () => {
    for (const name of ['user', 'username', 'appId', 'shopId']) expect(fieldIsSecret(name)).toBe(false);
    for (const name of ['password', 'secret', 'partnerKey', 'token']) expect(fieldIsSecret(name)).toBe(true);
  });
});

// The messages of the card exist in both languages with the same shape (the catalog test covers the rest).
describe('the card\'s messages', () => {
  it('have the same keys in English and Vietnamese', async () => {
    const { vi: vietnamese } = await import('../src/i18n/messages/vi.ts');
    const shape = (value: unknown): unknown => (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value);
    expect(shape(vietnamese.marketplaceConnections)).toEqual(shape(en.marketplaceConnections));
  });
});
