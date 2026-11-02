// SPDX-License-Identifier: AGPL-3.0-only
// What the Ads screen says about the second connection of an ad account, the one that can run ads (ADR-0043, issue #2294, W0b).
// The server decides what an account can do (`canRunAds`, `writeConnectionStatus`); these only pick the words. Closing that
// connection drops its token from Ludy at once, but the platform still holds the permission until the owner removes it in the
// platform's own settings, so every place that closes one says so (the owner's switch-off of running ads, the withdrawal of
// one account, and the disconnect of an account), in the reader's language.
import type { AdAccountView } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';
import { isSandboxProvider } from './ads.ts';

type WriteFacts = Pick<AdAccountView, 'provider' | 'writeConnectionStatus'>;

// A write connection that is not closed yet: one that can run ads, or one that expired or failed and still holds its sealed token.
export const hasOpenWriteConnection = (account: Pick<AdAccountView, 'writeConnectionStatus'>): boolean =>
  account.writeConnectionStatus !== null && account.writeConnectionStatus !== 'revoked';

// An open write connection of a real platform: closing it leaves the permission with the platform until it is removed there. The
// sandbox is offline, so it holds nothing anywhere.
export const keepsPlatformGrant = (account: WriteFacts): boolean => hasOpenWriteConnection(account) && !isSandboxProvider(account.provider);

// The connection to run ads existed and is not live now (expired, failed or closed): the owner can connect it again.
export const writeConnectionStopped = (account: Pick<AdAccountView, 'writeConnectionStatus' | 'canRunAds'>): boolean => account.writeConnectionStatus !== null && !account.canRunAds;

const join = (...parts: Array<string | false>): string => parts.filter((part): part is string => part !== false).join(' ');

// The question before the owner turns running ads off: what stops, that every connection that can run ads is closed with it, and,
// where a real platform is involved, that the permission stays with the platform until the app is removed there.
export function disableConfirmText(t: Translate, accounts: readonly WriteFacts[]): string {
  return join(t('ads.write.disableBody'), accounts.some(hasOpenWriteConnection) && t('ads.write.disableClosesConnections'), accounts.some(keepsPlatformGrant) && t('ads.write.platformNote'));
}

// After the switch-off: it says so, and, when connections were closed on an org with a real platform's account, the same note. The
// answer carries only how many were closed, so an org with any real platform account is told (never the other way: a missed note
// would leave the owner thinking the permission is gone).
export function disabledToastText(t: Translate, accounts: readonly Pick<AdAccountView, 'provider'>[], connectionsClosed: number): string {
  return join(t('ads.write.disabledToast'), connectionsClosed > 0 && accounts.some((a) => !isSandboxProvider(a.provider)) && t('ads.write.platformNote'));
}

// After withdrawing one account: the note when its connection was closed and it belongs to a real platform.
export function accountOffToastText(t: Translate, account: Pick<AdAccountView, 'provider'>, connectionsClosed: number): string {
  return join(t('ads.write.accountOffToast'), connectionsClosed > 0 && !isSandboxProvider(account.provider) && t('ads.write.platformNote'));
}

// The question before an account is disconnected: the read connection stops, and so does the connection to run ads where there is one.
export function disconnectConfirmText(t: Translate, account: WriteFacts & Pick<AdAccountView, 'name'>): string {
  return join(t('ads.settings.disconnectBody', { name: account.name }), hasOpenWriteConnection(account) && t('ads.settings.disconnectClosesWrite'), keepsPlatformGrant(account) && t('ads.write.platformNote'));
}
