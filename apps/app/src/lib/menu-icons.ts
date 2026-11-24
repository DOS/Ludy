// SPDX-License-Identifier: AGPL-3.0-only
import type { NavIconName } from '@ludy/ui/components/nav-icon';
import type { AppId, NavLabel, SettingsLabel } from './apps.ts';

export const APP_ICON: Record<AppId, NavIconName> = { teamwork: 'appTeamwork', finance: 'appAccounting', engage: 'appSocial', hr: 'appHr', sign: 'journal', ai: 'appAi' };

// A menu item's icon is the one named like its label (packages/ui nav-icon.tsx), and no two items of the menus share one (#3588,
// test/shell-menu-icons.test.ts). Items without an icon of their own take the one named here; the type fails to compile for a label that has neither.
const OWN_ICON = { socialInbox: 'inbox', socialNotifications: 'notifications', tax: 'vat', meetings: 'comments', org: 'settingsOrg' } as const satisfies {
  [L in Exclude<NavLabel | SettingsLabel, NavIconName>]: NavIconName;
};
export const menuIcon = (label: NavLabel | SettingsLabel): NavIconName => (label in OWN_ICON ? OWN_ICON[label as keyof typeof OWN_ICON] : (label as NavIconName));
