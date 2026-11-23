// SPDX-License-Identifier: AGPL-3.0-only
// Pure builders for OrgLayout's Cmd+K recent entries and inline quick actions (#4525).
import { LOCALE_NAMES, LOCALES, type Locale } from '../i18n/locale.ts';
import { ALL_NAV, type NavItem, type NavMessage, type ShellVisibility } from './apps.ts';
import type { PaletteEntry } from './palette.ts';
import {
  detailSectionKeyForPath,
  filterVisibleRecentItems,
  stripSearchAndHash,
  type RecentItem,
} from './palette-recents.ts';
import { THEMES, type ThemeSetting } from './theme.ts';

const NAV_BY_PATH: ReadonlyMap<string, NavItem> = (() => {
  const map = new Map<string, NavItem>();
  for (const item of ALL_NAV) {
    const path = `/${item.to.slice('/o/$slug/'.length)}`.toLowerCase();
    if (!map.has(path)) map.set(path, item);
  }
  return map;
})();

const THEME_OPTIONS: readonly ThemeSetting[] = ['light', 'dark', 'system'];

const THEME_KEYWORDS: Readonly<Record<ThemeSetting, string>> = {
  light: 'theme giao dien sang light',
  dark: 'theme giao dien toi dark',
  system: 'theme giao dien theo he thong system',
};

export function buildRecentPaletteEntries({
  items,
  modules,
  visibility,
  tNav,
  onVisit,
}: {
  items: readonly RecentItem[];
  modules: readonly string[];
  visibility: ShellVisibility;
  tNav: (key: NavMessage) => string;
  onVisit: (item: RecentItem) => void;
}): PaletteEntry[] {
  const visible = filterVisibleRecentItems(items, { modules, visibility });
  return visible.map((item) => {
    const cleanPath = stripSearchAndHash(item.path).toLowerCase();
    const isExactScreen = item.kind === 'screen' && item.path.toLowerCase() === cleanPath;
    const navItem = isExactScreen ? NAV_BY_PATH.get(cleanPath) : undefined;
    const label = navItem ? tNav(navItem.label) : item.label;
    const sectionKey = item.kind === 'record' ? detailSectionKeyForPath(cleanPath) : null;
    const detail = item.detail ?? (sectionKey ? tNav(sectionKey) : undefined);
    return {
      id: `recent:${item.id}`,
      group: 'recent',
      label,
      ...(detail ? { detail } : {}),
      run: () => onVisit(item),
    };
  });
}

export interface QuickActionPaletteStrings {
  newTask: string;
  quickCapturePalette: string;
  tasksLabel: string;
  switchThemeAction: string;
  switchOrgAction: string;
  currentChoice: string;
  switchOrg: (name: string) => string;
  switchLocale: (name: string) => string;
  allClients: string;
  addOrg: string;
  themeName: (theme: ThemeSetting) => string;
  signOut: string;
}

export function buildQuickActionEntries({
  slug,
  orgs,
  currentOrgName,
  locale,
  theme,
  canQuickCapture,
  canCreateTeamTask,
  strings,
  onQuickCapture,
  onNewTeamTask,
  onSwitchOrg,
  onOpenClients,
  onAddOrg,
  onSetLocale,
  onSetTheme,
  onSignOut,
}: {
  slug: string;
  orgs: readonly { orgId: string; slug: string; name: string }[];
  currentOrgName: string | undefined;
  locale: Locale;
  theme: ThemeSetting;
  canQuickCapture: boolean;
  canCreateTeamTask: boolean;
  strings: QuickActionPaletteStrings;
  onQuickCapture: () => void;
  onNewTeamTask: () => void;
  onSwitchOrg: (orgSlug: string) => void;
  onOpenClients: () => void;
  onAddOrg: () => void;
  onSetLocale: (locale: Locale) => void;
  onSetTheme: (theme: ThemeSetting) => void;
  onSignOut: () => void;
}): PaletteEntry[] {
  const otherOrgs = orgs.filter((o) => o.slug !== slug);
  const directOrgEntries: PaletteEntry[] = otherOrgs.map((o) => ({
    id: `org:${o.slug}`,
    group: 'orgs',
    label: strings.switchOrg(o.name),
    keywords: o.slug,
    run: () => onSwitchOrg(o.slug),
  }));

  const newTaskEntry: PaletteEntry[] = canQuickCapture
    ? [
        {
          id: 'action:new-task',
          group: 'actions',
          label: strings.newTask,
          detail: strings.quickCapturePalette,
          badge: 'Alt+Q',
          keywords: 'tao viec moi them nhanh viec can lam new task todo quick capture add task alt q',
          run: onQuickCapture,
        },
      ]
    : canCreateTeamTask
      ? [
          {
            id: 'action:new-task',
            group: 'actions',
            label: strings.newTask,
            detail: strings.tasksLabel,
            keywords: 'tao viec moi giao viec moi new task add task team tasks',
            run: onNewTeamTask,
          },
        ]
      : [];

  const switchThemeEntry: PaletteEntry = {
    id: 'action:switch-theme',
    group: 'actions',
    label: strings.switchThemeAction,
    badge: strings.themeName(theme),
    keywords: 'doi giao dien switch theme giao dien sang toi theo he thong light dark system appearance',
    run: () => {
      const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'light';
      onSetTheme(next);
    },
    children: THEME_OPTIONS.map((th) => ({
      id: `theme:${th}`,
      group: 'actions',
      label: strings.themeName(th),
      ...(th === theme ? { badge: strings.currentChoice } : {}),
      keywords: THEME_KEYWORDS[th],
      run: () => onSetTheme(th),
    })),
  };

  const orgSubmenuChildren: PaletteEntry[] =
    otherOrgs.length > 0
      ? [
          ...otherOrgs.map((o) => ({
            id: `switch-org:${o.slug}`,
            group: 'orgs' as const,
            label: o.name,
            keywords: o.slug,
            run: () => onSwitchOrg(o.slug),
          })),
          {
            id: 'switch-org:clients',
            group: 'orgs' as const,
            label: strings.allClients,
            keywords: 'all clients companies tat ca doanh nghiep danh sach to chuc',
            run: onOpenClients,
          },
          {
            id: 'switch-org:add',
            group: 'orgs' as const,
            label: strings.addOrg,
            keywords: 'add organization new org onboarding them to chuc tao doanh nghiep',
            run: onAddOrg,
          },
        ]
      : [
          {
            id: 'switch-org:add',
            group: 'orgs' as const,
            label: strings.addOrg,
            keywords: 'add organization new org onboarding them to chuc tao doanh nghiep',
            run: onAddOrg,
          },
          {
            id: 'switch-org:clients',
            group: 'orgs' as const,
            label: strings.allClients,
            keywords: 'all clients companies tat ca doanh nghiep danh sach to chuc',
            run: onOpenClients,
          },
        ];

  const switchOrgEntry: PaletteEntry = {
    id: 'action:switch-org',
    group: 'actions',
    label: strings.switchOrgAction,
    ...(currentOrgName ? { badge: currentOrgName } : {}),
    keywords: 'doi to chuc switch organization org client doanh nghiep cong ty tat ca doanh nghiep them to chuc add organization',
    run: () => {
      if (otherOrgs[0]) onSwitchOrg(otherOrgs[0].slug);
      else onOpenClients();
    },
    children: orgSubmenuChildren,
  };

  const localeEntries: PaletteEntry[] = LOCALES.filter((l) => l !== locale).map((l) => ({
    id: `locale:${l}`,
    group: 'actions',
    label: strings.switchLocale(LOCALE_NAMES[l]),
    keywords: 'language ngon ngu doi ngon ngu switch language',
    run: () => onSetLocale(l),
  }));

  const signOutEntry: PaletteEntry = {
    id: 'sign-out',
    group: 'actions',
    label: strings.signOut,
    keywords: 'dang xuat sign out logout',
    run: onSignOut,
  };

  return [...directOrgEntries, ...newTaskEntry, switchThemeEntry, switchOrgEntry, ...localeEntries, signOutEntry];
}
