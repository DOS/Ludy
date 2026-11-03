import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_NAV, appOfPath, installedApps } from '../src/lib/apps.ts';
import { installedItems, screenInstalled } from '../src/lib/modules.ts';

describe('apps of the shell (#1528)', () => {
  it('finds the app of a deep link from its screen', () => {
    expect(appOfPath('/o/acme/inbox')).toBe('home');
    expect(appOfPath('/o/acme/inbox/0190-abc')).toBe('home');
    expect(appOfPath('/o/acme/overview')).toBe('home');
    expect(appOfPath('/o/acme/journal')).toBe('accounting');
    expect(appOfPath('/o/acme/journal/opening-balances')).toBe('accounting');
    expect(appOfPath('/o/acme/portal-invoices')).toBe('accounting');
    expect(appOfPath('/o/acme/guide')).toBe('accounting');
    expect(appOfPath('/o/acme/social')).toBe('social');
    expect(appOfPath('/o/acme/social/channels')).toBe('social');
    // The CRM's screens are in the Engage app (#2435).
    for (const path of ['bookings', 'deals', 'contacts', 'contacts/import', 'reports', 'ads']) expect(appOfPath(`/o/acme/${path}`), path).toBe('social');
  });

  it('puts the org own screens and paths outside an org in no app', () => {
    for (const path of ['/o/acme/settings', '/o/acme/agents', '/o/acme/audit', '/o/acme', '/clients', '/']) {
      expect(appOfPath(path), path).toBeNull();
    }
  });

  it('lists only the apps whose module runs, each opening on its first screen', () => {
    expect(installedApps(['kernel']).map((a) => a.id)).toEqual(['home']);
    const all = installedApps(['kernel', 'finance', 'social', 'crm']);
    // No CRM app on the rail: its screens are in the Engage app (#2435), which opens on its first group, the conversations; with only crm, on the contacts.
    expect(all.map((a) => a.id)).toEqual(['home', 'accounting', 'social']);
    expect(all.find((a) => a.id === 'accounting')?.home).toBe('/o/$slug/documents');
    expect(all.find((a) => a.id === 'home')?.home).toBe('/o/$slug/overview');
    expect(all.find((a) => a.id === 'social')?.home).toBe('/o/$slug/social/inbox');
    expect(installedApps(['kernel', 'crm']).find((a) => a.id === 'social')?.home).toBe('/o/$slug/contacts');
  });

  // The accounting keeps its customers and vendors, with the crm module off and on (#2435): the shell's change touches no accounting item.
  it('keeps the accounting menu the same with the crm module off and on', () => {
    const menu = (modules: string[]) => installedApps(modules).find((a) => a.id === 'accounting')?.groups.map((g) => [g.id, g.items.map((i) => i.to)]);
    const off = menu(['kernel', 'finance']);
    expect(off).toEqual(menu(['kernel', 'finance', 'crm']));
    expect(off?.find(([id]) => id === 'parties')?.[1]).toEqual(['/o/$slug/customers', '/o/$slug/vendors']);
    // Its links to a customer open the accounting's own screen, which no module but finance gates.
    for (const modules of [['kernel', 'finance'], ['kernel', 'finance', 'crm']]) {
      expect(screenInstalled(modules, '/o/acme/customers'), modules.join()).toBe(true);
      expect(screenInstalled(modules, '/o/acme/vendors'), modules.join()).toBe(true);
    }
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

  it('keeps every screen in the palette, each in one place only', () => {
    const paths = ALL_NAV.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('/o/$slug/settings');
    expect(paths).toContain('/o/$slug/ledger');
  });
});
