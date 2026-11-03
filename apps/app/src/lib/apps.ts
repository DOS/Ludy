// The apps of the shell (issue #1528; plan item 11: "App" in the product UI, with an app switcher in the shell). Each
// app has its own short menu, in groups; the switcher lists the apps whose module this deployment runs (CROVE_MODULES,
// ADR-0031), and an item of a module that is not installed is left out of its app. The org's own screens (the chart
// and AI, Settings) belong to no app: they sit at the foot of the switcher. Modules contribute the apps, groups and
// items through their manifests (MODULE_SCREENS, #1652); the shell keeps only how they look (the app icons, shorter
// names inside the menu, which groups carry a heading), which typecheck and module-screens.test.ts hold to the list.
import { MODULE_SCREENS, type ModuleScreens } from '@crove/kernel-contract';
import { installedItems } from './modules.ts';

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
const item = (module: ModuleId, screens: ModuleScreens, nav: { path: string; label: string }): NavItem => {
  const modules = screens.routes.find((route) => route.path === nav.path)?.modules;
  return { to: `/o/$slug/${nav.path}` as NavItem['to'], label: nav.label as NavLabel, module, ...(modules ? { modules } : {}) };
};

// The groups of an app whose modules do not give the order: the Engage app's four groups come from three modules (#2435), so by
// the order their items first appear Marketing would come before Khách hàng & Bán hàng. Every other app keeps the order
// its items first appear in the manifests. module-screens.test.ts holds each group of such an app to this list.
export const GROUP_ORDER: Partial<Record<AppId, readonly AppGroupId[]>> = { social: ['inbox', 'sales', 'marketing', 'reports'] };

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
  }
  return apps;
})();

// The org's own screens, under every app.
export const ADMIN_ITEMS: readonly NavItem[] = MODULES.flatMap(([module, screens]) => screens.nav.flatMap((nav) => (nav.app === null ? [item(module, screens, nav)] : [])));

// The groups that carry a heading in the menu: the Engage app's three areas of work and the accounting groups after its
// first. The reports group is one item, and the first group of the other apps is named by the app itself.
export type HeadedGroupId = 'tax' | 'parties' | 'inbox' | 'sales' | 'marketing';
export function isHeadedGroup(id: AppGroupId): id is HeadedGroupId {
  return id === 'tax' || id === 'parties' || id === 'inbox' || id === 'sales' || id === 'marketing';
}

// Every screen of the menus, apps first, for the command palette (Ctrl K searches all of them, whatever the app).
export const ALL_NAV: readonly NavItem[] = [...APPS.flatMap((a) => a.groups.flatMap((g) => g.items)), ...ADMIN_ITEMS];

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
  const [, o, , screen] = pathname.split('/');
  if (o !== 'o' || !screen) return null;
  for (const app of APPS) {
    for (const group of app.groups) {
      if (group.items.some((entry) => entry.to.split('/')[3] === screen)) return app.id;
    }
  }
  return INNER_SCREENS.get(screen) ?? null;
}
