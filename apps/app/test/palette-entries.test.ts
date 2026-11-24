// SPDX-License-Identifier: AGPL-3.0-only
// Cmd+K recent entry builder and inline quick actions (#4525): disabled-module/permission filtering,
// live locale resolution, Vietnamese diacritic-folded + English search, live theme-runtime sync with
// ThemeSwitcher, New task wiring, and single-org / multi-org Switch organization behavior.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import type { NavMessage, ShellVisibility } from '../src/lib/apps.ts';
import { filterPalette, findSubmenuEntry, resolvePaletteResults, type PaletteEntry } from '../src/lib/palette.ts';
import { buildQuickActionEntries, buildRecentPaletteEntries } from '../src/lib/palette-entries.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

class FakeClassList {
  private readonly tokens = new Set<string>();
  toggle(token: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.tokens.has(token)) {
        this.tokens.delete(token);
        return false;
      }
      this.tokens.add(token);
      return true;
    }
    if (force) this.tokens.add(token);
    else this.tokens.delete(token);
    return force;
  }
  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

function stringsFor(locale: 'vi' | 'en') {
  const catalog = locale === 'vi' ? viMessages : enMessages;
  const tp = catalog.palette;
  const tn = catalog.nav;
  const tc = catalog.common;
  const tmw = catalog.myWork;
  const tNav = (key: NavMessage) => (tn as unknown as Record<string, string>)[key] ?? key;
  return {
    tNav,
    strings: {
      newTask: tp.newTask,
      quickCapturePalette: tmw.quickCapturePalette,
      tasksLabel: tn.tasks,
      switchThemeAction: tp.switchThemeAction,
      switchOrgAction: tp.switchOrgAction,
      currentChoice: tp.currentChoice,
      switchOrg: (name: string) => tp.switchOrg.replace('{name}', name),
      switchLocale: (name: string) => tp.switchLocale.replace('{name}', name),
      allClients: tn.allClients,
      addOrg: tn.addOrg,
      themeName: (th: 'light' | 'dark' | 'system') => tc.themes[th],
      signOut: tc.signOut,
    },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildRecentPaletteEntries', () => {
  const managerVis: ShellVisibility = { manager: true, hrMember: true, showAiConnections: true };
  const memberVis: ShellVisibility = { manager: false, hrMember: true, showAiConnections: false };

  it('resolves built-in screen titles in the active locale and localizes record section details', () => {
    const visited: string[] = [];
    const items = [
      { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' as const, visitedAt: 2 },
      { id: '/inbox/p1', path: '/inbox/p1', label: 'Công ty Bao Bì', kind: 'record' as const, visitedAt: 1 },
    ];
    const en = stringsFor('en');
    const entries = buildRecentPaletteEntries({
      items,
      modules: ['kernel', 'finance'],
      visibility: managerVis,
      tNav: en.tNav,
      onVisit: (item) => visited.push(item.path),
    });

    expect(entries.map((e) => ({ id: e.id, group: e.group, label: e.label, detail: e.detail }))).toEqual([
      { id: 'recent:/ledger', group: 'recent', label: 'Ledgers', detail: undefined },
      { id: 'recent:/inbox/p1', group: 'recent', label: 'Công ty Bao Bì', detail: 'Pending approval' },
    ]);
    entries[1]?.run();
    expect(visited).toEqual(['/inbox/p1']);
  });

  it('drops disabled-module and unauthorized items before surfacing Recent entries', () => {
    const items = [
      { id: '/overview', path: '/overview', label: 'Tổng quan', kind: 'screen' as const, visitedAt: 3 },
      { id: '/hr/employees', path: '/hr/employees', label: 'Nhân viên', kind: 'screen' as const, visitedAt: 2 },
      { id: '/ledger', path: '/ledger', label: 'Sổ sách', kind: 'screen' as const, visitedAt: 1 },
    ];
    const vi = stringsFor('vi');
    const entries = buildRecentPaletteEntries({
      items,
      modules: ['kernel', 'hr'],
      visibility: memberVis,
      tNav: vi.tNav,
      onVisit: () => undefined,
    });
    expect(entries.map((e) => e.id)).toEqual(['recent:/overview']);
  });
});

describe('buildQuickActionEntries', () => {
  const twoOrgs = [
    { orgId: '1', slug: 'hoa-sen', name: 'Công ty Hoa Sen' },
    { orgId: '2', slug: 'huong-duong', name: 'Công ty Hướng Dương' },
  ];
  const oneOrg = [twoOrgs[0]!];

  const makeEntries = (
    locale: 'vi' | 'en',
    overrides: Partial<Parameters<typeof buildQuickActionEntries>[0]> = {},
  ): {
    entries: PaletteEntry[];
    calls: string[];
  } => {
    const calls: string[] = [];
    const loc = stringsFor(locale);
    const entries = buildQuickActionEntries({
      slug: 'hoa-sen',
      orgs: twoOrgs,
      currentOrgName: 'Công ty Hoa Sen',
      locale,
      theme: 'light',
      canQuickCapture: true,
      canCreateTeamTask: true,
      strings: loc.strings,
      onQuickCapture: () => calls.push('quickCapture'),
      onNewTeamTask: () => calls.push('teamTask'),
      onSwitchOrg: (orgSlug) => calls.push(`switchOrg:${orgSlug}`),
      onOpenClients: () => calls.push('clients'),
      onAddOrg: () => calls.push('addOrg'),
      onSetLocale: (next) => calls.push(`locale:${next}`),
      onSetTheme: (next) => calls.push(`theme:${next}`),
      onSignOut: () => calls.push('signOut'),
      ...overrides,
    });
    return { entries, calls };
  };

  it('finds New task, Switch theme, and Switch organization with Vietnamese diacritic-folded and English queries', () => {
    const { entries: viEntries } = makeEntries('vi');
    expect(filterPalette(viEntries, 'tao viec moi').map((e) => e.id)).toContain('action:new-task');
    expect(filterPalette(viEntries, 'new task').map((e) => e.id)).toContain('action:new-task');
    expect(filterPalette(viEntries, 'doi giao dien').map((e) => e.id)).toContain('action:switch-theme');
    expect(filterPalette(viEntries, 'switch theme').map((e) => e.id)).toContain('action:switch-theme');
    expect(filterPalette(viEntries, 'doi to chuc').map((e) => e.id)).toContain('action:switch-org');
    expect(filterPalette(viEntries, 'switch organization').map((e) => e.id)).toContain('action:switch-org');

    const { entries: enEntries } = makeEntries('en');
    expect(filterPalette(enEntries, 'new task')[0]?.label).toBe('New task');
    expect(filterPalette(enEntries, 'switch theme')[0]?.label).toBe('Switch theme');
    expect(filterPalette(enEntries, 'switch org')[0]?.label).toBe('Switch organization');
  });

  it('wires New task to quick capture when notes enabled, falls back to team tasks when notes disabled, and omits for viewers', () => {
    const quick = makeEntries('vi', { canQuickCapture: true, canCreateTeamTask: true });
    quick.entries.find((e) => e.id === 'action:new-task')?.run();
    expect(quick.calls).toEqual(['quickCapture']);

    const teamOnly = makeEntries('vi', { canQuickCapture: false, canCreateTeamTask: true });
    teamOnly.entries.find((e) => e.id === 'action:new-task')?.run();
    expect(teamOnly.calls).toEqual(['teamTask']);

    const viewer = makeEntries('vi', { canQuickCapture: false, canCreateTeamTask: false });
    expect(viewer.entries.find((e) => e.id === 'action:new-task')).toBeUndefined();
  });

  it('handles Switch organization cleanly for both multi-org and single-org users', () => {
    const multi = makeEntries('vi', { orgs: twoOrgs });
    const multiMenu = findSubmenuEntry(multi.entries, 'action:switch-org');
    expect(multiMenu?.children?.map((c) => c.id)).toEqual([
      'switch-org:huong-duong',
      'switch-org:clients',
      'switch-org:add',
    ]);
    const multiItems = resolvePaletteResults(multi.entries, 'huong', [], multiMenu);
    expect(multiItems.map((i) => i.id)).toEqual(['switch-org:huong-duong']);
    multiItems[0]?.run();
    expect(multi.calls).toEqual(['switchOrg:huong-duong']);

    const single = makeEntries('vi', { orgs: oneOrg });
    const singleMenu = findSubmenuEntry(single.entries, 'action:switch-org');
    expect(singleMenu?.children?.map((c) => c.id)).toEqual(['switch-org:add', 'switch-org:clients']);
    singleMenu?.children?.[0]?.run();
    singleMenu?.children?.[1]?.run();
    expect(single.calls).toEqual(['addOrg', 'clients']);
  });

  it('synchronizes Switch theme live with theme-runtime and ThemeSwitcher in AccountPopover', async () => {
    const storage = new MemoryStorage();
    const root = { classList: new FakeClassList(), style: { colorScheme: '' } };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    vi.resetModules();

    const runtime = await import('../src/lib/theme-runtime.ts');
    const { I18nProvider } = await import('../src/i18n/provider.tsx');
    const { ThemeSwitcher } = await import('../src/components/theme-switcher.tsx');

    const tab = new EventTarget();
    const stop = runtime.startThemeSync(tab as unknown as Window);
    try {
      const renderSwitcher = () => renderToString(createElement(I18nProvider, null, createElement(ThemeSwitcher)));
      expect(renderSwitcher()).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*data-value="light"/);

      const viStr = stringsFor('vi');
      const entries = buildQuickActionEntries({
        slug: 'hoa-sen',
        orgs: oneOrg,
        currentOrgName: 'Công ty Hoa Sen',
        locale: 'vi',
        theme: runtime.activeThemeSetting(),
        canQuickCapture: true,
        canCreateTeamTask: true,
        strings: viStr.strings,
        onQuickCapture: () => undefined,
        onNewTeamTask: () => undefined,
        onSwitchOrg: () => undefined,
        onOpenClients: () => undefined,
        onAddOrg: () => undefined,
        onSetLocale: () => undefined,
        onSetTheme: runtime.setThemeSetting,
        onSignOut: () => undefined,
      });

      const themeMenu = findSubmenuEntry(entries, 'action:switch-theme');
      expect(themeMenu?.badge).toBe('Sáng');
      expect(themeMenu?.children?.find((c) => c.id === 'theme:light')?.badge).toBe('Đang dùng');
      const darkChoice = resolvePaletteResults(entries, 'toi', [], themeMenu)[0];
      expect(darkChoice?.id).toBe('theme:dark');
      darkChoice?.run();

      expect(runtime.activeThemeSetting()).toBe('dark');
      expect(storage.getItem('ludy-theme')).toBe('dark');
      expect(root.classList.contains('dark')).toBe(true);
      expect(root.style.colorScheme).toBe('dark');
      expect(renderSwitcher()).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*data-value="dark"/);
    } finally {
      stop();
    }
  });
});
