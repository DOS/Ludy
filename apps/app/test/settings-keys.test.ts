// SPDX-License-Identifier: AGPL-3.0-only
// The cards of a Settings tab are siblings in one column, and several are keyed by the org so a value typed in one org does not
// stay when the page shows another. With one key shared, React matches cards by key when a slot before them renders
// nothing (a card that is off), loses one, and leaves the old card in the page next to its new copy (issue #2099: the
// MISA card showed twice once the bank feed card, off by default, sat before it). So every key is its own, on each tab and across them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/routes/settings/pages.tsx', import.meta.url), 'utf8');
// One entry for each tab's page: the text of its function.
const pages = source
  .split(/^export function /m)
  .slice(1)
  .map((text) => [text.slice(0, text.indexOf('(')), text] as const);
const keysOf = (text: string) => [...text.matchAll(/<[A-Z]\w+ key=\{(`[^`]*`|[^}]*)\}/g)].map((m) => m[1] as string);

describe('Settings keys', () => {
  it('has a page for each of the nine tabs', () => {
    expect(pages.map(([name]) => name)).toEqual(['SettingsOrgPage', 'SettingsMembersPage', 'SettingsAppsPage', 'SettingsBookingsPage', 'SettingsSalesPage', 'SettingsAccountingPage', 'SettingsConnectionsPage', 'SettingsSecurityPage', 'SettingsDataPage']);
  });

  it.each(pages.filter(([, text]) => keysOf(text).length > 0))('gives each keyed element of %s its own key', (_name, text) => {
    const keys = keysOf(text);
    expect(new Set(keys).size).toBe(keys.length);
    // Not just distinct text: a bare org key is the one other keys were sharing.
    for (const key of keys) expect(key).not.toMatch(/^org\.slug$/);
  });

  it('keeps every key distinct across the tabs too', () => {
    const keys = keysOf(source);
    expect(keys.length).toBeGreaterThan(10);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
