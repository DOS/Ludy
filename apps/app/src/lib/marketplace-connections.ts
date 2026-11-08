// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace connection card in Settings (#2519, ADR-0045 point 7): what the screen works out from the API's answers. The server decides every rule; these only choose what to show.
import type { MarketplaceAdapterInfo, MarketplaceConnection, MarketplaceConnectionState, MarketplacePlatformInfo, MarketplacePollState } from '@crove/kernel-contract';

// The words for a test state and for how a poll ended, as message keys.
export const TEST_STATE_KEYS = {
  works: 'testStates.works',
  wrong_credentials: 'testStates.wrong_credentials',
  api_not_enabled: 'testStates.api_not_enabled',
  ip_not_allowed: 'testStates.ip_not_allowed',
  unreachable: 'testStates.unreachable',
} as const satisfies Record<MarketplaceConnectionState, string>;

export const POLL_STATE_KEYS = {
  ok: 'pollStates.ok',
  unreachable: 'pollStates.unreachable',
  credentials: 'pollStates.credentials',
  rate_limited: 'pollStates.rate_limited',
  too_large: 'pollStates.too_large',
  not_recognized: 'pollStates.not_recognized',
} as const satisfies Record<MarketplacePollState, string>;

export const PLATFORM_KEYS = { shopee: 'platforms.shopee', tiktok_shop: 'platforms.tiktok_shop', lazada: 'platforms.lazada' } as const;

// Whether the marketplace card draws: the deployment offers an adapter to connect, or the org already has a connection (a viewer still reads it when the adapter was turned off
// since). While the answers are not in, it does not.
export const marketplaceCardShown = (adapters: readonly unknown[] | undefined, connections: readonly unknown[] | undefined): boolean => (adapters?.length ?? 0) > 0 || (connections?.length ?? 0) > 0;

// The adapter a connection reads through: its channel provider is `marketplace_` and the adapter's id.
export const adapterIdOf = (connection: Pick<MarketplaceConnection, 'provider'>): string => connection.provider.replace(/^marketplace_/, '');

// Whether the screen offers "pull the orders now": the connection is live and its adapter is the offline one (a real adapter is polled by the worker on its own schedule).
export const canPollNow = (connection: Pick<MarketplaceConnection, 'provider' | 'status'>, adapters: readonly MarketplaceAdapterInfo[]): boolean =>
  connection.status === 'active' && adapters.some((a) => a.id === adapterIdOf(connection) && a.offline);

// The platforms a connect can name: those an adapter serves.
export const connectablePlatforms = (platforms: readonly MarketplacePlatformInfo[]): MarketplacePlatformInfo[] => platforms.filter((p) => p.adapter);

// The words for a field an adapter asks for, as a message key; a name with no words of its own is shown as it is.
export const fieldLabelKey = (name: string, known: (key: string) => boolean): string | null => (known(`fieldLabels.${name}`) ? `fieldLabels.${name}` : null);

// A field the org types to connect is a secret unless its name says it is a plain identifier: the input hides what is typed.
export const fieldIsSecret = (name: string): boolean => !/^(user|username|account|email|login|appId|clientId|shopId)$/i.test(name);
