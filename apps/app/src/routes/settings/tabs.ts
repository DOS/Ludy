// SPDX-License-Identifier: AGPL-3.0-only
// The tabs of Settings (ST-1, #3589). Each tab is a screen with its own address, drawn as a strip by the shell (TAB_GROUPS in lib/apps.ts), so a card can be linked and a phone
// does not scroll a 10000 px page. The first tab keeps the address `settings`, which every old link names; the others are `settings/<tab>`.
// A tab holds what fits a screen: at 1440 wide each stays under 1200 px, which is why the booking cards and the quote and sales cards of Engage have tabs of their own, and the
// tax profile sits with the org. Later issues drop their cards into a tab here (the wording of #3590, the notification preferences of #3592): a new card is one entry in that tab's page, nothing else.
export const SETTINGS_TABS = ['org', 'members', 'apps', 'bookings', 'sales', 'accounting', 'connections', 'security', 'data'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

// The screen of a tab, under /o/<slug>/.
export const SETTINGS_TAB_PATH = {
  org: 'settings',
  members: 'settings/members',
  apps: 'settings/apps',
  bookings: 'settings/bookings',
  sales: 'settings/sales',
  accounting: 'settings/accounting',
  connections: 'settings/connections',
  security: 'settings/security',
  data: 'settings/data',
} as const satisfies Record<SettingsTab, string>;

// The router's `to` of each tab, for a link.
export const SETTINGS_TAB_TO = {
  org: '/o/$slug/settings',
  members: '/o/$slug/settings/members',
  apps: '/o/$slug/settings/apps',
  bookings: '/o/$slug/settings/bookings',
  sales: '/o/$slug/settings/sales',
  accounting: '/o/$slug/settings/accounting',
  connections: '/o/$slug/settings/connections',
  security: '/o/$slug/settings/security',
  data: '/o/$slug/settings/data',
} as const satisfies Record<SettingsTab, string>;

// The anchors of the cards that other screens link to (#fragment of the address). Each card sits in one tab, which CARD_TAB says.
export const SETTINGS_CARD = {
  members: 'settings-members',
  taxProfile: 'tax-profile',
  legalEntities: 'legal-entities',
  bankAccountNumbers: 'bank-account-numbers',
  chartOfAccounts: 'chart-of-accounts',
  misaGoodsCodes: 'misa-goods-codes',
  accountRules: 'account-rules',
  bankPartyRules: 'bank-party-rules',
  integrations: 'integrations',
  meetingPlatforms: 'meeting-platforms',
  twoFactor: 'two-factor',
  sessions: 'my-sessions',
  bookingSettings: 'booking-settings',
  bookingEventTypes: 'booking-event-types',
  quoteSettings: 'quote-settings',
  salesProcess: 'sales-process',
} as const;

export const CARD_TAB: Readonly<Record<string, SettingsTab>> = {
  [SETTINGS_CARD.members]: 'members',
  [SETTINGS_CARD.taxProfile]: 'org',
  [SETTINGS_CARD.legalEntities]: 'org',
  [SETTINGS_CARD.bankAccountNumbers]: 'connections',
  [SETTINGS_CARD.chartOfAccounts]: 'accounting',
  [SETTINGS_CARD.misaGoodsCodes]: 'accounting',
  [SETTINGS_CARD.accountRules]: 'accounting',
  [SETTINGS_CARD.bankPartyRules]: 'accounting',
  [SETTINGS_CARD.integrations]: 'connections',
  [SETTINGS_CARD.meetingPlatforms]: 'connections',
  [SETTINGS_CARD.twoFactor]: 'security',
  [SETTINGS_CARD.sessions]: 'security',
  [SETTINGS_CARD.bookingSettings]: 'bookings',
  [SETTINGS_CARD.bookingEventTypes]: 'bookings',
  [SETTINGS_CARD.quoteSettings]: 'sales',
  [SETTINGS_CARD.salesProcess]: 'sales',
};

// Where an old link to the single Settings page belongs now: the address `settings` with a card's #fragment (the booking cards, the quotes, the sales process, the members card, the integrations) or with
// `?invite=` (onboarding invites the new client's contact) lands on the tab that holds that card. Null: the link names nothing a tab moved, so the first tab is right.
export function legacySettingsTab(hash: string, search: { invite?: string | undefined }): SettingsTab | null {
  if (search.invite !== undefined) return 'members';
  const tab = CARD_TAB[hash.replace(/^#/, '')];
  return tab && tab !== 'org' ? tab : null;
}
