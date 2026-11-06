// SPDX-License-Identifier: AGPL-3.0-only
// What the Ads screen says in the deterministic 7-day comparison note (#2220): side-by-side platform breakdown (spend change,
// cost per result change) and the campaign that moved the most across connected platforms, in the reader's language, per currency.
import type { AdsWeeklyCampaignMove, AdsWeeklyNote, AdsWeeklyPlatformNote } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';
import { adProviderName, isNamedResultKind, isSandboxProvider, signedMoney } from './ads.ts';
import type { FlagFormat } from './ads-flags.ts';

function providerLabel(t: Translate, provider: string): string {
  return isSandboxProvider(provider) ? t('ads.sandboxBadge') : adProviderName(provider);
}

function resultKindLabel(t: Translate, kind: string): string {
  return isNamedResultKind(kind) ? t(`ads.resultKinds.${kind}`).toLowerCase() : kind;
}

export function weeklyWindowLine(t: Translate, f: FlagFormat, note: AdsWeeklyNote): string {
  const money = (value: string) => f.money(value, note.currency);
  return t('ads.weeklyNote.window', {
    recentFrom: f.date(note.recentFrom),
    recentTo: f.date(note.recentTo),
    priorFrom: f.date(note.priorFrom),
    priorTo: f.date(note.priorTo),
    recentSpend: money(note.recentSpend),
    priorSpend: money(note.priorSpend),
    spendDelta: signedMoney(note.spendDelta, money),
  });
}

export function weeklyPlatformLine(t: Translate, f: FlagFormat, currency: string, platform: AdsWeeklyPlatformNote): string {
  const money = (value: string) => f.money(value, currency);
  const provider = providerLabel(t, platform.provider);
  if (
    platform.resultKind !== null &&
    platform.recentCostPerResult !== null &&
    platform.priorCostPerResult !== null &&
    platform.cprDelta !== null &&
    platform.recentResults !== null
  ) {
    return t('ads.weeklyNote.platformWithCpr', {
      provider,
      recentSpend: money(platform.recentSpend),
      priorSpend: money(platform.priorSpend),
      spendDelta: signedMoney(platform.spendDelta, money),
      resultKind: resultKindLabel(t, platform.resultKind),
      recentCpr: money(platform.recentCostPerResult),
      priorCpr: money(platform.priorCostPerResult),
      cprDelta: signedMoney(platform.cprDelta, money),
      results: platform.recentResults,
    });
  }
  return t('ads.weeklyNote.platformSpend', {
    provider,
    recentSpend: money(platform.recentSpend),
    priorSpend: money(platform.priorSpend),
    spendDelta: signedMoney(platform.spendDelta, money),
  });
}

export function weeklyTopMoverLine(t: Translate, f: FlagFormat, currency: string, move: AdsWeeklyCampaignMove): string {
  const money = (value: string) => f.money(value, currency);
  return t('ads.weeklyNote.topMover', {
    campaign: move.campaignName,
    account: move.accountName,
    provider: providerLabel(t, move.provider),
    recentSpend: money(move.recentSpend),
    priorSpend: money(move.priorSpend),
    spendDelta: signedMoney(move.spendDelta, money),
  });
}

export function weeklySkippedLine(t: Translate, note: AdsWeeklyNote): string | null {
  if (note.skippedAccounts <= 0) return null;
  return t('ads.weeklyNote.skipped', { currency: note.currency, count: String(note.skippedAccounts) });
}
