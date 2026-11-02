// SPDX-License-Identifier: AGPL-3.0-only
// What the Ads screen says about a flag (issue #2378): the server decides which flags there are, from the stored figures with fixed rules and
// no model; these only pick the words, in the reader's language, with the numbers each flag is based on. An amount keeps its own currency.
import type { AdsFlag } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';

export interface FlagFormat {
  money: (value: string | null | undefined, currency?: string) => string;
  date: (value: string | null | undefined) => string;
}

export function flagText(t: Translate, f: FlagFormat, flag: AdsFlag): string {
  switch (flag.kind) {
    case 'pace':
      return t(flag.scope === 'org' ? 'ads.flags.paceOrg' : 'ads.flags.paceAccount', {
        account: flag.accountName ?? '',
        projected: f.money(flag.projected, flag.currency),
        cap: f.money(flag.cap, flag.currency),
        spent: f.money(flag.spent, flag.currency),
        elapsed: String(flag.elapsedDays),
        days: String(flag.daysInMonth),
      });
    case 'day':
      return t(flag.scope === 'org' ? 'ads.flags.dayOrg' : 'ads.flags.dayAccount', {
        account: flag.accountName ?? '',
        spend: f.money(flag.spend, flag.currency),
        day: f.date(flag.day),
        ratio: flag.ratio,
        period: t(flag.period === 'daily' ? 'ads.flags.periodDaily' : 'ads.flags.periodMonthly'),
        share: f.money(flag.share, flag.currency),
        cap: f.money(flag.cap, flag.currency),
      });
    case 'cpr':
      return t('ads.flags.cpr', {
        campaign: flag.campaignName,
        account: flag.accountName,
        recent: f.money(flag.recentCost, flag.currency),
        ratio: flag.ratio,
        median: f.money(flag.medianCost, flag.currency),
        results: flag.recentResults,
      });
  }
}

// A stable key for a list of flags: the kind and what it is about.
export function flagKey(flag: AdsFlag): string {
  switch (flag.kind) {
    case 'pace':
      return `pace:${flag.scope}:${flag.adAccountId ?? ''}`;
    case 'day':
      return `day:${flag.scope}:${flag.adAccountId ?? ''}:${flag.period}`;
    case 'cpr':
      return `cpr:${flag.adAccountId}:${flag.campaignId}`;
  }
}
