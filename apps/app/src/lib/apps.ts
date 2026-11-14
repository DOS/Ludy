// The apps of the shell (issue #1528; plan item 11: "App" in the product UI, with an app switcher in the shell). Each
// app has its own short menu, in groups; the switcher lists the apps whose module this deployment runs (CROVE_MODULES,
// ADR-0031), and an item of a module that is not installed is left out of its app. The org's own screens (the chart
// and AI, Settings) belong to no app: they sit at the foot of the switcher. Modules contribute the apps, groups and
// items through their manifests (MODULE_SCREENS, #1652); the shell keeps only how they look (the app icons, shorter
// names inside the menu, which groups carry a heading), which typecheck and module-screens.test.ts hold to the list.
import { MODULE_SCREENS, type ModuleScreens } from '@crove/kernel-contract';
import type { Messages } from '../i18n/messages/vi.ts';
import { installedItems } from './modules.ts';

// The names of the screens in the menus: a key of `nav` in the messages that holds a string (tab labels and Ctrl K names are these too).
export type NavMessage = { [K in keyof Messages['nav']]: Messages['nav'][K] extends string ? K : never }[keyof Messages['nav']];

type Screens = typeof MODULE_SCREENS;
export type ModuleId = keyof Screens;
type NavDecl = Screens[ModuleId]['nav'][number];
type AppNavDecl = Extract<NavDecl, { app: string }>;

export type AppId = AppNavDecl['app'];
export type AppGroupId = AppNavDecl['group'];
export type NavLabel = NavDecl['label'];
export interface NavItem {
  to: `/o/$slug/${NavDecl['path']}`;
  label: NavLabel;
  module: ModuleId;
  // Set for a screen that serves several modules (the reports, #2435): the item shows where any of them runs.
  modules?: readonly string[] | undefined;
}

export interface App {
  id: AppId;
  groups: readonly { id: AppGroupId; items: readonly NavItem[] }[];
}

const MODULES = Object.entries(MODULE_SCREENS) as Array<[ModuleId, ModuleScreens]>;
const item = (module: ModuleId, screens: ModuleScreens, nav: { path: string; label: string; modules?: readonly string[] }): NavItem => {
  const modules = nav.modules ?? screens.routes.find((route) => route.path === nav.path)?.modules;
  return { to: `/o/$slug/${nav.path}` as NavItem['to'], label: nav.label as NavLabel, module, ...(modules ? { modules } : {}) };
};

// The apps in the order of the switcher (#3225): Cộng tác, Tài chính, Engage, Nhân sự, Ludy AI. The overview is not an app: it is the first entry of the switcher, the notifications are
// the bell and Settings is at the foot.
export const APP_ORDER: readonly AppId[] = ['teamwork', 'finance', 'engage', 'hr', 'ai'];

// The groups of an app whose modules do not give the order: the Engage app's four groups come from three modules (#2435), so by
// the order their items first appear Marketing would come before CRM; Tài chính's groups come from the kernel and finance. Every other app keeps the order
// its items first appear in the manifests. module-screens.test.ts holds each group of such an app to this list.
export const GROUP_ORDER: Partial<Record<AppId, readonly AppGroupId[]>> = { engage: ['inbox', 'crm', 'marketing', 'reports'], finance: ['books', 'sell', 'buy', 'ledger'] };

// The items of an app in the order its menu shows them, by path, when the modules do not give it (Cộng tác: the member's own work first, then the team's; Tài chính: the overview and
// the documents first). An item not listed comes after the listed ones, in the order of the manifests.
export const ITEM_ORDER: Partial<Record<AppId, readonly string[]>> = {
  teamwork: ['my-work', 'tasks', 'notes', 'meetings'],
  finance: ['accounting', 'inbox', 'vouchers', 'bank', 'sales-invoices', 'customers', 'stock', 'vendors', 'journal', 'ledger', 'fixed-assets', 'vat'],
  ai: ['agents', 'ai-usage', 'ai-connections'],
};

// Every app with its groups, each in the order its first item appears in the manifests, unless GROUP_ORDER fixes it.
export const APPS: readonly App[] = (() => {
  const apps: Array<{ id: AppId; groups: Array<{ id: AppGroupId; items: NavItem[] }> }> = [];
  for (const [module, screens] of MODULES) {
    for (const nav of screens.nav) {
      if (nav.app === null) continue;
      let app = apps.find((a) => a.id === nav.app);
      if (!app) apps.push((app = { id: nav.app as AppId, groups: [] }));
      let group = app.groups.find((g) => g.id === nav.group);
      if (!group) app.groups.push((group = { id: nav.group as AppGroupId, items: [] }));
      group.items.push(item(module, screens, nav));
    }
  }
  for (const app of apps) {
    const order = GROUP_ORDER[app.id];
    if (order) app.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const items = ITEM_ORDER[app.id];
    if (items) {
      const rank = (entry: NavItem) => {
        const at = items.indexOf(entry.to.slice('/o/$slug/'.length));
        return at < 0 ? items.length : at;
      };
      for (const group of app.groups) group.items.sort((a, b) => rank(a) - rank(b));
    }
  }
  apps.sort((a, b) => APP_ORDER.indexOf(a.id) - APP_ORDER.indexOf(b.id));
  return apps;
})();

// The shell's own places (#3225): the overview, first in the switcher; the notifications, the bell; and the org's own screens (Settings) at the foot of the switcher, under every app.
const railItems = (rail: 'top' | 'bell' | 'foot'): readonly NavItem[] =>
  MODULES.flatMap(([module, screens]) => screens.nav.flatMap((nav) => (nav.app === null && nav.rail === rail ? [item(module, screens, nav)] : [])));
export const TOP_ITEMS: readonly NavItem[] = railItems('top');
export const BELL_ITEM: NavItem | undefined = railItems('bell')[0];
export const ADMIN_ITEMS: readonly NavItem[] = railItems('foot');

// The screens that are tabs of a menu item (#3225): the item opens on its first tab, and a strip over the screen switches between them. The screens keep their addresses. A tab label is a key under
// `nav` in the messages; `find` on the route of a tab that is not a menu item makes Ctrl K find it under that label.
export interface Tab {
  path: string;
  label: NavMessage;
}
export interface TabGroup {
  // The menu item the tabs belong to, by its path.
  menu: string;
  tabs: readonly Tab[];
}
export const TAB_GROUPS: readonly TabGroup[] = [
  { menu: 'inbox', tabs: [{ path: 'inbox', label: 'inbox' }, { path: 'documents', label: 'documentsAll' }] },
  { menu: 'customers', tabs: [{ path: 'customers', label: 'customers' }, { path: 'payment-reminders', label: 'paymentReminders' }] },
  { menu: 'stock', tabs: [{ path: 'stock', label: 'stockLevels' }, { path: 'marketplace', label: 'marketplace' }] },
  { menu: 'vat', tabs: [{ path: 'vat', label: 'vat' }, { path: 'portal-invoices', label: 'portalList' }] },
  { menu: 'hr/payroll', tabs: [{ path: 'hr/payroll', label: 'payroll' }, { path: 'hr/bank-templates', label: 'bankTemplates' }] },
  { menu: 'social', tabs: [{ path: 'social', label: 'socialPosts' }, { path: 'social/notifications', label: 'socialNotifications' }] },
  { menu: 'ads', tabs: [{ path: 'ads', label: 'adsFigures' }, { path: 'ads/campaigns', label: 'adsCampaigns' }] },
];

// The tab group a screen is a tab of: the path after /o/<slug>/, exactly (a screen under a tab, a post or an invoice, is not one).
export function tabGroupOfPath(pathname: string): TabGroup | null {
  const [, o, , ...rest] = pathname.split('/');
  if (o !== 'o') return null;
  const screen = rest.join('/').replace(/\/$/, '').toLowerCase();
  return TAB_GROUPS.find((group) => group.tabs.some((tab) => tab.path === screen)) ?? null;
}

// Screens that are no menu item and that Ctrl K finds all the same: a tab, or a screen reached from another (a route that names a `find` label).
const FIND_ITEMS: readonly NavItem[] = MODULES.flatMap(([module, screens]) =>
  screens.routes.flatMap((route) => ('find' in route && typeof route.find === 'string' ? [item(module, screens, { path: route.path, label: route.find })] : [])),
);

// The groups that carry a heading in the menu: the Engage app's areas of work and the Tài chính groups after its first. The reports group is one item, and the first group of the other apps is
// named by the app itself.
export type HeadedGroupId = 'inbox' | 'crm' | 'marketing' | 'sell' | 'buy' | 'ledger';
export function isHeadedGroup(id: AppGroupId): id is HeadedGroupId {
  return id === 'inbox' || id === 'crm' || id === 'marketing' || id === 'sell' || id === 'buy' || id === 'ledger';
}

// Every screen of the menus, apps first, for the command palette (Ctrl K searches all of them, whatever the app): the overview, the apps' items, the bell, Settings, and the tabs and inner
// screens that name a `find` label (Sàn, Hộ kinh doanh, Nhắc thu nợ...).
export const ALL_NAV: readonly NavItem[] = [...TOP_ITEMS, ...APPS.flatMap((a) => a.groups.flatMap((g) => g.items)), ...(BELL_ITEM ? [BELL_ITEM] : []), ...ADMIN_ITEMS, ...FIND_ITEMS];

export interface InstalledApp {
  id: AppId;
  // The first screen of the app, where the switcher goes.
  home: NavItem['to'];
  groups: readonly { id: AppGroupId; items: readonly NavItem[] }[];
}

// The apps this deployment runs, each with its installed items; an app left with no item is not listed.
export function installedApps(modules: readonly string[]): InstalledApp[] {
  return APPS.flatMap((app) => {
    const groups = app.groups.map((g) => ({ id: g.id, items: installedItems(modules, g.items) })).filter((g) => g.items.length > 0);
    const first = groups[0]?.items[0];
    return first ? [{ id: app.id, home: first.to, groups }] : [];
  });
}

// Screens reached from inside an app rather than from its menu (a route that names its app).
const INNER_SCREENS: ReadonlyMap<string, AppId> = new Map(
  MODULES.flatMap(([, screens]) => screens.routes.flatMap((route) => (route.app ? [[route.path.split('/')[0] as string, route.app as AppId] as const] : []))),
);

// The app a path (/o/<slug>/<screen>/...) belongs to, so a deep link opens with its app selected; null for the org's
// own screens (the chart, Settings, the audit log) and for paths outside an org.
export function appOfPath(pathname: string): AppId | null {
  const [, o, , rawScreen] = pathname.split('/');
  if (o !== 'o' || !rawScreen) return null;
  // The router matches without regard to case, so the shell does too.
  const screen = rawScreen.toLowerCase();
  for (const app of APPS) {
    for (const group of app.groups) {
      if (group.items.some((entry) => entry.to.split('/')[3] === screen)) return app.id;
    }
  }
  return INNER_SCREENS.get(screen) ?? null;
}
