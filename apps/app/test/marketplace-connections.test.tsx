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
import { adapterIdOf, authorizeStateKey, canAuthorize, canPollNow, connectablePlatforms, disconnectInput, fieldIsSecret, marketplaceCardShown, pollStateKey, REAUTHORIZE_NOTICE_DAYS, reauthorizeNotice, reauthorizeNoticeKey, testStateKey } from '../src/lib/marketplace-connections.ts';

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
  authorizeState: null,
  reauthorizeBy: null,
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
        <MarketplaceConnectionsCard role={role} orgSlug="acme" />
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
    // The title is the element that carries that id (compared as text, so no id character needs escaping).
    const at = html.indexOf(`id="${labelId}"`);
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at, at + 400)).toContain(`>${en.marketplaceConnections.title}<`);
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
    // Only the offline adapter serves it, so the row says there is a test version to try and does not promise a connection to the marketplace.
    expect(html).toContain(`>${en.marketplaceConnections.adapterTest}<`);
    expect(html).not.toContain(`>${en.marketplaceConnections.adapterOn}<`);
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

  it('says a platform can be connected only where a real adapter serves it (ST-4)', () => {
    const real: MarketplaceProviders = { ...partial, adapters: [{ id: 'shopee_api', offline: false, connectFields: ['user', 'password'], platforms: ['shopee'] }] };
    const html = card('owner', { providers: real, connections: [] });
    expect(html).toContain(`>${en.marketplaceConnections.adapterOn}<`);
    expect(html).not.toContain(`>${en.marketplaceConnections.adapterTest}<`);
    expect(en.marketplaceConnections.adapterTest).not.toMatch(/server|sandbox/i);
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

  it('tells a Lazada seller who has not authorized the app apart from one whose key was refused, and shows the App Key as text and the App Secret hidden', () => {
    const lazada: MarketplaceProviders = { adapters: [{ id: 'lazada', offline: false, connectFields: ['appKey', 'appSecret'], platforms: ['lazada'] }], platforms: [{ platform: 'lazada', adapter: true, adapters: ['lazada'] }] };
    const mine = (over: Partial<MarketplaceConnection>) => connection({ provider: 'marketplace_lazada', platform: 'lazada', displayName: 'lazada (lazada)', ...over });
    const notYet = card('owner', { providers: lazada, connections: [mine({ lastTestState: 'api_not_enabled', lastTestedAt: at, lastPolledAt: at, lastPollState: 'credentials' })] });
    expect(notYet).toContain(esc(en.marketplaceConnections.testStatesLazada.api_not_enabled));
    expect(notYet).toContain(esc(en.marketplaceConnections.pollStatesLazada.not_authorized));
    expect(notYet).not.toContain(esc(en.marketplaceConnections.pollStates.credentials));
    const refused = card('owner', { providers: lazada, connections: [mine({ lastTestState: 'wrong_credentials', lastTestedAt: at, lastPolledAt: at, lastPollState: 'credentials' })] });
    expect(refused).toContain(esc(en.marketplaceConnections.testStatesLazada.wrong_credentials));
    expect(refused).toContain(esc(en.marketplaceConnections.pollStates.credentials));
    expect(refused).not.toContain(esc(en.marketplaceConnections.pollStatesLazada.not_authorized));
    // The sandbox keeps the generic words, and a Lazada state with no words of its own does too.
    expect(testStateKey('sandbox', 'api_not_enabled')).toBe('testStates.api_not_enabled');
    expect(testStateKey('lazada', 'unreachable')).toBe('testStates.unreachable');
    expect(pollStateKey(mine({ lastTestState: null }), 'credentials')).toBe('pollStates.credentials');
    expect(pollStateKey(connection({ lastTestState: 'api_not_enabled' }), 'credentials')).toBe('pollStates.credentials');
    expect(pollStateKey(mine({ lastTestState: 'api_not_enabled' }), 'ok')).toBe('pollStates.ok');
    // The form: the App Key is an identifier shown as typed, the App Secret is hidden, both in words.
    const form = card('owner', { providers: lazada, connections: [] });
    expect(form).toMatch(/type="text"[^>]*aria-label="App Key"|aria-label="App Key"[^>]*type="text"/);
    expect(form).toMatch(/type="password"[^>]*aria-label="App Secret"|aria-label="App Secret"[^>]*type="password"/);
    // Vietnamese words exist for both.
    expect(card('owner', { providers: lazada, connections: [], locale: 'vi' })).toContain('Mã bí mật ứng dụng (App Secret)');
  });

  it('offers Authorize on a live Lazada connection to an owner or admin, says where the authorization stands and until when, and offers it to no one else (#4238)', () => {
    const lazada: MarketplaceProviders = { adapters: [{ id: 'lazada', offline: false, connectFields: ['appKey', 'appSecret'], platforms: ['lazada'] }], platforms: [{ platform: 'lazada', adapter: true, adapters: ['lazada'] }] };
    const mine = (over: Partial<MarketplaceConnection>) => connection({ provider: 'marketplace_lazada', platform: 'lazada', displayName: 'lazada (lazada)', ...over });
    const fresh = card('owner', { providers: lazada, connections: [mine({})] });
    expect(fresh).toContain(`>${en.marketplaceConnections.authorize}<`);
    expect(fresh).not.toContain(`>${en.marketplaceConnections.authorizeAgain}<`);
    const done = card('admin', { providers: lazada, connections: [mine({ authorizeState: 'authorized', reauthorizeBy: '2027-05-20T08:00:00.000Z' })] });
    expect(done).toContain(`>${en.marketplaceConnections.authorizeAgain}<`);
    expect(done).toContain(en.marketplaceConnections.authorizeStates.authorized);
    expect(done).toContain('authorize again before');
    for (const state of ['pending', 'refused', 'failed'] as const) {
      expect(card('owner', { providers: lazada, connections: [mine({ authorizeState: state })] })).toContain(esc(en.marketplaceConnections.authorizeStates[state]));
    }
    // Members and viewers read it; no button. A dead connection and the sandbox have none.
    for (const role of ['member', 'viewer'] as const) expect(card(role, { providers: lazada, connections: [mine({ authorizeState: 'pending' })] })).not.toContain(`>${en.marketplaceConnections.authorize}<`);
    expect(card('owner', { providers: lazada, connections: [mine({ status: 'expired' })] })).not.toContain(`>${en.marketplaceConnections.authorize}<`);
    expect(card('owner')).not.toContain(`>${en.marketplaceConnections.authorize}<`);
    expect(canAuthorize(mine({}), lazada.adapters)).toBe(true);
    expect(canAuthorize(mine({}), [])).toBe(false);
    expect(canAuthorize(connection(), offered.adapters)).toBe(false);
    // Vietnamese words exist.
    expect(card('owner', { providers: lazada, connections: [mine({ authorizeState: 'refused' })], locale: 'vi' })).toContain('Cấp quyền lại');
  });

  it('words TikTok Shop on its own: not authorized yet, refused, the shop failure, and the Service ID as plain text (#4269)', () => {
    const tiktok: MarketplaceProviders = { adapters: [{ id: 'tiktok_shop', offline: false, connectFields: ['appKey', 'appSecret', 'serviceId'], platforms: ['tiktok_shop'] }], platforms: [{ platform: 'tiktok_shop', adapter: true, adapters: ['tiktok_shop'] }] };
    const mine = (over: Partial<MarketplaceConnection>) => connection({ provider: 'marketplace_tiktok_shop', platform: 'tiktok_shop', displayName: 'tiktok_shop (tiktok_shop)', ...over });
    const notYet = card('owner', { providers: tiktok, connections: [mine({ lastTestState: 'api_not_enabled', lastTestedAt: at, lastPolledAt: at, lastPollState: 'credentials' })] });
    expect(notYet).toContain(esc(en.marketplaceConnections.testStatesTiktok.api_not_enabled));
    expect(notYet).toContain(esc(en.marketplaceConnections.pollStatesTiktok.not_authorized));
    expect(notYet).toContain(`>${en.marketplaceConnections.authorize}<`);
    const refused = card('owner', { providers: tiktok, connections: [mine({ lastTestState: 'wrong_credentials', lastTestedAt: at, lastPolledAt: at, lastPollState: 'credentials' })] });
    expect(refused).toContain(esc(en.marketplaceConnections.testStatesTiktok.wrong_credentials));
    expect(refused).toContain(esc(en.marketplaceConnections.pollStates.credentials));
    expect(refused).not.toContain(esc(en.marketplaceConnections.pollStatesTiktok.not_authorized));
    // A failed authorization names the shops (the app must be bound to one); Lazada's failure does not.
    const failed = card('owner', { providers: tiktok, connections: [mine({ authorizeState: 'failed' })] });
    expect(failed).toContain(esc(en.marketplaceConnections.authorizeStatesTiktok.failed));
    expect(authorizeStateKey('lazada', 'failed')).toBe('authorizeStatesLazada.failed');
    expect(authorizeStateKey('tiktok_shop', 'failed')).toBe('authorizeStatesTiktok.failed');
    expect(authorizeStateKey('tiktok_shop', 'refused')).toBe('authorizeStates.refused');
    expect(testStateKey('tiktok_shop', 'unreachable')).toBe('testStates.unreachable');
    expect(canAuthorize(mine({}), tiktok.adapters)).toBe(true);
    const form = card('owner', { providers: tiktok, connections: [], locale: 'vi' });
    expect(form).toMatch(/type="text"[^>]*aria-label="Mã dịch vụ của ứng dụng \(Service ID\)"|aria-label="Mã dịch vụ của ứng dụng \(Service ID\)"[^>]*type="text"/);
    expect(form).toMatch(/type="password"[^>]*aria-label="Mã bí mật ứng dụng \(App Secret\)"|aria-label="Mã bí mật ứng dụng \(App Secret\)"[^>]*type="password"/);
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
    for (const name of ['user', 'username', 'appId', 'appKey', 'serviceId', 'shopId']) expect(fieldIsSecret(name)).toBe(false);
    for (const name of ['password', 'secret', 'appSecret', 'partnerKey', 'token']) expect(fieldIsSecret(name)).toBe(true);
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

describe('the re-authorize notice (#4240 S3b)', () => {
  const NOW = new Date('2026-11-21T08:00:00.000Z');
  const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
  const authorized = (reauthorizeBy: string | null, over: Partial<MarketplaceConnection> = {}) => connection({ provider: 'marketplace_lazada', platform: 'lazada', authorizeState: 'authorized', reauthorizeBy, ...over });

  it('says nothing until 14 days before the date, `soon` from then, and `ended` once it has passed', () => {
    expect(REAUTHORIZE_NOTICE_DAYS).toBe(14);
    expect(reauthorizeNotice(authorized(inDays(60)), NOW)).toBeNull();
    expect(reauthorizeNotice(authorized(inDays(14.01)), NOW)).toBeNull();
    expect(reauthorizeNotice(authorized(inDays(14)), NOW)).toBe('soon');
    expect(reauthorizeNotice(authorized(inDays(1)), NOW)).toBe('soon');
    expect(reauthorizeNotice(authorized(inDays(0)), NOW)).toBe('ended');
    expect(reauthorizeNotice(authorized(inDays(-3)), NOW)).toBe('ended');
  });

  it('has no notice without a date, for a connection that was not authorized, a disconnected one, or a date that is no date', () => {
    expect(reauthorizeNotice(authorized(null), NOW)).toBeNull();
    expect(reauthorizeNotice(authorized(inDays(3), { authorizeState: null }), NOW)).toBeNull();
    for (const state of ['pending', 'refused', 'failed'] as const) expect(reauthorizeNotice(authorized(inDays(3), { authorizeState: state }), NOW)).toBeNull();
    expect(reauthorizeNotice(authorized(inDays(3), { status: 'revoked' }), NOW)).toBeNull();
    expect(reauthorizeNotice(authorized('not a date'), NOW)).toBeNull();
    // An expired connection (the sweep refused its token) still tells the seller to authorize again once the date has passed.
    expect(reauthorizeNotice(authorized(inDays(-1), { status: 'expired' }), NOW)).toBe('ended');
  });

  it('tells a connection that cannot be authorized again (it has stopped) to disconnect and connect again, not to press a button the card does not show', () => {
    expect(reauthorizeNoticeKey('soon', true)).toBe('reauthorizeSoon');
    expect(reauthorizeNoticeKey('ended', true)).toBe('reauthorizeEnded');
    expect(reauthorizeNoticeKey('soon', false)).toBe('reauthorizeReconnect');
    expect(reauthorizeNoticeKey('ended', false)).toBe('reauthorizeReconnect');
    const lazada = { providers: { adapters: [{ id: 'lazada', offline: false, connectFields: ['appKey', 'appSecret'], platforms: ['lazada' as const] }], platforms: [{ platform: 'lazada' as const, adapter: true, adapters: ['lazada'] }] } };
    // The sweep marked it expired (the platform refused the refresh token): no Authorize button, so the notice says to connect again.
    const expired = card('owner', { ...lazada, connections: [authorized(new Date(Date.now() - 2 * 86_400_000).toISOString(), { status: 'expired' })] });
    expect(expired).toContain(esc('cannot be authorized again'));
    expect(expired).not.toContain(`>${en.marketplaceConnections.authorizeAgain}<`);
    expect(expired).not.toContain(esc('press Authorize again'));
    const vi = card('owner', { ...lazada, locale: 'vi', connections: [authorized(new Date(Date.now() - 2 * 86_400_000).toISOString(), { status: 'expired' })] });
    expect(vi).toContain('ngắt kết nối rồi kết nối lại');
  });

  it('sends `deleteStaged` only when the member ticked it and orders are waiting', () => {
    expect(disconnectInput({ id: 'k1', ordersWaiting: 3 }, true)).toEqual({ id: 'k1', deleteStaged: true });
    expect(disconnectInput({ id: 'k1', ordersWaiting: 3 }, false)).toEqual({ id: 'k1' });
    expect(disconnectInput({ id: 'k1', ordersWaiting: 0 }, true)).toEqual({ id: 'k1' });
  });

  it('shows the notice on the card in both languages, and only when there is one', () => {
    const lazada = { providers: { adapters: [{ id: 'lazada', offline: false, connectFields: ['appKey', 'appSecret'], platforms: ['lazada' as const] }], platforms: [{ platform: 'lazada' as const, adapter: true, adapters: ['lazada'] }] } };
    const soon = card('owner', { ...lazada, connections: [authorized(new Date(Date.now() + 5 * 86_400_000).toISOString())] });
    expect(soon).toContain('data-testid="reauthorize-notice"');
    expect(soon).toContain(esc('The authorization given to the marketplace ends on'));
    const ended = card('owner', { ...lazada, connections: [authorized(new Date(Date.now() - 2 * 86_400_000).toISOString())] });
    expect(ended).toContain(esc('The authorization given to the marketplace ended on'));
    const vi = card('owner', { ...lazada, locale: 'vi', connections: [authorized(new Date(Date.now() + 5 * 86_400_000).toISOString())] });
    expect(vi).toContain('Quyền cấp cho sàn sẽ hết hạn ngày');
    const far = card('owner', { ...lazada, connections: [authorized(new Date(Date.now() + 90 * 86_400_000).toISOString())] });
    expect(far).not.toContain('reauthorize-notice');
    // A member reads the notice too (the date is not a secret), but is not offered the button.
    const member = card('member', { ...lazada, connections: [authorized(new Date(Date.now() + 5 * 86_400_000).toISOString())] });
    expect(member).toContain('data-testid="reauthorize-notice"');
    expect(member).not.toContain(`>${en.marketplaceConnections.authorizeAgain}<`);
  });
});
