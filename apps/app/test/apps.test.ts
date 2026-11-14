import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_ITEMS, ALL_NAV, BELL_ITEM, APPS, TAB_GROUPS, TOP_ITEMS, appOfPath, installedApps, tabGroupOfPath } from '../src/lib/apps.ts';
import { installedItems, screenInstalled } from '../src/lib/modules.ts';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

describe('apps of the shell (#1528, #3225)', () => {
  it('finds the app of a deep link from its screen', () => {
    // Pending approval is the first tab of Tài chính > Chứng từ (#3225).
    expect(appOfPath('/o/acme/inbox')).toBe('finance');
    expect(appOfPath('/o/acme/inbox/0190-abc')).toBe('finance');
    expect(appOfPath('/o/acme/documents')).toBe('finance');
    expect(appOfPath('/o/acme/journal')).toBe('finance');
    expect(appOfPath('/o/acme/journal/opening-balances')).toBe('finance');
    expect(appOfPath('/o/acme/portal-invoices')).toBe('finance');
    expect(appOfPath('/o/acme/guide')).toBe('finance');
    // The screens Ctrl K finds that are no menu item still open in their app.
    for (const path of ['marketplace', 'household', 'payment-reminders']) expect(appOfPath(`/o/acme/${path}`), path).toBe('finance');
    for (const path of ['tasks', 'tasks/0190-abc', 'my-work', 'notes', 'meetings']) expect(appOfPath(`/o/acme/${path}`), path).toBe('teamwork');
    for (const path of ['agents', 'ai-usage', 'ai-connections']) expect(appOfPath(`/o/acme/${path}`), path).toBe('ai');
    expect(appOfPath('/o/acme/hr/employees')).toBe('hr');
    expect(appOfPath('/o/acme/social')).toBe('engage');
    expect(appOfPath('/o/acme/social/channels')).toBe('engage');
    // The CRM's screens are in the Engage app (#2435).
    for (const path of ['bookings', 'deals', 'contacts', 'contacts/import', 'reports', 'ads', 'ads/campaigns', 'social/notifications']) expect(appOfPath(`/o/acme/${path}`), path).toBe('engage');
  });

  it('reads a path without regard to case, as the router does', () => {
    expect(appOfPath('/o/acme/JOURNAL')).toBe('finance');
    expect(appOfPath('/o/acme/Social/New')).toBe('engage');
    expect(tabGroupOfPath('/o/acme/PAYMENT-REMINDERS')?.menu).toBe('customers');
  });

  it('puts the overview, the bell, the org own screens and paths outside an org in no app', () => {
    for (const path of ['/o/acme/overview', '/o/acme/notifications', '/o/acme/settings', '/o/acme/audit', '/o/acme', '/clients', '/']) {
      expect(appOfPath(path), path).toBeNull();
    }
  });

  it('lists only the apps whose module runs, each opening on its first screen', () => {
    // The kernel alone runs Cộng tác (the team's tasks) and Ludy AI; the overview, the bell and Settings are not apps.
    expect(installedApps(['kernel']).map((a) => a.id)).toEqual(['teamwork', 'ai']);
    const all = installedApps(['kernel', 'finance', 'social', 'crm']);
    // No CRM app on the rail: its screens are in the Engage app (#2435), which opens on its first group, the conversations; with only crm, on the contacts.
    expect(all.map((a) => a.id)).toEqual(['teamwork', 'finance', 'engage', 'ai']);
    expect(all.find((a) => a.id === 'finance')?.home).toBe('/o/$slug/accounting');
    expect(all.find((a) => a.id === 'teamwork')?.home).toBe('/o/$slug/tasks');
    expect(all.find((a) => a.id === 'engage')?.home).toBe('/o/$slug/social/inbox');
    expect(installedApps(['kernel', 'crm']).find((a) => a.id === 'engage')?.home).toBe('/o/$slug/contacts');
  });

  it('puts the apps in the order of the switcher, and the overview, the bell and Settings around them', () => {
    expect(installedApps(['kernel', 'finance', 'social', 'crm', 'hr', 'notes', 'meetings']).map((a) => a.id)).toEqual(['teamwork', 'finance', 'engage', 'hr', 'ai']);
    expect(TOP_ITEMS.map((i) => i.to)).toEqual(['/o/$slug/overview']);
    expect(BELL_ITEM?.to).toBe('/o/$slug/notifications');
    expect(ADMIN_ITEMS.map((i) => i.to)).toEqual(['/o/$slug/settings']);
  });

  // The accounting keeps its customers and vendors, with the crm module off and on (#2435): the shell's change touches no finance item.
  it('keeps the finance menu the same with the crm module off and on', () => {
    const menu = (modules: string[]) => installedApps(modules).find((a) => a.id === 'finance')?.groups.map((g) => [g.id, g.items.map((i) => i.to)]);
    const off = menu(['kernel', 'finance']);
    expect(off).toEqual(menu(['kernel', 'finance', 'crm']));
    expect(off?.find(([id]) => id === 'sell')?.[1]).toEqual(expect.arrayContaining(['/o/$slug/customers']));
    expect(off?.find(([id]) => id === 'buy')?.[1]).toEqual(['/o/$slug/vendors']);
    // Its links to a customer open the accounting's own screen, which no module but finance gates.
    for (const modules of [['kernel', 'finance'], ['kernel', 'finance', 'crm']]) {
      expect(screenInstalled(modules, '/o/acme/customers'), modules.join()).toBe(true);
      expect(screenInstalled(modules, '/o/acme/vendors'), modules.join()).toBe(true);
    }
  });

  // Tài chính is the accounting only: without the finance module its documents item and all its groups are gone, and the kernel's other screens stay.
  it('leaves Tài chính out where finance is off, so no empty app and no dead Chứng từ item', () => {
    expect(installedApps(['kernel']).some((a) => a.id === 'finance')).toBe(false);
    expect(installedItems(['kernel'], ALL_NAV).some((i) => i.label === 'documents')).toBe(false);
    // The pending approvals are still found by Ctrl K, and the overview still links to them.
    expect(installedItems(['kernel'], ALL_NAV).some((i) => String(i.label) === 'inbox')).toBe(true);
  });

  // The reports item (#2435) is the social module's and shows where crm or ads runs alone, so a menu with an item of the social module does not mean
  // Social runs: the shell polls Social's reads (reviews, attention, notifications) only where the module is installed, or they answer not installed.
  it('keeps the reports item for the social module where social is off, so the shell asks the modules and not the menu', () => {
    for (const modules of [['kernel', 'crm'], ['kernel', 'ads']]) {
      const reports = installedItems(modules, ALL_NAV).find((item) => item.label === 'reports');
      expect(reports?.module, modules.join()).toBe('social');
      expect(modules.includes('social'), modules.join()).toBe(false);
    }
    const layout = readFileSync(new URL('../src/routes/org-layout.tsx', import.meta.url), 'utf8');
    expect(layout).not.toMatch(/NAV\.some\(\(n\) => n\.module === 'social'\)/);
    expect(layout).toContain("getConfig().modules.includes('social')");
  });

  it('keeps every screen in the palette, each name once', () => {
    // One entry per name: Ctrl K never lists two screens under the same label. The Chờ duyệt tab shares the address of the Chứng từ item it opens.
    const labels = ALL_NAV.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
    const entries = ALL_NAV.map((item) => `${item.to} ${item.label}`);
    expect(new Set(entries).size).toBe(entries.length);
    const paths = ALL_NAV.map((item) => item.to);
    expect(paths).toContain('/o/$slug/settings');
    expect(paths).toContain('/o/$slug/ledger');
    // Cuộc họp, Sàn and Hộ kinh doanh are found (#3225).
    for (const path of ['meetings', 'marketplace', 'household']) expect(paths, path).toContain(`/o/$slug/${path}`);
  });

  it('shows no two menu items under one label, in either language', () => {
    for (const messages of [viMessages.nav, enMessages.nav] as const) {
      const shown = APPS.flatMap((a) => a.groups.flatMap((g) => g.items)).map((i) => (messages as unknown as Record<string, string>)[i.label]);
      expect(new Set(shown).size, shown.join(' | ')).toBe(shown.length);
    }
  });

  it('opens each tab group on its first tab, and a tab belongs to one menu item', () => {
    for (const group of TAB_GROUPS) {
      expect(group.tabs[0]?.path, group.menu).toBe(group.menu);
      for (const tab of group.tabs) expect(tabGroupOfPath(`/o/acme/${tab.path}`)?.menu, tab.path).toBe(group.menu);
      for (const messages of [viMessages.nav, enMessages.nav] as const) for (const tab of group.tabs) expect(messages, tab.label).toHaveProperty(tab.label);
    }
    // A screen under a tab is not a tab itself.
    expect(tabGroupOfPath('/o/acme/inbox/0190-abc')).toBeNull();
    expect(tabGroupOfPath('/o/acme/social/new')).toBeNull();
    expect(tabGroupOfPath('/o/acme/journal')).toBeNull();
    expect(tabGroupOfPath('/o/acme/documents')?.menu).toBe('inbox');
  });
});
