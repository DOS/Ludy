// SPDX-License-Identifier: AGPL-3.0-only
// The words of Settings (#3590, ST-2, ST-4, ST-5, ST-7): the apps and modules it lists carry the names the shell shows, and no string an owner reads in Settings
// speaks of "the server" or a "sandbox", because an owner cannot act on either. Both catalogs are held to the same rules.
import { APP_IDS, MODULE_SCREENS, modulesOfApp, type AppId } from '@ludy/kernel-contract';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

const catalogs = [
  ['vi', vi],
  ['en', en],
] as const;

type Catalog = typeof vi | typeof en;

// Every namespace a Settings screen reads (the tabs of #3589, their cards and the meeting platform connections), dotted as the messages nest.
const SETTINGS_NAMESPACES = [
  'settings',
  'orgApps',
  'legalEntities',
  'approvalPreset',
  'taxCalendar',
  'bankAccountNumbers',
  'accounts',
  'misaGoods',
  'accountRules',
  'bankRules',
  'integrations',
  'bankFeeds',
  'einvoiceConnections',
  'marketplaceConnections',
  'misaAmisConnections',
  'twoFactor',
  'sessions',
  'extensionDevices',
  'orgExtensionDevices',
  'meetings.platform.settings',
  'meetings.platform.provider',
  'minutesTemplates',
  'conversations',
  'eventTypes',
  'workingHours',
  'quotes.settings',
  'deals.process',
  'offboarding',
] as const;

const at = (node: unknown, path: string): unknown => path.split('.').reduce<unknown>((n, part) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[part] : undefined), node);

function strings(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof node === 'string') out.push({ path, text: node });
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) strings(value, `${path}.${key}`, out);
}

// The words an owner cannot act on: the machine that runs Ludy, and the test mode of a connection.
const SERVER_WORDS = /máy chủ|sandbox|\bserver\b/i;

describe('Settings says nothing about the server or a sandbox to an owner (ST-4)', () => {
  for (const [name, catalog] of catalogs) {
    it(`has none of those words in the ${name} Settings strings`, () => {
      const all: { path: string; text: string }[] = [];
      for (const ns of SETTINGS_NAMESPACES) {
        expect(at(catalog, ns), `${name} ${ns} exists`).toBeDefined();
        strings(at(catalog, ns), ns, all);
      }
      expect(all.length).toBeGreaterThan(100);
      expect(all.filter((s) => SERVER_WORDS.test(s.text)).map((s) => `${s.path}: ${s.text}`)).toEqual([]);
    });

    it(`says who can turn on what the system has not (${name})`, () => {
      const ask = name === 'vi' ? 'người quản trị hệ thống' : 'system administrator';
      const c = catalog as Catalog;
      for (const [path, text] of [
        ['settings.inboundOff', c.settings.inboundOff],
        ['settings.inviteMailOff', c.settings.inviteMailOff],
        ['einvoiceConnections.states.ip_not_allowed', c.einvoiceConnections.states.ip_not_allowed],
        ['marketplaceConnections.testStates.ip_not_allowed', c.marketplaceConnections.testStates.ip_not_allowed],
        ['meetings.platform.settings.zoomNote', c.meetings.platform.settings.zoomNote],
        ['meetings.platform.settings.teamsNote', c.meetings.platform.settings.teamsNote],
      ] as const) {
        expect(text, `${name} ${path}`).toContain(ask);
      }
    });
  }

  it('names a device in the session list by what it is, not by "Phiên đăng nhập" and an id alone (ST-7)', () => {
    // The API records no browser or system for a session, so only the current device is described (describeUserAgent); another is "Another device" with a short code to tell two apart.
    expect(vi.sessions.session).toBe('Thiết bị khác (mã {id})');
    expect(en.sessions.session).toBe('Another device (code {id})');
    // An admin reading a member's sessions, and a revoked list, get a neutral name.
    expect(vi.sessions.sessionNamed).toBe('Thiết bị (mã {id})');
    expect(en.sessions.sessionNamed).toBe('Device (code {id})');
    expect(vi.sessions.thisDeviceNamed).toContain('{device}');
  });

  it('also keeps the import error of a recording without sound free of the word', () => {
    for (const [name, catalog] of catalogs) expect(catalog.meetings.platform.errors.no_audio, name).not.toMatch(SERVER_WORDS);
  });
});

describe('Settings and the shell agree on the names of the apps and their modules (ST-2)', () => {
  const nav = (catalog: Catalog) => catalog.nav as unknown as Record<string, unknown>;
  // The names the shell shows for a module's places: its menu items, the groups of the menus they sit in, its app, and the tab labels of its screens that are no item.
  const shellNames = (catalog: Catalog, module: keyof typeof MODULE_SCREENS): string[] => {
    const names: string[] = [];
    for (const decl of MODULE_SCREENS[module].nav) {
      const label = nav(catalog)[decl.label];
      if (typeof label === 'string') names.push(label);
      if (decl.app !== null) {
        const group = (catalog.nav.groups as Record<string, string>)[decl.group];
        if (group) names.push(group);
        names.push(catalog.nav.apps[decl.app as AppId]);
      }
    }
    if (module === 'social') names.push(catalog.nav.socialPosts);
    return names;
  };

  for (const [name, catalog] of catalogs) {
    it(`names each module in the ${name} catalog with words of its own places in the shell`, () => {
      const lookups = Object.keys(catalog.modules)
        .filter((id) => id !== 'kernel')
        .map((id) => ({ id, parts: (catalog.modules as Record<string, string>)[id]!.split(' & '), shell: shellNames(catalog, id as keyof typeof MODULE_SCREENS) }));
      expect(lookups.length).toBeGreaterThanOrEqual(9);
      expect(lookups.flatMap((l) => l.parts.filter((p) => !l.shell.includes(p)).map((p) => `${l.id}: "${p}" is not a shell name (${l.shell.join(', ')})`))).toEqual([]);
    });

    it(`never calls a module by an app name of its own in the ${name} catalog`, () => {
      // Engage holds the inbox, the posts, the CRM and the ads: "Social", "Quảng cáo" and "CRM" stay names of modules under it, never of an app.
      const apps = Object.values(catalog.nav.apps);
      expect(apps).not.toContain('Social');
      expect(apps).not.toContain(catalog.modules.ads);
      expect(apps).not.toContain(catalog.modules.crm);
      expect(Object.values(catalog.modules)).not.toContain('Social');
      for (const id of APP_IDS) expect(catalog.nav.apps[id], `${name} ${id}`).toBeTruthy();
    });
  }

  it('groups the modules under the app they belong to, in the order of the switcher', () => {
    expect(APP_IDS.map((id) => modulesOfApp(id))).toEqual([['notes', 'projects', 'meetings'], ['finance'], ['social', 'crm', 'ads'], ['hr'], ['sign'], []]);
  });
});
