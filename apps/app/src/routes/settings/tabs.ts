// SPDX-License-Identifier: AGPL-3.0-only
// The sub-pages of Settings (ST-1, #3589; the notifications page, #3592; moved into the left sidebar in #4499). Each page is a screen with its own address, drawn in the secondary sidebar by the shell (`SETTINGS_ITEMS` in lib/apps.ts), so a card can be linked and a phone
// does not scroll a 10000 px page. The first page keeps the address `settings`, which every old link names; the others are `settings/<tab>`.
// A page holds what fits a screen: at 1440 wide the title and the cards of each stay under 1200 px (e2e/tests/settings-tabs.spec.ts measures them), which is why the booking, quote and sales cards
// of Engage have pages of their own, the tax profile sits with the org and the meeting platforms with the person's own devices. Later issues drop their cards into a page here (the wording of #3590); the notification preferences of #3592 are the page "Thông báo của tôi", with the person's own checks: a new card is one entry in that page, nothing else.
export const SETTINGS_TABS = ['org', 'members', 'apps', 'bookings', 'sales', 'quotes', 'accounting', 'connections', 'notifications', 'security', 'data'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

// The screen of a tab, under /o/<slug>/.
export const SETTINGS_TAB_PATH = {
  org: 'settings',
  members: 'settings/members',
  apps: 'settings/apps',
  bookings: 'settings/bookings',
  sales: 'settings/sales',
  quotes: 'settings/quotes',
  accounting: 'settings/accounting',
  connections: 'settings/connections',
  notifications: 'settings/notifications',
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
  quotes: '/o/$slug/settings/quotes',
  accounting: '/o/$slug/settings/accounting',
  connections: '/o/$slug/settings/connections',
  notifications: '/o/$slug/settings/notifications',
  security: '/o/$slug/settings/security',
  data: '/o/$slug/settings/data',
} as const satisfies Record<SettingsTab, string>;

// The anchors of the cards that other screens link to (#fragment of the address). Each card sits in one tab, which CARD_TAB says.
export const SETTINGS_CARD = {
  members: 'settings-members',
  taxProfile: 'tax-profile',
  legalEntities: 'legal-entities',
  bankAccountNumbers: 'bank-account-numbers',
  booksRegime: 'books-regime',
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
  notifications: 'notification-settings',
  todayMail: 'daily-brief-mail',
} as const;

export const CARD_TAB: Readonly<Record<string, SettingsTab>> = {
  [SETTINGS_CARD.members]: 'members',
  [SETTINGS_CARD.taxProfile]: 'org',
  [SETTINGS_CARD.legalEntities]: 'org',
  [SETTINGS_CARD.bankAccountNumbers]: 'connections',
  [SETTINGS_CARD.booksRegime]: 'accounting',
  [SETTINGS_CARD.chartOfAccounts]: 'accounting',
  [SETTINGS_CARD.misaGoodsCodes]: 'accounting',
  [SETTINGS_CARD.accountRules]: 'accounting',
  [SETTINGS_CARD.bankPartyRules]: 'accounting',
  [SETTINGS_CARD.integrations]: 'connections',
  [SETTINGS_CARD.meetingPlatforms]: 'security',
  [SETTINGS_CARD.twoFactor]: 'security',
  [SETTINGS_CARD.sessions]: 'security',
  [SETTINGS_CARD.bookingSettings]: 'bookings',
  [SETTINGS_CARD.bookingEventTypes]: 'bookings',
  [SETTINGS_CARD.quoteSettings]: 'quotes',
  [SETTINGS_CARD.salesProcess]: 'sales',
  [SETTINGS_CARD.notifications]: 'notifications',
  [SETTINGS_CARD.todayMail]: 'notifications',
};

// Where an old link to the single Settings page belongs now: the address `settings` with a card's #fragment (the booking cards, the quotes, the sales process, the members card, the integrations) or with
// `?invite=` (onboarding invites the new client's contact) lands on the tab that holds that card. Null: the link names nothing a tab moved, so the first tab is right.
export function legacySettingsTab(hash: string, search: { invite?: string | undefined }): SettingsTab | null {
  if (search.invite !== undefined) return 'members';
  const tab = CARD_TAB[hash.replace(/^#/, '')];
  return tab && tab !== 'org' ? tab : null;
}
