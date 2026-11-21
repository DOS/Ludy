// SPDX-License-Identifier: AGPL-3.0-only
// Settings in tabs (ST-1, #3589): the strip the shell draws, the address of each tab, where an old link to the single page lands, and that every link in the app that names a card of
// Settings lands on the tab that holds it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_SCREENS } from '@ludy/kernel-contract';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { ALL_NAV, TAB_GROUPS, currentMenuItem, tabGroupOfPath } from '../src/lib/apps.ts';
import { installedItems } from '../src/lib/modules.ts';
import { CARD_TAB, SETTINGS_CARD, SETTINGS_TABS, SETTINGS_TAB_PATH, SETTINGS_TAB_TO, legacySettingsTab } from '../src/routes/settings/tabs.ts';

const session = vi.hoisted(() => ({ modules: ['kernel'] as string[] }));
vi.mock('../src/lib/auth.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/auth.ts')>()),
  accessToken: async () => 'token',
  needsSecondFactor: async () => false,
  getConfig: () => ({ modules: session.modules }),
}));

type Router = (typeof import('../src/router.tsx'))['router'];
let router: Router;
beforeAll(async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  vi.stubGlobal('window', { location: { origin: 'http://localhost', hash: '', pathname: '/', search: '' }, addEventListener() {}, removeEventListener() {}, localStorage: storage, sessionStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  ({ router } = await import('../src/router.tsx'));
}, 30_000);

const group = TAB_GROUPS.find((g) => g.menu === 'settings');

describe('the tab strip of Settings', () => {
  it('has the eleven tabs, the first on the address Settings always had', () => {
    expect(group?.tabs.map((tab) => tab.path)).toEqual(SETTINGS_TABS.map((tab) => SETTINGS_TAB_PATH[tab]));
    expect(group?.tabs[0]?.path).toBe('settings');
    expect(group?.tabs.map((tab) => tab.label)).toEqual(['org', 'settingsMembers', 'settingsApps', 'settingsBookings', 'settingsSales', 'settingsQuotes', 'settingsAccounting', 'settingsConnections', 'settingsNotifications', 'settingsSecurity', 'settingsData']);
  });

  it('names every tab in both languages, with the words of the issue', () => {
    expect(group?.tabs.map((tab) => viMessages.nav[tab.label])).toEqual(['Tổ chức', 'Thành viên và quyền', 'Ứng dụng', 'Lịch hẹn', 'Bán hàng', 'Báo giá', 'Kế toán và thuế', 'Kết nối', 'Thông báo của tôi', 'Bảo mật tài khoản', 'Dữ liệu và xóa tổ chức']);
    expect(group?.tabs.map((tab) => en.nav[tab.label])).toEqual(['Organization', 'Members and roles', 'Apps', 'Bookings', 'Sales', 'Quotes', 'Accounting and tax', 'Connections', 'My notifications', 'Account security', 'Data and deleting the organization']);
  });

  it('gives each tab its own address, and Settings stays the one menu item lit on all of them', () => {
    for (const tab of SETTINGS_TABS) {
      const path = SETTINGS_TAB_PATH[tab];
      expect(tabGroupOfPath(`/o/acme/${path}`)?.menu, path).toBe('settings');
      expect(currentMenuItem(`/o/acme/${path}`), path).toBe('/o/$slug/settings');
      expect(SETTINGS_TAB_TO[tab]).toBe(`/o/$slug/${path}`);
      expect(MODULE_SCREENS.kernel.routes.map((route) => route.path), path).toContain(path);
    }
  });

  it('shows the accounting tab only where finance runs, the sales and quotes tabs where crm runs, and the connections tab where finance runs', () => {
    const tabsFor = (modules: string[]) => installedItems(modules, ALL_NAV).filter((item) => group?.tabs.some((tab) => `/o/$slug/${tab.path}` === item.to)).map((item) => item.to.replace('/o/$slug/', ''));
    expect(tabsFor(['kernel'])).toEqual(['settings', 'settings/members', 'settings/apps', 'settings/bookings', 'settings/notifications', 'settings/security', 'settings/data']);
    expect(tabsFor(['kernel', 'crm'])).toContain('settings/sales');
    expect(tabsFor(['kernel', 'crm'])).toContain('settings/quotes');
    expect(tabsFor(['kernel', 'finance'])).not.toContain('settings/sales');
    expect(tabsFor(['kernel', 'finance'])).toContain('settings/accounting');
    expect(tabsFor(['kernel', 'finance'])).toContain('settings/connections');
    expect(tabsFor(['kernel', 'meetings'])).not.toContain('settings/connections');
    expect(tabsFor(['kernel', 'meetings'])).not.toContain('settings/accounting');
  });

  it('draws the strip so a phone scrolls it sideways instead of stacking seven tabs', () => {
    const strip = readFileSync(new URL('../src/components/screen-tabs.tsx', import.meta.url), 'utf8');
    expect(strip).toMatch(/<ul [^>]*className="[^"]*overflow-x-auto/);
    expect(strip).toMatch(/whitespace-nowrap/);
  });
});

describe('a card of Settings sits in one tab', () => {
  it('maps every linkable card to a tab of the strip', () => {
    for (const [id, tab] of Object.entries(CARD_TAB)) expect(SETTINGS_TABS, id).toContain(tab);
    expect(Object.keys(CARD_TAB).toSorted()).toEqual(Object.values(SETTINGS_CARD).toSorted());
  });
});

describe('an old link to the single Settings page', () => {
  it('lands on the tab that holds the card it named', () => {
    expect(legacySettingsTab('#settings-members', {})).toBe('members');
    expect(legacySettingsTab('booking-settings', {})).toBe('bookings');
    expect(legacySettingsTab('#booking-event-types', {})).toBe('bookings');
    expect(legacySettingsTab('#quote-settings', {})).toBe('quotes');
    expect(legacySettingsTab('#sales-process', {})).toBe('sales');
    expect(legacySettingsTab('#bank-account-numbers', {})).toBe('connections');
    expect(legacySettingsTab('#integrations', {})).toBe('connections');
    expect(legacySettingsTab('#chart-of-accounts', {})).toBe('accounting');
    expect(legacySettingsTab('', { invite: 'ke.toan@example.test' })).toBe('members');
  });

  it('stays on the first tab when it names nothing that moved', () => {
    expect(legacySettingsTab('', {})).toBeNull();
    expect(legacySettingsTab('#unknown-card', {})).toBeNull();
    expect(legacySettingsTab('#legal-entities', {})).toBeNull();
    expect(legacySettingsTab('#tax-profile', {})).toBeNull();
  });

  const lands = async (address: string) => {
    const r = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [address] }), isServer: false });
    await r.load();
    return `${r.state.location.pathname}${r.state.location.searchStr}${r.state.location.hash ? `#${r.state.location.hash.replace(/^#/, '')}` : ''}`;
  };

  it('is sent there by the router, keeping the fragment and the invited address', async () => {
    session.modules = ['kernel', 'finance', 'social', 'crm', 'meetings'];
    expect(await lands('/o/acme/settings')).toBe('/o/acme/settings');
    expect(await lands('/o/acme/settings#quote-settings')).toBe('/o/acme/settings/quotes#quote-settings');
    expect(await lands('/o/acme/settings#booking-event-types')).toBe('/o/acme/settings/bookings#booking-event-types');
    expect(await lands('/o/acme/settings#integrations')).toBe('/o/acme/settings/connections#integrations');
    expect(await lands('/o/acme/settings#settings-members')).toBe('/o/acme/settings/members#settings-members');
    expect(await lands('/o/acme/settings?invite=ke.toan%40example.test')).toBe('/o/acme/settings/members?invite=ke.toan%40example.test');
    for (const tab of SETTINGS_TABS) expect(await lands(`/o/acme/${SETTINGS_TAB_PATH[tab]}`)).toBe(`/o/acme/${SETTINGS_TAB_PATH[tab]}`);
  });

  // The preferences left the bell's screen for a card of the security tab (#3592); the daily brief mail's turn-off link, written by the kernel, still opens `notifications?todayMail=off`.
  it('sends the daily brief mail link and the bell to where the preferences are', async () => {
    session.modules = ['kernel'];
    expect(await lands('/o/acme/notifications?todayMail=off')).toBe('/o/acme/settings/notifications?todayMail=off#daily-brief-mail');
    expect(await lands('/o/acme/notifications')).toBe('/o/acme/notifications');
    // Only `off` is a link the mail writes: any other value stays on the bell's screen.
    expect(await lands('/o/acme/notifications?todayMail=on')).toBe('/o/acme/notifications?todayMail=on');
    expect(await lands('/o/acme/settings#notification-settings')).toBe('/o/acme/settings/notifications#notification-settings');
    expect(CARD_TAB[SETTINGS_CARD.notifications]).toBe('notifications');
    expect(CARD_TAB[SETTINGS_CARD.todayMail]).toBe('notifications');
  });

  it('opens the accounting, connections and sales tabs only where their apps run', async () => {
    session.modules = ['kernel', 'crm'];
    expect(await lands('/o/acme/settings/accounting')).toBe('/o/acme/overview');
    expect(await lands('/o/acme/settings/connections')).toBe('/o/acme/overview');
    expect(await lands('/o/acme/settings/sales')).toBe('/o/acme/settings/sales');
    expect(await lands('/o/acme/settings/quotes')).toBe('/o/acme/settings/quotes');
    expect(await lands('/o/acme/settings/apps')).toBe('/o/acme/settings/apps');
    session.modules = ['kernel', 'finance'];
    expect(await lands('/o/acme/settings/sales')).toBe('/o/acme/overview');
    expect(await lands('/o/acme/settings/quotes')).toBe('/o/acme/overview');
    expect(await lands('/o/acme/settings/accounting')).toBe('/o/acme/settings/accounting');
  });
});

// Every `<Link to="/o/$slug/settings...">` of the app, with the card it names, must go to the tab that holds the card; a link that names none goes to a tab of its own choosing.
describe('every link of the app to a card of Settings', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : name.endsWith('.tsx') ? [path] : [];
    });
  // The constants a link may pass as its hash, by name.
  const CONSTANTS: Record<string, string> = {
    QUOTE_SETTINGS_ID: SETTINGS_CARD.quoteSettings,
    SALES_PROCESS_ID: SETTINGS_CARD.salesProcess,
    BOOKING_SETTINGS_ID: SETTINGS_CARD.bookingSettings,
    BOOKING_EVENT_TYPES_ID: SETTINGS_CARD.bookingEventTypes,
    NOTIFICATION_SETTINGS_ID: SETTINGS_CARD.notifications,
  };
  const links = files(src)
    .filter((path) => !path.includes(`${join('routes', 'settings')}`))
    .flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/<Link to="\/o\/\$slug\/(settings[a-z/]*)"([^>]*)>/g)].map((m) => {
        const hash = /hash=(?:"([^"]+)"|\{([A-Z_]+)\})/.exec(m[2] as string);
        return { path: path.slice(src.length + 1), to: m[1] as string, hash: hash?.[1] ?? (hash?.[2] ? CONSTANTS[hash[2]] : undefined) };
      }),
    );

  it('finds the links the app has', () => {
    expect(links.length).toBeGreaterThan(10);
    // The cards other screens name: the quotes, the sales process, the booking cards, the integrations, the chart, the bank numbers, the tax profile, the meeting platforms.
    expect(new Set(links.flatMap((l) => (l.hash ? [l.hash] : []))).size).toBeGreaterThanOrEqual(8);
  });

  it('sends a link that names a card to the tab of that card', () => {
    for (const link of links.filter((l) => l.hash)) {
      const tab = CARD_TAB[link.hash as string];
      expect(tab, `${link.path} #${link.hash} names no card`).toBeDefined();
      expect(link.to, `${link.path} #${link.hash}`).toBe(SETTINGS_TAB_PATH[tab as keyof typeof SETTINGS_TAB_PATH]);
    }
  });

  it('has no link left on the first tab for a card that moved', () => {
    for (const link of links.filter((l) => l.to === 'settings')) expect(link.hash === undefined || CARD_TAB[link.hash] === 'org', `${link.path} #${link.hash}`).toBe(true);
  });
});
