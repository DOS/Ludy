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
import type { AdAccountView, AdsChange, AdsSummary, AdsWriteState, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog, translatorFor } from '../src/i18n/runtime.ts';
import { adsChangeLine, adsChangeText } from '../src/lib/ads-change.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

// A link as an anchor that names where it leads: the route with its parameters filled in. The rest of the router stays the real
// one (the Ads page reads the address with it).
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_match, name: string) => params?.[name] ?? '') }, children),
  };
});

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
const { AdsWriteCard, CapForm, isCapAmount } = await import('../src/components/ads-write.tsx');
const { AdsProposalCard } = await import('../src/components/ads-proposal-card.tsx');

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

describe('running ads: the stops, the requests, the switches and the caps (#2294, W0a)', () => {
  const at2 = '2026-11-02T03:00:00.000Z';
  const stateOf = (over: Partial<AdsWriteState> = {}): AdsWriteState => ({ writeEnabled: false, launchesBlocked: false, updatedAt: null, caps: [], pending: [], ...over });
  const card = (state: AdsWriteState, role: 'owner' | 'admin', accounts: AdAccountView[] = [account()]) => {
    client.current.setQueryData(['ads', 'writeState'], state);
    return render(<AdsWriteCard role={role} accounts={accounts} slug="shop" />);
  };
  const cap = (over: Partial<AdsWriteState['caps'][number]>): AdsWriteState['caps'][number] => ({ scope: 'org', adAccountId: null, period: 'daily', amount: '5000000', currency: 'VND', setBy: 'u1', setAt: at2, ...over });
  const waiting = (proposalId: string, change: AdsChange): AdsWriteState['pending'][number] => ({ proposalId, change, requestedAt: at2 });
  const a2 = () => account({ id: 'a2', name: 'Tài khoản hai', writeEnabled: false });

  it('says it is off and lets the owner alone ask to turn it on: a request for the Inbox, never a button that turns it on', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf(), role);
      expect(html, role).toContain(`>${en.ads.write.off}<`);
      expect(html, role).toContain(en.ads.write.offHint);
      expect(html, role).not.toContain(`>${en.ads.write.disable}<`);
      expect(html, role).not.toContain(en.ads.write.accounts);
      expect(html, role).not.toContain(en.ads.write.pauseAll);
      expect(html, role).not.toContain(en.ads.write.pending);
    }
    const owner = card(stateOf(), 'owner');
    expect(buttonBefore(owner, en.ads.write.request)).toBeDefined();
    // Asking opens no confirmation and no second-factor prompt; it is not the change itself.
    expect(buttonBefore(owner, en.ads.write.request)).not.toContain('aria-haspopup');
    // The admin does not ask (the owner does, and an admin approves it in the Inbox).
    expect(card(stateOf(), 'admin')).not.toContain(`>${en.ads.write.request}<`);
  });

  it('shows what is on: the owner may turn it off behind a confirmation, an account off and ask to allow another, and owners and admins may stop it all', () => {
    const html = card(stateOf({ writeEnabled: true }), 'owner', [account({ writeEnabled: true }), a2()]);
    expect(html).toContain(`>${en.ads.write.on}<`);
    // Turned on: nothing to ask for at the top.
    expect(html).not.toContain(`>${en.ads.write.request}<`);
    expect(buttonBefore(html, en.ads.write.disable)).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain(en.ads.write.disableTitle);
    expect(html).toContain(en.ads.write.accounts);
    expect(html).toContain(`>${en.ads.write.accountOn}<`);
    expect(html).toContain(`>${en.ads.write.accountOff}<`);
    // One withdraw button, for the allowed account only, and one request to allow, for the other.
    expect(html.split(`>${en.ads.write.accountDisable}<`)).toHaveLength(2);
    expect(buttonBefore(html, en.ads.write.accountDisable)).toBeDefined();
    expect(html.split(`>${en.ads.write.accountRequest}<`)).toHaveLength(2);
    expect(buttonBefore(html, en.ads.write.accountRequest)).not.toContain('aria-haspopup');
    expect(buttonBefore(html, en.ads.write.pauseAll)).toContain('aria-haspopup="dialog"');
    // The admin: the state and the kill switch, none of the owner's stops and none of the owner's requests.
    const admin = card(stateOf({ writeEnabled: true }), 'admin', [account({ writeEnabled: true }), a2()]);
    expect(buttonBefore(admin, en.ads.write.pauseAll)).toBeDefined();
    expect(admin).not.toContain(`>${en.ads.write.accountRequest}<`);
    expect(admin).not.toContain(`>${en.ads.write.disable}<`);
    expect(admin).not.toContain(`>${en.ads.write.accountDisable}<`);
  });

  it('offers no request to allow an account while the org switch is off: the accounts list is not drawn', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf({ writeEnabled: false }), role, [a2()]);
      expect(html, role).not.toContain(en.ads.write.accounts);
      expect(html, role).not.toContain(`>${en.ads.write.accountRequest}<`);
    }
  });

  it('says launches are blocked and lets the owner alone ask to open them again; the kill switch is not offered while blocked', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf({ writeEnabled: true, launchesBlocked: true }), role);
      expect(html, role).toContain(en.ads.write.blocked);
      expect(html, role).not.toContain(`>${en.ads.write.pauseAll}<`);
    }
    const owner = card(stateOf({ writeEnabled: true, launchesBlocked: true }), 'owner');
    expect(buttonBefore(owner, en.ads.write.unblockRequest)).toBeDefined();
    expect(buttonBefore(owner, en.ads.write.unblockRequest)).not.toContain('aria-haspopup');
    expect(card(stateOf({ writeEnabled: true, launchesBlocked: true }), 'admin')).not.toContain(`>${en.ads.write.unblockRequest}<`);
    // Without a block there is nothing to open again.
    expect(card(stateOf({ writeEnabled: true }), 'owner')).not.toContain(`>${en.ads.write.unblockRequest}<`);
  });

  it('says "request sent" in place of a button for what already waits in the Inbox, so the same request is not made twice', () => {
    const enabling = card(stateOf({ pending: [waiting('p1', { change: 'write_enable' })] }), 'owner');
    expect(enabling).toContain(`>${en.ads.write.waitingBadge}<`);
    expect(enabling).not.toContain(`>${en.ads.write.request}<`);
    const unblocking = card(stateOf({ writeEnabled: true, launchesBlocked: true, pending: [waiting('p2', { change: 'launches_unblock' })] }), 'owner');
    expect(unblocking).toContain(`>${en.ads.write.waitingBadge}<`);
    expect(unblocking).not.toContain(`>${en.ads.write.unblockRequest}<`);
    // One account: a2 waits (its id may be spelled in capitals by the payload), a1 can still be asked for.
    const accounts = card(stateOf({ writeEnabled: true, pending: [waiting('p3', { change: 'account_enable', adAccountId: 'A2', adAccountName: 'Tài khoản hai' })] }), 'owner', [account(), a2()]);
    expect(accounts.split(`>${en.ads.write.waitingBadge}<`)).toHaveLength(2);
    expect(accounts.split(`>${en.ads.write.accountRequest}<`)).toHaveLength(2);
  });

  it('lists the requests waiting for approval, one line each, with the cap and its earlier value, and a link to each Inbox item', () => {
    const pending = [
      waiting('p1', { change: 'write_enable' }),
      waiting('p2', { change: 'account_enable', adAccountId: 'a2', adAccountName: 'Tài khoản hai' }),
      waiting('p3', { change: 'cap_set', scope: 'account', adAccountId: 'a1', adAccountName: 'Quảng cáo cửa hàng', period: 'monthly', amount: '8000000', currency: 'VND', previous: '5000000', previousCurrency: 'VND' }),
      waiting('p4', { change: 'cap_set', scope: 'org', adAccountId: null, adAccountName: null, period: 'daily', amount: '2000000', currency: 'VND', previous: null, previousCurrency: null }),
      waiting('p5', { change: 'launches_unblock' }),
    ];
    for (const role of ['owner', 'admin'] as const) {
      const html = card(stateOf({ pending }), role, [account(), a2()]);
      expect(html, role).toContain(`>${en.ads.write.pending}<`);
      expect(html, role).toContain(en.ads.write.pendingHint);
      expect(html.split(`>${en.ads.write.pendingOpen}<`), role).toHaveLength(pending.length + 1);
      for (const proposal of pending) expect(html, `${role} ${proposal.proposalId}`).toContain(`href="/o/shop/inbox/${proposal.proposalId}"`);
      expect(html, role).toContain(en.ads.change.writeEnable);
      expect(html, role).toContain('Allow running ads on the account Tài khoản hai.');
      expect(html, role).toContain('Set the monthly spend cap of the account Quảng cáo cửa hàng.');
      // The earlier value and the new one, each with its currency; a first cap says there was none.
      expect(html, role).toMatch(/From [^<]*5,000,000[^<]* to [^<]*8,000,000/);
      expect(html, role).toContain('Set the daily spend cap of the whole org.');
      expect(html, role).toMatch(/No cap is set yet; this sets the first one: [^<]*2,000,000/);
      expect(html, role).toContain(en.ads.change.launchesUnblock);
      // One line each: the longer explanation belongs to the Inbox card, not to this list.
      expect(html, role).not.toContain(en.ads.change.writeEnableDetail);
      expect(html, role).not.toContain(en.ads.change.launchesUnblockDetail);
    }
  });

  it('draws no waiting list when nothing waits', () => {
    expect(card(stateOf({ writeEnabled: true }), 'owner')).not.toContain(`>${en.ads.write.pending}<`);
  });

  it('lists the caps of the org and of each account in their currency and "not set" where there is none', () => {
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
    }
  });

  it('offers the owner the form to ask for a cap and the choice to lower one at once, and the admin neither', () => {
    const state = stateOf({ caps: [cap({})] });
    const owner = card(state, 'owner');
    expect(owner).toContain(`aria-label="${en.ads.write.capForm}"`);
    expect(owner).toContain('<input');
    expect(buttonBefore(owner, en.ads.write.capRequest)).toBeDefined();
    // The cap in force beside the form: the org's daily one is the form's first choice.
    expect(owner).toMatch(new RegExp(`${en.ads.write.capInForce.replace('{amount}', '[^<]*5,000,000')}`));
    expect(owner).not.toContain(`>${en.ads.write.capLower}<`);
    expect(owner).toContain(`>${en.ads.write.capAction}<`);
    expect(owner).toContain(`>${en.ads.write.capActions.raise}<`);
    expect(owner).toContain(`>${en.ads.write.capActions.lower}<`);
    // The admin reads the caps and approves a request in the Inbox; the form is the owner's.
    const admin = card(state, 'admin');
    expect(admin).not.toContain(`aria-label="${en.ads.write.capForm}"`);
    expect(admin).not.toContain('<input');
    expect(admin).not.toContain(en.ads.write.capActions.lower);
  });

  describe('the cap form on its own', () => {
    const accounts = [account(), account({ id: 'a2', name: 'Tài khoản chưa cập nhật', currency: null })];
    const form = (props: Partial<Parameters<typeof CapForm>[0]> = {}, locale: 'en' | 'vi' = 'en') =>
      render(<CapForm owner accounts={accounts} caps={[cap({})]} pending={[]} orgCurrency="VND" {...props} />, locale);

    it('asks to set or raise: the button asks, the currency is typed for the org, and an account without a known currency is not offered', () => {
      const org = form();
      expect(buttonBefore(org, en.ads.write.capRequest)).toBeDefined();
      expect(org).not.toContain(`>${en.ads.write.capLower}<`);
      expect(org).toContain(`>${en.ads.write.capCurrency}<`);
      expect(org).not.toContain(en.ads.write.capLowerHint);
      const account1 = form({ initial: { scope: 'account' } });
      expect(account1).toContain('>Quảng cáo cửa hàng<');
      expect(account1).not.toContain('Tài khoản chưa cập nhật');
      // The account's own currency stands in for the typed one.
      expect(account1).not.toContain(`>${en.ads.write.capCurrency}<`);
      expect(account1).toContain(en.ads.write.capAccountCurrency.replace('{currency}', 'VND'));
    });

    it('says why there is no account to choose while none has a known currency', () => {
      const html = form({ accounts: [account({ currency: null })], initial: { scope: 'account' } });
      expect(html).toContain(en.ads.write.capNoCurrency);
    });

    it('says a request for the same cap waits already, and says nothing for another scope or period', () => {
      const same = { proposalId: 'p9', requestedAt: at2, change: { change: 'cap_set', scope: 'org', adAccountId: null, adAccountName: null, period: 'daily', amount: '9000000', currency: 'VND', previous: '5000000', previousCurrency: 'VND' } } as const;
      expect(form({ pending: [same] })).toContain(en.ads.write.capRequestOpen);
      expect(form({ pending: [{ ...same, change: { ...same.change, period: 'monthly' } }] })).not.toContain(en.ads.write.capRequestOpen);
      expect(form({ pending: [{ ...same, change: { ...same.change, scope: 'account', adAccountId: 'a1', adAccountName: 'Quảng cáo cửa hàng' } }] })).not.toContain(en.ads.write.capRequestOpen);
      // The same cap of one account is the form's choice once it is the account scope.
      expect(form({ pending: [{ ...same, change: { ...same.change, scope: 'account', adAccountId: 'A1', adAccountName: 'Quảng cáo cửa hàng' } }], initial: { scope: 'account' } })).toContain(en.ads.write.capRequestOpen);
    });

    it('lowers at once, for the owner: its own button and hint, no typed currency, any account, and the cap in force beside it', () => {
      const html = form({ initial: { mode: 'lower' } });
      expect(buttonBefore(html, en.ads.write.capLower)).toBeDefined();
      expect(html).not.toContain(`>${en.ads.write.capRequest}<`);
      expect(html).toContain(en.ads.write.capLowerHint);
      expect(html).not.toContain(`>${en.ads.write.capCurrency}<`);
      expect(html).toMatch(/In force now: [^<]*5,000,000/);
      // Lowering also takes an account whose currency is unknown: the cap in force carries its own.
      expect(form({ initial: { mode: 'lower', scope: 'account' } })).toContain('Tài khoản chưa cập nhật');
    });

    it('does not let the owner lower a cap to the same amount or above it: submit is off and says why, however the amount is spelled', () => {
      // The cap in force is 5,000,000: the same amount, the same with decimals, and a larger one are not a lowering.
      for (const amount of ['5000000', '5000000.00', '5000000.5', '6000000']) {
        const html = form({ initial: { mode: 'lower', amount } });
        expect(buttonBefore(html, en.ads.write.capLower), amount).toContain('disabled');
        expect(html, amount).toContain(en.ads.write.capNotBelow);
      }
      // A lower amount is allowed, and nothing is said.
      for (const amount of ['4999999.99', '1']) {
        const html = form({ initial: { mode: 'lower', amount } });
        expect(buttonBefore(html, en.ads.write.capLower), amount).not.toContain('disabled');
        expect(html, amount).not.toContain(en.ads.write.capNotBelow);
      }
      // Asking for a raise is another matter: the same amount is not judged here (the server says it is not a raise).
      expect(form({ initial: { amount: '5000000' } })).not.toContain(en.ads.write.capNotBelow);
      // The same words in Vietnamese.
      expect(form({ initial: { mode: 'lower', amount: '5000000' } }, 'vi')).toContain(viMessages.ads.write.capNotBelow);
    });

    it('says there is no cap in force to lower, or to compare with, where none is set', () => {
      expect(form({ caps: [], initial: { mode: 'lower' } })).toContain(en.ads.write.capNoneYet);
      expect(form({ caps: [] })).toContain(en.ads.write.capNoneYet);
      expect(form()).not.toContain(en.ads.write.capNoneYet);
    });

    it('never offers lowering to an admin, even where the form starts in that mode', () => {
      const html = form({ owner: false, initial: { mode: 'lower' } });
      expect(html).not.toContain(`>${en.ads.write.capLower}<`);
      expect(html).not.toContain(en.ads.write.capLowerHint);
      expect(buttonBefore(html, en.ads.write.capRequest)).toBeDefined();
    });

    it('has the form words in Vietnamese', () => {
      const html = form({ initial: { mode: 'lower' } }, 'vi');
      expect(html).toContain(`aria-label="${viMessages.ads.write.capForm}"`);
      expect(html).toContain(`>${viMessages.ads.write.capLower}<`);
      expect(html).toContain(viMessages.ads.write.capLowerHint);
    });
  });

  it('accepts as a cap a decimal above zero with at most two decimals, as the server does', () => {
    for (const text of ['1', '5000000', '1.5', '20.50', ' 12 ', '0.01', '999999999999999']) expect(isCapAmount(text), text).toBe(true);
    for (const text of ['', '0', '0.00', '00', '-1', '1.234', '1,5', '1e6', 'abc', '1.', '.5', '1000000000000000']) expect(isCapAmount(text), text).toBe(false);
  });

  it('has the same words in Vietnamese as in English for the card', () => {
    client.current.setQueryData(['ads', 'writeState'], stateOf({ writeEnabled: true, pending: [waiting('p1', { change: 'launches_unblock' })] }));
    const vi = render(<AdsWriteCard role="owner" accounts={[account({ writeEnabled: true }), a2()]} slug="shop" />, 'vi');
    expect(vi).toContain(viMessages.ads.write.title);
    expect(vi).toContain(viMessages.ads.write.pauseAll);
    expect(vi).toContain(`>${viMessages.ads.write.pending}<`);
    expect(vi).toContain(viMessages.ads.change.launchesUnblock);
    expect(vi).toContain(`>${viMessages.ads.write.accountRequest}<`);
    expect(Object.keys(viMessages.ads.write).sort()).toEqual(Object.keys(en.ads.write).sort());
    expect(Object.keys(viMessages.ads.write.capActions).sort()).toEqual(Object.keys(en.ads.write.capActions).sort());
    expect(Object.keys(viMessages.ads.change).sort()).toEqual(Object.keys(en.ads.change).sort());
  });
});

// What a request about running ads says, from the change the server read of it (ads.write.state, ads.proposal.change).
describe('the words of a request about running ads (#2294)', () => {
  const money = (amount: string, currency: string) => `${amount} ${currency}`;
  const capChange = (over: Partial<Extract<AdsChange, { change: 'cap_set' }>> = {}): AdsChange => ({
    change: 'cap_set',
    scope: 'account',
    adAccountId: 'a1',
    adAccountName: 'Shop',
    period: 'monthly',
    amount: '8000000',
    currency: 'VND',
    previous: '5000000',
    previousCurrency: 'VND',
    ...over,
  });

  it('says each change in one sentence, in English and in Vietnamese', () => {
    const inEn = translatorFor('en');
    const inVi = translatorFor('vi');
    expect(adsChangeText({ change: 'write_enable' }, inEn, money)).toEqual({ title: 'Turn on running ads for the org.', detail: en.ads.change.writeEnableDetail });
    expect(adsChangeText({ change: 'write_enable' }, inVi, money).title).toBe('Bật chạy quảng cáo cho tổ chức.');
    expect(adsChangeText({ change: 'account_enable', adAccountId: 'a1', adAccountName: 'Shop' }, inEn, money).title).toBe('Allow running ads on the account Shop.');
    expect(adsChangeText({ change: 'account_enable', adAccountId: 'a1', adAccountName: 'Shop' }, inVi, money).title).toBe('Cho phép chạy quảng cáo trên tài khoản Shop.');
    expect(adsChangeText({ change: 'launches_unblock' }, inEn, money).title).toBe('Open running ads again after the block.');
    expect(adsChangeText({ change: 'launches_unblock' }, inVi, money).title).toBe('Mở lại việc chạy quảng cáo sau khi bị chặn.');
  });

  it('says a cap with its scope, its period and its amounts from the earlier value to the new one, each in its own currency', () => {
    const inEn = translatorFor('en');
    const inVi = translatorFor('vi');
    expect(adsChangeText(capChange(), inEn, money)).toEqual({ title: 'Set the monthly spend cap of the account Shop.', detail: 'From 5000000 VND to 8000000 VND.' });
    expect(adsChangeText(capChange(), inVi, money)).toEqual({ title: 'Đặt hạn mức chi tiêu quảng cáo theo tháng của tài khoản Shop.', detail: 'Từ 5000000 VND thành 8000000 VND.' });
    expect(adsChangeText(capChange({ scope: 'org', adAccountId: null, adAccountName: null, period: 'daily' }), inEn, money).title).toBe('Set the daily spend cap of the whole org.');
    expect(adsChangeText(capChange({ scope: 'org', adAccountId: null, adAccountName: null, period: 'daily' }), inVi, money).title).toBe('Đặt hạn mức chi tiêu quảng cáo theo ngày của cả tổ chức.');
    // A cap in another currency than the one in force reads as it was: the earlier amount in its own currency.
    expect(adsChangeText(capChange({ currency: 'USD', amount: '300', previous: '5000000', previousCurrency: 'VND' }), inEn, money).detail).toBe('From 5000000 VND to 300 USD.');
    // The first cap has no earlier value to compare with.
    expect(adsChangeText(capChange({ previous: null, previousCurrency: null }), inEn, money).detail).toBe('No cap is set yet; this sets the first one: 8000000 VND.');
    expect(adsChangeText(capChange({ previous: null, previousCurrency: null }), inVi, money).detail).toBe('Hiện chưa có hạn mức nào; đây là hạn mức đầu tiên: 8000000 VND.');
  });

  it('keeps the list to one line: a cap carries its amounts, the others the sentence alone', () => {
    const inEn = translatorFor('en');
    expect(adsChangeLine({ change: 'write_enable' }, inEn, money)).toBe('Turn on running ads for the org.');
    expect(adsChangeLine(capChange(), inEn, money)).toBe('Set the monthly spend cap of the account Shop. From 5000000 VND to 8000000 VND.');
  });
});

// The Inbox card of such a request: what changes if it is approved, from ads.proposal.change.
describe('the Inbox card of a request about running ads (#2294)', () => {
  const title = 'Đặt hạn mức chi tiêu quảng cáo theo ngày của cả tổ chức: 5000000 VND';
  const card = (change: AdsChange | null, locale: 'en' | 'vi' = 'en') => {
    client.current.setQueryData(['ads', 'proposal', { id: 'p1' }], { change });
    return render(<AdsProposalCard id="p1" title={title} slug="shop" />, locale);
  };

  it('says what changes in one clear sentence, with the cap from its earlier value to the new one and the currency', () => {
    const html = card({ change: 'cap_set', scope: 'org', adAccountId: null, adAccountName: null, period: 'daily', amount: '8000000', currency: 'VND', previous: '5000000', previousCurrency: 'VND' });
    expect(html).toContain(`>${en.inboxDetail.adsChange}<`);
    expect(html).toContain('Set the daily spend cap of the whole org.');
    expect(html).toMatch(/From [^<]*5,000,000[^<]* to [^<]*8,000,000[^<]*\./);
    // The server's own Vietnamese title is not the card's words.
    expect(html).not.toContain('Đặt hạn mức');
  });

  it('words each of the other changes', () => {
    expect(card({ change: 'write_enable' })).toContain(`>${en.ads.change.writeEnable}<`);
    expect(card({ change: 'write_enable' })).toContain(en.ads.change.writeEnableDetail);
    expect(card({ change: 'account_enable', adAccountId: 'a1', adAccountName: 'Shop' })).toContain('Allow running ads on the account Shop.');
    expect(card({ change: 'launches_unblock' })).toContain(`>${en.ads.change.launchesUnblock}<`);
    expect(card({ change: 'cap_set', scope: 'account', adAccountId: 'a1', adAccountName: 'Shop', period: 'monthly', amount: '1.50', currency: 'USD', previous: null, previousCurrency: null })).toContain(
      'Set the monthly spend cap of the account Shop.',
    );
  });

  it('shows the title alone for a request the server could not read', () => {
    const html = card(null);
    expect(html).toContain(`>${title}<`);
    expect(html).not.toContain('<p class="text-base');
    expect(html).not.toContain(en.ads.change.writeEnable);
  });

  it('waits for the answer with a skeleton, never a lone spinner', () => {
    const html = render(<AdsProposalCard id="other" title={title} slug="shop" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
  });

  it('links to the Ads screen of the org and speaks Vietnamese to a reader of Vietnamese', () => {
    const html = card({ change: 'launches_unblock' }, 'vi');
    expect(html).toContain('href="/o/shop/ads"');
    expect(html).toContain(`>${viMessages.inboxDetail.adsOpenScreen}<`);
    expect(html).toContain(`>${viMessages.inboxDetail.adsChange}<`);
    expect(html).toContain(`>${viMessages.ads.change.launchesUnblock}<`);
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
