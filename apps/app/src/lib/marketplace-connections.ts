// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace connection card in Settings (#2519, ADR-0045 point 7): what the screen works out from the API's answers. The server decides every rule; these only choose what to show.
import type { MarketplaceAdapterInfo, MarketplaceConnection, MarketplaceConnectionState, MarketplacePlatformInfo, MarketplacePollState } from '@ludy/kernel-contract';

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

// The words for a test state of a connection: an adapter may have its own for a state (Lazada tells "not authorized yet" from "refused"), else the generic ones.
// The message groups of each adapter that is authorized on the platform's page: its own words for the two states the authorize step turns on, for "not authorized yet" after a refused poll and for a failed authorization.
const OWN_WORDS: Readonly<Record<string, { test: string; poll: string; authorize: string }>> = {
  lazada: { test: 'testStatesLazada', poll: 'pollStatesLazada', authorize: 'authorizeStatesLazada' },
  tiktok_shop: { test: 'testStatesTiktok', poll: 'pollStatesTiktok', authorize: 'authorizeStatesTiktok' },
};
const OWN_TEST_STATES: readonly MarketplaceConnectionState[] = ['wrong_credentials', 'api_not_enabled'];
export const testStateKey = (adapterId: string, state: MarketplaceConnectionState): string => {
  const own = OWN_WORDS[adapterId];
  return own && OWN_TEST_STATES.includes(state) ? `${own.test}.${state}` : TEST_STATE_KEYS[state];
};

// The words for where an authorization stands: the generic ones, or the adapter's own where it has them (TikTok's failure names the shops).
export const authorizeStateKey = (adapterId: string, state: 'pending' | 'authorized' | 'refused' | 'failed' | 'shop_changed'): string => {
  const own = OWN_WORDS[adapterId];
  if (state === 'shop_changed') return 'authorizeStates.shopChanged';
  return own && state === 'failed' ? `${own.authorize}.failed` : `authorizeStates.${state}`;
};

// The words for how a poll ended. A poll of an authorized adapter refused as `credentials` whose last test said the app is not authorized yet reads as that (not as a refused login); everything else is generic.
export const pollStateKey = (connection: Pick<MarketplaceConnection, 'provider' | 'lastTestState'>, state: MarketplacePollState): string => {
  const own = OWN_WORDS[adapterIdOf(connection)];
  return state === 'credentials' && own && connection.lastTestState === 'api_not_enabled' ? `${own.poll}.not_authorized` : POLL_STATE_KEYS[state];
};

export const PLATFORM_KEYS = { shopee: 'platforms.shopee', tiktok_shop: 'platforms.tiktok_shop', lazada: 'platforms.lazada' } as const;

// Whether the marketplace card draws: the deployment offers an adapter to connect, or the org already has a connection (a viewer still reads it when the adapter was turned off
// since). While the answers are not in, it does not.
export const marketplaceCardShown = (adapters: readonly unknown[] | undefined, connections: readonly unknown[] | undefined): boolean => (adapters?.length ?? 0) > 0 || (connections?.length ?? 0) > 0;

// The adapter a connection reads through: its channel provider is `marketplace_` and the adapter's id.
export const adapterIdOf = (connection: Pick<MarketplaceConnection, 'provider'>): string => connection.provider.replace(/^marketplace_/, '');

// Whether the screen offers "pull the orders now": the connection is live and its adapter is the offline one (a real adapter is polled by the worker on its own schedule).
export const canPollNow = (connection: Pick<MarketplaceConnection, 'provider' | 'status'>, adapters: readonly MarketplaceAdapterInfo[]): boolean =>
  connection.status === 'active' && adapters.some((a) => a.id === adapterIdOf(connection) && a.offline);

// Whether the screen offers "Authorize": the connection is live and its adapter is authorized on the platform's own page (Lazada). The adapter list does not say so, so the one adapter that has the step is named here;
// the server refuses the start for any other (MARKETPLACE_AUTHORIZE_UNSUPPORTED).
export const AUTHORIZED_ADAPTERS: readonly string[] = ['lazada', 'tiktok_shop'];
export const canAuthorize = (connection: Pick<MarketplaceConnection, 'provider' | 'status'>, adapters: readonly MarketplaceAdapterInfo[]): boolean =>
  connection.status === 'active' && AUTHORIZED_ADAPTERS.includes(adapterIdOf(connection)) && adapters.some((a) => a.id === adapterIdOf(connection) && !a.offline);

// The notice on a connection whose seller authorization is running out (#4240 S3b): `soon` from this many days before `reauthorizeBy` (the end of the refresh token, a date the server keeps in the clear),
// `ended` once it has passed (the sweep has then stopped renewing it). Only a connection that was authorized and has a date, and that was not disconnected, has one.
export const REAUTHORIZE_NOTICE_DAYS = 14;
export type ReauthorizeNotice = 'soon' | 'ended';
export const reauthorizeNotice = (connection: Pick<MarketplaceConnection, 'authorizeState' | 'reauthorizeBy' | 'status'>, now: Date): ReauthorizeNotice | null => {
  if (connection.status === 'revoked' || connection.authorizeState !== 'authorized' || !connection.reauthorizeBy) return null;
  const left = Date.parse(connection.reauthorizeBy) - now.getTime();
  if (Number.isNaN(left)) return null;
  if (left <= 0) return 'ended';
  return left <= REAUTHORIZE_NOTICE_DAYS * 86_400_000 ? 'soon' : null;
};

// What the disconnect call sends: the connection, and `deleteStaged` only when the member ticked it AND orders are waiting (#4240 S3b).
export const disconnectInput = (connection: Pick<MarketplaceConnection, 'id' | 'ordersWaiting'>, discard: boolean): { id: string; deleteStaged?: true } =>
  discard && connection.ordersWaiting > 0 ? { id: connection.id, deleteStaged: true } : { id: connection.id };

// The words of the notice: a connection the seller can authorize again says so; one that cannot (it has stopped, so the button is not offered, or the adapter is off) says to connect again.
export const reauthorizeNoticeKey = (notice: ReauthorizeNotice, canAuthorizeAgain: boolean): 'reauthorizeSoon' | 'reauthorizeEnded' | 'reauthorizeReconnect' =>
  canAuthorizeAgain ? (notice === 'soon' ? 'reauthorizeSoon' : 'reauthorizeEnded') : 'reauthorizeReconnect';

// The platforms a connect can name: those an adapter serves.
export const connectablePlatforms = (platforms: readonly MarketplacePlatformInfo[]): MarketplacePlatformInfo[] => platforms.filter((p) => p.adapter);

// The words for a field an adapter asks for, as a message key; a name with no words of its own is shown as it is.
export const fieldLabelKey = (name: string, known: (key: string) => boolean): string | null => (known(`fieldLabels.${name}`) ? `fieldLabels.${name}` : null);

// A field the org types to connect is a secret unless its name says it is a plain identifier: the input hides what is typed.
export const fieldIsSecret = (name: string): boolean => !/^(user|username|account|email|login|appId|appKey|serviceId|clientId|shopId)$/i.test(name);
