// SPDX-License-Identifier: AGPL-3.0-only
// The Ads screen's parts (ADR-0040, #2217), rendered on the server with the API's answers seeded in the cache: what the
// empty screen offers each role, the settings of an account, the totals with and without a result kind, the tables with
// the marker of a day that is not final yet, and the books strip (shown only for an account in dong, with exact
// differences). The page itself, which reads the address and the session, is covered end to end (e2e/tests/ads.spec.ts).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdAccountView, AdsSummary, AdsWriteState, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): the key is the path and the input, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (options?: { input?: unknown }) => ({
            queryKey: options?.input === undefined ? path : [...path, options.input],
            queryFn: () => Promise.reject(new Error('not fetched')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  // `client` is the plain oRPC client the Meta connect button starts its sign-in with; rendering never calls it.
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, client: { channels: { oauthStart: () => Promise.reject(new Error('not called')) } } };
});

const { AdsBooksStrip } = await import('../src/components/ads-books-strip.tsx');
const { AccountHeader, AdsEmpty, AdsSettingsCard, Breakdowns, ConnectMeta, Totals } = await import('../src/routes/ads.tsx');
const { AdsWriteCard } = await import('../src/components/ads-write.tsx');

function render(node: ReactNode, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const at = '2026-11-01T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean): LegalEntity => ({ id, name, kind: 'company', taxCode: null, parentId: null, isDefault, createdAt: at, updatedAt: at });
const one = [entity('e1', 'Công ty TNHH Mẫu', true)];
const two = [...one, entity('e2', 'Chi nhánh Hà Nội', false)];

const account = (over: Partial<AdAccountView> = {}): AdAccountView => ({
  id: 'a1',
  connectionId: 'c1',
  connectionStatus: 'active',
  pausedSince: null,
  pausedReason: null,
  writeEnabled: false,
  extraScopes: [],
  provider: 'sandbox_ads',
  name: 'Quảng cáo cửa hàng',
  currency: 'VND',
  timeZone: 'Asia/Ho_Chi_Minh',
  legalEntityId: 'e1',
  expenseAccountCode: null,
  resultKind: null,
  resultKinds: ['purchase', 'lead'],
  backfillFrom: '2025-10-01',
  settledThrough: '2026-10-31',
  syncedThrough: '2026-11-02',
  lastRunAt: at,
  lastErrorKind: null,
  nextRunAt: null,
  ...over,
});

const metric = (over: Partial<AdsSummary['total']> = {}): AdsSummary['total'] => ({ spend: '1500000', impressions: 12000, clicks: 340, results: '10', costPerResult: '150000', ...over });
const summary = (over: Partial<AdsSummary> = {}): AdsSummary => ({
  adAccountId: 'a1',
  currency: 'VND',
  timeZone: 'Asia/Ho_Chi_Minh',
  resultKind: 'purchase',
  from: '2026-11-01',
  to: '2026-11-02',
  total: metric({ spend: '3000000', results: '20' }),
  months: [{ month: '2026-11', ...metric({ spend: '3000000', results: '20' }) }],
  campaigns: [{ externalObjectId: 'c1', name: 'Khuyến mãi tháng 11', ...metric() }],
  days: [
    { day: '2026-11-01', ...metric(), reach: 9000, settled: true },
    { day: '2026-11-02', ...metric(), reach: null, settled: false },
  ],
  settledThrough: '2026-10-31',
  syncedThrough: '2026-11-02',
  ...over,
});

// The attributes of the first <button> whose label is `label`, which hold `disabled=""` when it cannot be pressed.
const buttonBefore = (html: string, label: string): string | undefined => {
  const chunk = html.split('<button').find((c) => c.includes(`>${label}<`));
  return chunk?.slice(0, chunk.indexOf(`>${label}<`));
};
// An <option> of this value that is the selected one, whatever the order of its attributes.
const selectedOption = (value: string) => new RegExp(`<option(?=[^>]*value="${value}")(?=[^>]*selected="")[^>]*>`);

beforeEach(() => client.current.clear());

describe('the empty Ads screen', () => {
  const empty = (canManage: boolean, sandbox: boolean, entities: readonly LegalEntity[] = one) =>
    render(<AdsEmpty canManage={canManage} sandbox={sandbox} entities={entities} onConnected={() => undefined} />);

  it.each(['owner', 'admin'])('as %s, with the test ad platform on: says what Ads shows and offers to connect a test account', () => {
    const html = empty(true, true);
    expect(html).toContain(en.ads.emptyTitle);
    expect(html).toContain(`>${en.ads.connectTitle}<`);
    expect(html).toContain(en.ads.testNote);
    expect(html).toContain(`>${en.ads.connectName}<`);
    expect(html).toContain(`>${en.ads.connectCurrency}<`);
    expect(html).toContain(`>${en.ads.currencies.VND}<`);
    expect(html).toContain(`>${en.ads.currencies.USD}<`);
    expect(html).toContain(`>${en.ads.connect}<`);
    expect(html).not.toContain(en.ads.noPlatform);
    // One legal entity: only the currency to choose.
    expect(html.match(/<select/g)).toHaveLength(1);
  });

  it('offers the legal entity to an org with several', () => {
    const html = empty(true, true, two);
    expect(html).toContain(`>${en.ads.connectEntity}<`);
    expect(html).toContain('>Chi nhánh Hà Nội<');
    expect(html.match(/<select/g)).toHaveLength(2);
  });

  it.each(['member', 'viewer'])('as %s, with the test ad platform on: reads the explanation and nothing else', () => {
    const html = empty(false, true);
    expect(html).toContain(en.ads.emptyTitle);
    expect(html).toContain(en.ads.emptyMembers);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<select');
  });

  it.each([true, false])('says no ad platform is set up on a deployment without one (can manage: %s)', (canManage) => {
    const html = empty(canManage, false);
    expect(html).toContain(en.ads.noPlatform);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('has words in Vietnamese too', () => {
    const html = render(<AdsEmpty canManage sandbox entities={one} onConnected={() => undefined} />, 'vi');
    expect(html).toContain(viMessages.ads.emptyTitle);
    expect(html).toContain(`>${viMessages.ads.connectTitle}<`);
    expect(html).toContain(`>${viMessages.ads.connect}<`);
  });
});

describe('the empty Ads screen where Meta ads is offered', () => {
  const meta = { slug: 'acme' };
  const empty = (canManage: boolean, sandbox: boolean, offered: boolean, locale: 'en' | 'vi' = 'en') =>
    render(<AdsEmpty canManage={canManage} sandbox={sandbox} meta={offered ? meta : undefined} entities={one} onConnected={() => undefined} />, locale);

  it.each(['owner', 'admin'])('as %s: offers to connect a Meta ad account, and says it only reads reports', () => {
    const html = empty(true, false, true);
    expect(html).toContain(`>${en.ads.connectMeta.title}<`);
    expect(buttonBefore(html, en.ads.connectMeta.action)).toBeDefined();
    expect(buttonBefore(html, en.ads.connectMeta.action)).not.toContain('disabled=""');
    expect(html).toContain('ads_read');
    expect(html).toContain('never creates or changes a campaign');
    expect(html).toContain(en.ads.connectMeta.expiry);
    // Meta alone is a platform: no "no platform" notice, and no test form without the sandbox.
    expect(html).not.toContain(en.ads.noPlatform);
    expect(html).not.toContain(`>${en.ads.connectTitle}<`);
    expect(html).not.toContain('<form');
  });

  it('keeps the test account form beside the Meta button where the sandbox is on too', () => {
    const html = empty(true, true, true);
    expect(buttonBefore(html, en.ads.connectMeta.action)).toBeDefined();
    expect(html).toContain(`>${en.ads.connectTitle}<`);
    expect(html).toContain(`>${en.ads.connect}<`);
  });

  it.each(['member', 'viewer'])('as %s: reads the explanation and has no Meta button', () => {
    const html = empty(false, false, true);
    expect(html).toContain(en.ads.emptyMembers);
    expect(html).not.toContain(en.ads.connectMeta.action);
    expect(html).not.toContain('<button');
    expect(html).not.toContain(en.ads.noPlatform);
  });

  it.each([true, false])('offers no Meta button where the deployment has no Meta ads app (can manage: %s)', (canManage) => {
    const html = empty(canManage, false, false);
    expect(html).toContain(en.ads.noPlatform);
    expect(html).not.toContain(en.ads.connectMeta.action);
    expect(html).not.toContain('<button');
  });

  it('draws no Meta button beside the test form where only the sandbox is on', () => {
    const html = empty(true, true, false);
    expect(html).not.toContain(en.ads.connectMeta.action);
    expect(html).not.toContain(`>${en.ads.connectMeta.title}<`);
  });

  it('has words in Vietnamese too', () => {
    const html = empty(true, false, true, 'vi');
    expect(buttonBefore(html, viMessages.ads.connectMeta.action)).toBeDefined();
    expect(html).toContain('Kết nối tài khoản quảng cáo Meta');
    expect(html).toContain('ads_read');
    expect(html).toContain(viMessages.ads.connectMeta.expiry);
  });
});

describe('the Meta connection button on its own', () => {
  it('is the short form "connect another" for an org that has an ad account, without its own heading', () => {
    const html = render(<ConnectMeta slug="acme" another />);
    expect(buttonBefore(html, en.ads.connectMeta.another)).toBeDefined();
    expect(html).not.toContain(`>${en.ads.connectMeta.title}<`);
    expect(html).not.toContain('<h2');
    expect(html).toContain('ads_read');
  });
});

describe('the settings of an ad account', () => {
  const settings = (acc: AdAccountView, entities: readonly LegalEntity[] = one) => render(<AdsSettingsCard account={acc} entities={entities} />);

  it('shows the three settings as the server has them, with the saved result kind selected', () => {
    const html = settings(account({ resultKind: 'lead', expenseAccountCode: '6421' }));
    expect(html).toContain(`>${en.ads.settings.title}<`);
    expect(html).toContain(`>${en.ads.settings.resultKind}<`);
    expect(html).toContain(`>${en.ads.settings.noResultKind}<`);
    expect(html).toContain('>Purchases<');
    expect(html).toContain('>Leads<');
    expect(html).toMatch(selectedOption('lead'));
    expect(html).toContain(`>${en.ads.settings.expenseCode}<`);
    expect(html).toContain('value="6421"');
    expect(html).toContain(en.ads.settings.expenseCodeHint);
  });

  it('keeps Save out of reach while nothing has changed', () => {
    expect(buttonBefore(settings(account()), en.ads.settings.save)).toContain('disabled=""');
  });

  it('shows a result kind the platform no longer lists, so the select is never blank for a choice made', () => {
    const html = settings(account({ resultKind: 'messaging_started', resultKinds: ['purchase'] }));
    expect(html).toContain('>messaging_started<');
    expect(html).toMatch(selectedOption('messaging_started'));
  });

  it('says so, and leaves the select off, when the platform has no result kinds on this server', () => {
    const html = settings(account({ resultKinds: [] }));
    expect(html).toContain(en.ads.settings.noResultKinds);
    const select = html.slice(html.indexOf('<select'), html.indexOf('>', html.indexOf('<select')));
    expect(select).toContain('disabled=""');
  });

  it('offers the legal entity only to an org with several', () => {
    expect(settings(account(), one)).not.toContain(`>${en.ads.settings.legalEntity}<`);
    const html = settings(account({ legalEntityId: 'e2' }), two);
    expect(html).toContain(`>${en.ads.settings.legalEntity}<`);
    expect(html).toMatch(selectedOption('e2'));
  });

  it.each(['active', 'expired', 'error'] as const)('offers to disconnect a %s connection, behind a confirmation that is not open yet', (connectionStatus) => {
    const html = settings(account({ connectionStatus }));
    expect(html).toContain(en.ads.settings.disconnectHint);
    // The trigger opens a dialog; the question itself shows only once it is open.
    expect(buttonBefore(html, en.ads.settings.disconnect)).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain(en.ads.settings.disconnectTitle);
    // Outside the form of the settings: opening it is not saving them.
    expect(html.indexOf('</form>')).toBeLessThan(html.indexOf(`>${en.ads.settings.disconnect}<`));
  });

  it('offers nothing to disconnect on an account that already is, and keeps its settings', () => {
    const html = settings(account({ connectionStatus: 'revoked', resultKind: 'lead' }));
    expect(html).not.toContain(`>${en.ads.settings.disconnect}<`);
    // The one dialog left is the deletion of the stored history (#2219).
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(1);
    expect(html).not.toContain(en.ads.settings.disconnectHint);
    expect(html).toMatch(selectedOption('lead'));
    expect(buttonBefore(html, en.ads.settings.save)).toBeDefined();
  });

  it.each(['active', 'expired', 'revoked', 'error'] as const)('offers to delete the stored history of a %s account, behind a confirmation that is not open yet', (connectionStatus) => {
    const html = settings(account({ connectionStatus }));
    expect(html).toContain(en.ads.settings.deleteHistoryHint);
    expect(buttonBefore(html, en.ads.settings.deleteHistory)).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain(en.ads.settings.deleteHistoryTitle);
    // Outside the form of the settings: opening it is not saving them.
    expect(html.indexOf('</form>')).toBeLessThan(html.indexOf(`>${en.ads.settings.deleteHistory}<`));
  });
});

describe('a paused ad account (#2219)', () => {
  const header = (acc: AdAccountView) => render(<AccountHeader account={acc} canRefresh onRequested={() => undefined} />);

  it.each([
    ['token_expired', 'expired', 'no longer accepts this account’s access token'],
    ['owner_left', 'expired', 'is no longer an owner or admin'],
  ] as const)('says why a %s account stopped and since when, and that no day is lost', (pausedReason, connectionStatus, words) => {
    const html = header(account({ connectionStatus, pausedReason, pausedSince: '2026-10-30T03:00:00.000Z' }));
    expect(html.replaceAll('&#x27;', '’')).toContain(words);
    expect(html).toContain('30');
    // A line that tells the person what resumes it, not the old generic one.
    expect(html).not.toContain(en.ads.connectionHint.expired);
  });

  it('keeps the quiet line of a disconnect the owner chose, whatever the reason recorded', () => {
    const html = header(account({ connectionStatus: 'revoked', pausedReason: 'disconnected', pausedSince: '2026-10-30T03:00:00.000Z' }));
    expect(html).toContain(en.ads.connectionHint.revoked);
  });

  it('falls back to the generic line for a connection with no recorded reason', () => {
    expect(header(account({ connectionStatus: 'expired', pausedReason: null, pausedSince: null }))).toContain('The connection of this account has expired');
  });

  it('offers to connect Meta again, in words of its own', () => {
    const html = render(<ConnectMeta slug="cong-ty" another reconnect />);
    expect(html).toContain(`>${en.ads.connectMeta.reconnect}<`);
    expect(html).not.toContain(`>${en.ads.connectMeta.another}<`);
  });
});

describe('running ads: the stops, the switches and the caps (#2294, W0a-1)', () => {
  const at2 = '2026-11-02T03:00:00.000Z';
  const stateOf = (over: Partial<AdsWriteState> = {}): AdsWriteState => ({ writeEnabled: false, launchesBlocked: false, updatedAt: null, caps: [], ...over });
  const card = (state: AdsWriteState, role: 'owner' | 'admin', accounts: AdAccountView[] = [account()]) => {
    client.current.setQueryData(['ads', 'writeState'], state);
    return render(<AdsWriteCard role={role} accounts={accounts} />);
  };
  const cap = (over: Partial<AdsWriteState['caps'][number]>): AdsWriteState['caps'][number] => ({ scope: 'org', adAccountId: null, period: 'daily', amount: '5000000', currency: 'VND', setBy: 'u1', setAt: at2, ...over });

  it('says it is off and offers nobody a button to turn it on: that is a proposal, not a button of this card', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf(), role);
      expect(html).toContain(`>${en.ads.write.off}<`);
      expect(html).toContain(en.ads.write.offHint);
      expect(html).not.toContain(en.ads.write.accounts);
      expect(html).not.toContain(en.ads.write.pauseAll);
      expect(html).not.toContain('<button');
    }
  });

  it('shows what is on: the owner may turn it off behind a confirmation and an account off, and owners and admins may stop it all', () => {
    const html = card(stateOf({ writeEnabled: true }), 'owner', [account({ writeEnabled: true }), account({ id: 'a2', name: 'Tài khoản hai', writeEnabled: false })]);
    expect(html).toContain(`>${en.ads.write.on}<`);
    expect(buttonBefore(html, en.ads.write.disable)).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain(en.ads.write.disableTitle);
    expect(html).toContain(en.ads.write.accounts);
    expect(html).toContain(`>${en.ads.write.accountOn}<`);
    expect(html).toContain(`>${en.ads.write.accountOff}<`);
    // One withdraw button, for the enabled account only; nothing here enables an account.
    expect(html.split(`>${en.ads.write.accountDisable}<`)).toHaveLength(2);
    expect(buttonBefore(html, en.ads.write.accountDisable)).toBeDefined();
    expect(buttonBefore(html, en.ads.write.pauseAll)).toContain('aria-haspopup="dialog"');
    // The admin: the state and the kill switch, none of the owner's buttons.
    const admin = card(stateOf({ writeEnabled: true }), 'admin', [account({ writeEnabled: true })]);
    expect(buttonBefore(admin, en.ads.write.pauseAll)).toBeDefined();
    expect(admin).not.toContain(`>${en.ads.write.disable}<`);
    expect(admin).not.toContain(`>${en.ads.write.accountDisable}<`);
  });

  it('says launches are blocked, with no button to open them again; the kill switch is not offered while blocked', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf({ writeEnabled: true, launchesBlocked: true }), role);
      expect(html).toContain(en.ads.write.blocked);
      expect(html).not.toContain(`>${en.ads.write.pauseAll}<`);
    }
  });

  it('lists the caps of the org and of each account in their currency and "not set" where there is none, with no way to set one', () => {
    const state = stateOf({
      caps: [cap({}), cap({ period: 'monthly', amount: '100000000' }), cap({ scope: 'account', adAccountId: 'a1', amount: '1000000' }), cap({ scope: 'account', adAccountId: 'a1', period: 'monthly', amount: '20.50', currency: 'USD' })],
    });
    for (const role of ['owner', 'admin'] as const) {
      const html = card(state, role, [account(), account({ id: 'a2', name: 'Tài khoản hai' })]);
      expect(html).toContain(en.ads.write.capOrg);
      expect(html).toContain('Quảng cáo cửa hàng');
      expect(html).toContain('Tài khoản hai');
      // Decimal strings through the money formatter, never a number; the account without a cap says so.
      expect(html).toMatch(/5,000,000/);
      expect(html).toMatch(/100,000,000/);
      expect(html).toContain(en.ads.write.capNone);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
    }
  });

  it('has the same words in Vietnamese as in English for the card', () => {
    client.current.setQueryData(['ads', 'writeState'], stateOf({ writeEnabled: true }));
    const vi = render(<AdsWriteCard role="owner" accounts={[account({ writeEnabled: true })]} />, 'vi');
    expect(vi).toContain(viMessages.ads.write.title);
    expect(vi).toContain(viMessages.ads.write.pauseAll);
    expect(Object.keys(viMessages.ads.write).sort()).toEqual(Object.keys(en.ads.write).sort());
  });
});

describe('the header of an ad account', () => {
  const header = (acc: AdAccountView, canRefresh = true) => render(<AccountHeader account={acc} canRefresh={canRefresh} onRequested={() => undefined} />);
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
  const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

  it('says when the connection can do more than read ad reports, and says nothing when it cannot', () => {
    const quiet = header(account({ provider: 'meta_ads' }));
    expect(quiet).not.toContain('can do more than read');
    const html = header(account({ provider: 'meta_ads', extraScopes: ['pages_manage_posts', 'pages_show_list'] }));
    expect(html).toContain('can do more than read ad reports');
    expect(html).toContain('pages_manage_posts, pages_show_list');
  });

  it('says the sandbox figures are made up, how far they run, and offers a refresh to those who may ask', () => {
    const html = header(account());
    expect(html).toContain('>Quảng cáo cửa hàng<');
    expect(html).toContain(`>${en.ads.sandboxBadge}<`);
    expect(html).toContain('Figures are up to date through');
    expect(buttonBefore(html, en.ads.refresh)).toBeDefined();
    expect(buttonBefore(html, en.ads.refresh)).not.toContain('disabled=""');
    expect(html).not.toContain(en.ads.refreshHold.replace(' {when}', ''));
  });

  it('shows a small Meta badge, not the sandbox one, for a Meta ad account, with its currency and time zone', () => {
    const html = header(account({ provider: 'meta_ads', name: 'Meta cửa hàng' }));
    expect(html).toContain('>Meta<');
    expect(html).not.toContain(en.ads.sandboxBadge);
    expect(html).toContain('Currency VND, time zone Asia/Ho_Chi_Minh');
  });

  it('shows no platform badge for the sandbox other than its own', () => {
    expect(header(account())).not.toContain('>Meta<');
  });

  it('offers no refresh to a viewer', () => {
    expect(header(account(), false)).not.toContain('<button');
  });

  it('holds Refresh back while the platform limits the account, with the time beside it, and gives it back when that has passed', () => {
    const held = header(account({ nextRunAt: inAnHour(), lastErrorKind: 'rate_limited' }));
    expect(buttonBefore(held, en.ads.refresh)).toContain('disabled=""');
    expect(buttonBefore(held, en.ads.refresh)).toContain('aria-describedby=');
    expect(held).toContain('Refresh paused until');
    expect(held).toContain(en.ads.errors.rate_limited);
    const over = header(account({ nextRunAt: anHourAgo() }));
    expect(buttonBefore(over, en.ads.refresh)).not.toContain('disabled=""');
    expect(over).not.toContain('Refresh paused until');
  });

  it('shows a disconnected account quietly, with its figures as stored and nothing that claims it is live', () => {
    // It had failed and had a try planned before it was disconnected: neither is said.
    const html = header(account({ connectionStatus: 'revoked', lastErrorKind: 'transient', nextRunAt: inAnHour() }));
    expect(html).toContain(`>${en.ads.connection.revoked}<`);
    expect(html).toContain(en.ads.connectionHint.revoked);
    expect(html).toContain('Stored figures run through');
    expect(buttonBefore(html, en.ads.refresh)).toContain('disabled=""');
    expect(html).not.toContain('up to date');
    expect(html).not.toContain(en.ads.errors.transient);
    expect(html).not.toContain(en.ads.errors.keptFigures);
    expect(html).not.toContain('Next update');
    expect(html).not.toContain('Refresh paused until');
    // Quiet, not a warning: the warning color is for an expired connection or one in trouble.
    expect(html).not.toContain('text-warning');
  });

  it.each(['expired', 'error'] as const)('says an %s connection is not updated, who can fix it, and cannot be refreshed', (connectionStatus) => {
    const html = header(account({ connectionStatus }));
    expect(html).toContain(`>${en.ads.connection[connectionStatus]}<`);
    expect(html).toContain(en.ads.connectionHint[connectionStatus]);
    expect(buttonBefore(html, en.ads.refresh)).toContain('disabled=""');
    expect(html).not.toContain('up to date');
  });

  it('asks an owner or admin to connect an expired account again', () => {
    expect(header(account({ connectionStatus: 'expired' }))).toContain('An owner or admin must connect the account again');
    expect(render(<AccountHeader account={account({ connectionStatus: 'expired' })} canRefresh onRequested={() => undefined} />, 'vi')).toContain(
      'Chủ sở hữu hoặc quản trị viên cần kết nối lại tài khoản',
    );
  });

  it('says in words why an update failed, for an account that is live', () => {
    const html = header(account({ lastErrorKind: 'token_expired' }));
    expect(html).toContain(en.ads.errors.token_expired);
    expect(html).toContain(en.ads.errors.keptFigures);
  });
});

describe('the totals of a period', () => {
  const totals = (s: AdsSummary, canManage = true) => render(<Totals summary={s} currency="VND" canManage={canManage} />);

  it('shows spend, impressions, clicks, the results of the chosen kind and the cost per result', () => {
    const html = totals(summary());
    for (const label of [en.ads.totals.spend, en.ads.totals.impressions, en.ads.totals.clicks, en.ads.totals.results, en.ads.totals.costPerResult]) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/3[.,]000[.,]000/);
    expect(html).toMatch(/150[.,]000/);
    expect(html).toContain('>Purchases<');
    expect(html).not.toContain(en.ads.chooseResultKind);
  });

  it('says there is no result yet, instead of a cost of zero', () => {
    const html = totals(summary({ total: metric({ results: '0', costPerResult: null }) }));
    expect(html).toContain(en.ads.noResultsYet);
    expect(html).toContain('>-<');
  });

  it('asks an owner or admin to choose a result kind, in place of results and cost per result', () => {
    const html = totals(summary({ resultKind: null, total: metric({ results: null, costPerResult: null }) }));
    expect(html).toContain(en.ads.chooseResultKind);
    expect(html).toContain(`>${en.ads.chooseResultKindAction}<`);
    expect(html).not.toContain(`>${en.ads.totals.costPerResult}<`);
    expect(html).toContain(`>${en.ads.totals.spend}<`);
  });

  it('tells a member or viewer who chooses it, with nothing to press', () => {
    const html = totals(summary({ resultKind: null, total: metric({ results: null, costPerResult: null }) }), false);
    expect(html).toContain(en.ads.chooseResultKindOther);
    expect(html).not.toContain('<button');
  });

  it('explains the terms and says nothing is converted', () => {
    expect(totals(summary())).toContain(en.ads.howToRead);
  });
});

describe('the tables of a period', () => {
  const tables = (s: AdsSummary) => render(<Breakdowns summary={s} currency="VND" />);

  it('lists the months, the campaigns and the days, a day not final yet marked in words', () => {
    const html = tables(summary());
    expect(html).toContain('>11/2026<');
    expect(html).toContain('Khuyến mãi tháng 11');
    expect(html).toContain('01/11/2026');
    expect(html).toContain('02/11/2026');
    // Only 2 November is not final.
    expect(html.match(new RegExp(`>${en.ads.notFinal}<`, 'g'))).toHaveLength(1);
    // Reach is a column of the days only; one without it shows a dash.
    expect(html.match(new RegExp(`>${en.ads.columns.reach}<`, 'g'))).toHaveLength(1);
    expect(html).toContain('>-<');
  });

  it('has the results columns in each of the three tables when a result kind is chosen', () => {
    const html = tables(summary());
    expect(html.match(new RegExp(`>${en.ads.columns.results}<`, 'g'))).toHaveLength(3);
    expect(html.match(new RegExp(`>${en.ads.columns.costPerResult}<`, 'g'))).toHaveLength(3);
  });

  it('leaves the results columns out when no result kind is chosen', () => {
    const none = metric({ results: null, costPerResult: null });
    const html = tables(
      summary({
        resultKind: null,
        total: none,
        months: [{ month: '2026-11', ...none }],
        campaigns: [{ externalObjectId: 'c1', name: 'Khuyến mãi tháng 11', ...none }],
        days: [{ day: '2026-11-01', ...none, reach: 9000, settled: true }],
      }),
    );
    expect(html).not.toContain(`>${en.ads.columns.results}<`);
    expect(html).not.toContain(`>${en.ads.columns.costPerResult}<`);
    expect(html).toContain(`>${en.ads.columns.spend}<`);
  });

  it('says when the platform reported no campaign in the period', () => {
    expect(tables(summary({ campaigns: [] }))).toContain(en.ads.campaignsEmpty);
  });

  it('writes no tax figure and offers no way to change a campaign', () => {
    const html = tables(summary());
    expect(html).not.toMatch(/VAT|GTGT/);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });
});

describe('the books strip', () => {
  const months = [
    { month: '2026-09', spend: '12000000' },
    { month: '2026-10', spend: '0' },
    { month: '2026-11', spend: '2000000' },
  ];
  // The ledger of the expense account as ledger.account answers: the lines of the month (a debit against 331, a credit
  // against 111 when given, and any more), whose debits less credits the strip adds up itself.
  type Line = { debit: string; credit: string; counterAccounts: string[]; reversal: boolean };
  const row = (debit: string, credit: string, counterAccounts: string[]): Line => ({ debit, credit, counterAccounts, reversal: false });
  const ledger = (debit: string, credit = '0.0000', more: Line[] = []) => ({
    account: { code: '6421', name: 'Chi phí bán hàng' },
    opening: '0',
    lines: [row(debit, '0.0000', ['331']), ...(credit === '0.0000' ? [] : [row('0.0000', credit, ['111'])]), ...more],
    debit,
    credit,
    closing: debit,
  });
  const strip = (acc: Pick<AdAccountView, 'currency' | 'expenseAccountCode' | 'legalEntityId'>, seeds: Record<string, ReturnType<typeof ledger>> = {}, financeOn = true, list = months, todayMonth = '2026-11') => {
    for (const [period, data] of Object.entries(seeds)) {
      client.current.setQueryData(['ledger', 'account', { period, accountCode: acc.expenseAccountCode, legalEntityId: acc.legalEntityId }], data);
    }
    return render(<AdsBooksStrip account={acc} months={list} todayMonth={todayMonth} financeOn={financeOn} />);
  };
  const vnd = { currency: 'VND', expenseAccountCode: '6421', legalEntityId: 'e1' };

  it('draws nothing where the finance module is not installed', () => {
    expect(strip(vnd, {}, false)).toBe('');
  });

  it('asks for an expense account first, and compares nothing without one', () => {
    const html = strip({ ...vnd, expenseAccountCode: null });
    expect(html).toContain(`>${en.ads.books.title}<`);
    expect(html).toContain(en.ads.books.noCode);
    expect(html).not.toContain('<table');
  });

  it('does not put a foreign currency beside the books in dong, and says why', () => {
    const html = strip({ ...vnd, currency: 'USD' });
    expect(html).toContain(en.ads.books.notVnd.replace('{currency}', 'USD'));
    expect(html).not.toContain('<table');
  });

  it('shows, per month with spend, the platform, the books and the exact difference, and leaves out a month with no spend', () => {
    const html = strip(vnd, { '2026-09': ledger('11500000.0000'), '2026-11': ledger('2300000.0000', '100000.0000') });
    expect(html).toContain(`>${en.ads.books.title}<`);
    for (const head of [en.ads.columns.month, en.ads.books.platform, en.ads.books.inBooks, en.ads.books.difference]) expect(html).toContain(`>${head}<`);
    expect(html).toContain('6421 Chi phí bán hàng');
    expect(html).toContain('09/2026');
    expect(html).toContain('11/2026');
    expect(html).not.toContain('10/2026');
    // September: 12,000,000 on the platform against 11,500,000 in the books is 500,000 more.
    expect(html).toMatch(/12[.,]000[.,]000/);
    expect(html).toMatch(/11[.,]500[.,]000/);
    expect(html).toMatch(/500[.,]000/);
    // November: 2,000,000 against 2,300,000 debit less 100,000 credit, which is 2,200,000: 200,000 less.
    expect(html).toMatch(/2[.,]200[.,]000/);
    expect(html).toMatch(/-200[.,]000|-₫200[.,]000|₫-200[.,]000/);
    // The month that is still open says so, and the difference is shown, not explained away.
    expect(html.match(new RegExp(`>${en.ads.books.monthOpen}<`, 'g'))).toHaveLength(1);
    expect(html).toContain('only shows the difference');
  });

  it('leaves the year closing out of December, so the books hold the month and not the month less the year', () => {
    // December's spend is 4,000,000 and the books hold exactly that; the closing entry of 31 December credits the whole
    // year's 40,000,000 against 911, which is not December's expense.
    const html = strip(
      vnd,
      { '2026-12': ledger('4000000.0000', '0.0000', [row('0.0000', '40000000.0000', ['911'])]) },
      true,
      [{ month: '2026-12', spend: '4000000' }],
      '2027-01',
    );
    expect(html).toContain('12/2026');
    expect(html).toMatch(/4[.,]000[.,]000/);
    // Counted with the closing line the books would read -36,000,000 and the difference 40,000,000.
    expect(html).not.toMatch(/36[.,]000[.,]000/);
    expect(html).not.toMatch(/40[.,]000[.,]000/);
    expect(html).toContain('year-end closing entry to account 911 is left out');
    expect(html).not.toContain(`>${en.ads.books.monthOpen}<`);
  });

  it('waits for the ledger with a skeleton and does not draw a half-filled table', () => {
    const html = strip(vnd);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(`>${en.ads.books.platform}<`);
  });
});
