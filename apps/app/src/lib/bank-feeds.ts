// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (ADR-0039, #2099): what the screen works out from the API's answers. The server
// decides every rule; these only choose what to show.
import { BANK_FEED_FIRST_PULL_DAYS, vietnamToday, type BankFeedAccountView } from '@crove/kernel-contract';
import type { ChartAccount } from './accounts.ts';

// A bank feed adapter this deployment offers (`/api/config` bankFeeds): none, and the card is not drawn at all, so
// `docker compose up` shows nothing about banks.
type BankFeedConfig = { sandbox: boolean; tingee?: boolean | undefined };
export const bankFeedOffered = (config: { bankFeeds?: BankFeedConfig | undefined }): boolean => Boolean(config.bankFeeds?.sandbox || config.bankFeeds?.tingee);

// Whether Settings draws the card: the finance module is on and the deployment offers a feed.
export const showsBankFeeds = (config: { modules: readonly string[]; bankFeeds?: BankFeedConfig | undefined }): boolean => config.modules.includes('finance') && bankFeedOffered(config);

// The org's bank accounts a feed can fill: TT133 accounts under 112 and their sub-accounts (the 112 group itself holds
// none), those in use, plus the one already mapped even if it was deactivated since, so the picker is never blank.
export function bankAccountChoices(accounts: readonly ChartAccount[], current?: string | null): ChartAccount[] {
  return accounts.filter((a) => a.rootCode.startsWith('112') && a.code !== '112' && (a.active || a.code === current));
}

export interface FeedAccountRow {
  externalAccountId: string;
  displayName: string;
  // The mapping this account has, if any.
  mapped: BankFeedAccountView | null;
  // A mapped account the provider's last listing no longer holds: it keeps its mapping and lines, and is not pulled.
  gone: boolean;
}

// The accounts of one connection: those the worker listed (with their mapping when there is one), then the mapped ones
// the provider no longer lists. `listed` is null while the listing is unknown, and then nothing is called gone.
export function feedAccountRows(
  listed: ReadonlyArray<{ externalAccountId: string; displayName: string }> | null,
  mapped: readonly BankFeedAccountView[],
): FeedAccountRow[] {
  const byExternal = new Map(mapped.map((m) => [m.externalAccountId, m] as const));
  const rows: FeedAccountRow[] = (listed ?? []).map((a) => ({ externalAccountId: a.externalAccountId, displayName: a.displayName, mapped: byExternal.get(a.externalAccountId) ?? null, gone: false }));
  if (listed === null) return rows.concat(mapped.map((m) => ({ externalAccountId: m.externalAccountId, displayName: m.externalAccountId, mapped: m, gone: false })));
  const seen = new Set(rows.map((r) => r.externalAccountId));
  for (const m of mapped) if (!seen.has(m.externalAccountId)) rows.push({ externalAccountId: m.externalAccountId, displayName: m.externalAccountId, mapped: m, gone: true });
  return rows;
}

// The mappings of one connection, from the list of every mapping the caller reads.
export const mappedOf = (mapped: readonly BankFeedAccountView[], connectionId: string): BankFeedAccountView[] => mapped.filter((m) => m.connectionId === connectionId);

// The earliest day a cut-over may be set to (#4218), as the date input's `min`: what the server says for a mapped account, else the
// day the provider's first pull reaches. The server refuses an earlier one either way.
export function feedFromMin(provider: string, mapped: BankFeedAccountView | null, now: Date = new Date()): string | undefined {
  if (mapped) return mapped.feedFromEarliest ?? undefined;
  const days = BANK_FEED_FIRST_PULL_DAYS[provider] ?? 0;
  return new Date(Date.parse(`${vietnamToday(now)}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// The address a business pastes in its Tingee portal as the webhook (#4204): the API's origin plus the provider's hook path and the key
// (22 base64url characters, so nothing in it needs escaping). A trailing slash on the origin is dropped.
export const hookAddress = (origin: string, provider: string, key: string): string => `${origin.replace(/\/+$/, '')}/api/bank-feed/${provider}/webhook/${key}`;

// The most recent sync among a connection's mapped accounts (ISO strings compare in time order), or null when none has pulled yet.
export const latestSync = (mapped: readonly BankFeedAccountView[]): string | null =>
  mapped.reduce<string | null>((latest, m) => (m.lastSyncedAt && (latest === null || m.lastSyncedAt > latest) ? m.lastSyncedAt : latest), null);
