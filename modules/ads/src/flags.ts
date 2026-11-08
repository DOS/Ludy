// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's deterministic flags (issue #2378, plan docs/plan/ads-write.md): where month-to-date spend is heading against a cap, a
// day that spent far more than its share of a cap, and a campaign whose cost per result jumped. Pure rules, no database and no model: the
// same figures always give the same flags, so a later note of Vy's (#2220) can cite them. Money is a decimal string and every sum, product
// and median goes through decimal.js (AGENTS.md "Money"); amounts of different currencies are never added or compared.
import { Decimal } from 'decimal.js';
import type { AdsFlag } from '@crove/kernel-contract';
import { addDays, currencyDecimals, todayIn } from './domain.ts';

// The thresholds, with the defaults an org gets until it sets its own. `paceMinDays`: days of the month that must be over (today not
// counted) before the pace of the month is judged, so two days of a launch do not project a whole month. `dayFactor`: how many times its
// share of a cap a day may spend. `cprFactor`: how many times its trailing median the cost per result of the last 3 days may be, over at
// least `cprMinResults` results in those days and `cprMinHistoryDays` days with results in the 14 days before them.
export interface FlagThresholds {
  paceMinDays: number;
  dayFactor: string;
  cprFactor: string;
  cprMinResults: number;
  cprMinHistoryDays: number;
}

export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = { paceMinDays: 3, dayFactor: '1.5', cprFactor: '1.5', cprMinResults: 5, cprMinHistoryDays: 5 };

// What the org has set: a threshold it never set is `null`, and the default applies (so a safer default reaches every org that left it).
export type FlagSetting = { [K in keyof FlagThresholds]: FlagThresholds[K] | null };

export const thresholdsFrom = (set: Partial<FlagSetting> | null | undefined): FlagThresholds => ({
  paceMinDays: set?.paceMinDays ?? DEFAULT_FLAG_THRESHOLDS.paceMinDays,
  dayFactor: set?.dayFactor ?? DEFAULT_FLAG_THRESHOLDS.dayFactor,
  cprFactor: set?.cprFactor ?? DEFAULT_FLAG_THRESHOLDS.cprFactor,
  cprMinResults: set?.cprMinResults ?? DEFAULT_FLAG_THRESHOLDS.cprMinResults,
  cprMinHistoryDays: set?.cprMinHistoryDays ?? DEFAULT_FLAG_THRESHOLDS.cprMinHistoryDays,
});

// The last days that are judged and the days before them that make the trailing median.
export const CPR_RECENT_DAYS = 3;
export const CPR_HISTORY_DAYS = 14;

const places = (currency: string): number => currencyDecimals(currency);
const text = (value: Decimal, currency: string): string => value.toDecimalPlaces(places(currency), Decimal.ROUND_HALF_UP).toFixed(places(currency));

export const dayOfMonth = (day: string): number => Number(day.slice(8, 10));
export const monthStartOf = (day: string): string => `${day.slice(0, 8)}01`;
export function daysInMonthOf(day: string): number {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// How the month stands: the days over, today (a partial day) not counted, what was spent in them, and what the same pace spends in the
// whole month (linear: spent over the days over, times the days of the month).
export interface MonthPace {
  elapsedDays: number;
  daysInMonth: number;
  spent: Decimal;
  projected: Decimal;
}

// null before `minDays` days of the month are over (nothing to judge yet).
export function monthPace(input: { today: string; spentBeforeToday: Decimal.Value; minDays: number }): MonthPace | null {
  const elapsedDays = dayOfMonth(input.today) - 1;
  if (elapsedDays < 1 || elapsedDays < input.minDays) return null;
  const daysInMonth = daysInMonthOf(input.today);
  const spent = new Decimal(input.spentBeforeToday);
  // Multiplied before it is divided, so a day's share is not rounded first.
  return { elapsedDays, daysInMonth, spent, projected: spent.times(daysInMonth).div(elapsedDays) };
}

// A flag only when the projection is above the cap, never at it.
export const paceAboveCap = (pace: MonthPace, cap: Decimal.Value): boolean => pace.projected.gt(cap);

// The share of a cap one day may spend: a daily cap is its own share, a monthly cap is spread over the days of the month.
export function dailyShare(cap: { period: 'daily' | 'monthly'; amount: Decimal.Value }, daysInMonth: number): Decimal {
  return cap.period === 'daily' ? new Decimal(cap.amount) : new Decimal(cap.amount).div(daysInMonth);
}

// A day that spent more than `factor` times its share of a cap; the ratio (spend over share, two decimals, rounded up so a flag never
// reads as the threshold it is above) or null. Decided by cross-multiplication, so a monthly cap that does not divide evenly by the days of
// the month is not rounded before it is compared.
export function dayOverShare(input: { spend: Decimal.Value; cap: { period: 'daily' | 'monthly'; amount: Decimal.Value }; daysInMonth: number; factor: Decimal.Value }): string | null {
  const days = input.cap.period === 'daily' ? new Decimal(1) : new Decimal(input.daysInMonth);
  const spend = new Decimal(input.spend);
  const amount = new Decimal(input.cap.amount);
  if (!amount.gt(0) || !spend.times(days).gt(amount.times(input.factor))) return null;
  return spend.times(days).div(amount).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);
}

export interface DayFigure {
  day: string;
  spend: Decimal.Value;
  // The results of the account's chosen kind that day; null when the day has none recorded.
  results: Decimal.Value | null;
}

export interface CprJump {
  recentCost: string;
  medianCost: string;
  ratio: string;
  recentResults: string;
  historyDays: number;
}

// A day's cost per result as the fraction it is (spend over results), so the median and the comparison are exact.
interface Fraction {
  num: Decimal;
  den: Decimal;
}

// The median of fractions, as a fraction: the middle one, or the mean of the two middle ones for an even count.
function medianOf(values: readonly Fraction[]): Fraction {
  const sorted = [...values].sort((a, b) => a.num.times(b.den).cmp(b.num.times(a.den)));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as Fraction;
  const a = sorted[mid - 1] as Fraction;
  const b = sorted[mid] as Fraction;
  return { num: a.num.times(b.den).plus(b.num.times(a.den)), den: a.den.times(b.den).times(2) };
}

// The cost per result of the last 3 days (ending at `lastDay`) against the median of the daily cost per result of the 14 days before
// them. Only days with results count for the median; too few results in the last days or too few days with results before them is not
// enough to judge, so no flag. Above the factor times the median, never at it: decided by cross-multiplication (no division is rounded
// before the comparison), and the ratio is rounded up so a flag never reads as the threshold it is above. Currency-neutral: the caller
// names the currency the figures are in.
export function cprJump(input: { figures: readonly DayFigure[]; lastDay: string; currency: string; thresholds: FlagThresholds }): CprJump | null {
  const recentFrom = addDays(input.lastDay, -(CPR_RECENT_DAYS - 1));
  const historyFrom = addDays(recentFrom, -CPR_HISTORY_DAYS);
  let recentSpend = new Decimal(0);
  let recentResults = new Decimal(0);
  const daily: Fraction[] = [];
  for (const figure of input.figures) {
    const results = figure.results === null ? new Decimal(0) : new Decimal(figure.results);
    if (figure.day >= recentFrom && figure.day <= input.lastDay) {
      recentSpend = recentSpend.plus(figure.spend);
      recentResults = recentResults.plus(results);
    } else if (figure.day >= historyFrom && figure.day < recentFrom && results.gt(0)) {
      daily.push({ num: new Decimal(figure.spend), den: results });
    }
  }
  if (recentResults.lt(input.thresholds.cprMinResults) || daily.length < input.thresholds.cprMinHistoryDays) return null;
  const median = medianOf(daily);
  if (!median.num.gt(0)) return null;
  // recentSpend / recentResults > factor x median.num / median.den, all positive.
  const left = recentSpend.times(median.den);
  const right = median.num.times(recentResults);
  if (!left.gt(right.times(input.thresholds.cprFactor))) return null;
  return {
    recentCost: text(recentSpend.div(recentResults), input.currency),
    medianCost: text(median.num.div(median.den), input.currency),
    ratio: left.div(right).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2),
    recentResults: recentResults.toDecimalPlaces(4).toFixed(),
    historyDays: daily.length,
  };
}

// The first day of the account-level figures the flags read: the start of the month of yesterday, which is at or before the start of the
// month of today (on the 1st, yesterday is the last day of the month before and is the day to judge).
export const accountDaysFrom = (today: string): string => monthStartOf(addDays(today, -1));

// An amount as text in the currency's own number of decimals.
export const flagAmount = (value: Decimal.Value, currency: string): string => text(new Decimal(value), currency);

// ---------------------------------------------------------------------------------------------------------------
// The figures the flags are worked out from (the query loads them) and the evaluation, which is pure: the same figures, caps, thresholds
// and instant always give the same flags.
// ---------------------------------------------------------------------------------------------------------------

export interface FlagAccount {
  id: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
  resultKind: string | null;
  // The last day the sync read, in the account's time zone; an account that has not read yesterday yet is not judged (a month short of a
  // day would only project low).
  syncedThrough: string | null;
}

// The cap in force for one (scope, account, period).
export interface FlagCap {
  scope: 'org' | 'account';
  adAccountId: string | null;
  period: 'daily' | 'monthly';
  amount: string;
  currency: string;
}

export interface FlagInput {
  accounts: readonly FlagAccount[];
  caps: readonly FlagCap[];
  // The account-level rows of the days from the start of the earliest month in play, one per account and day.
  accountDays: readonly { adAccountId: string; day: string; spend: string }[];
  // The campaign-level rows of the last 17 days, with the results of the account's chosen kind (null: none recorded).
  campaignDays: readonly { adAccountId: string; campaignId: string; campaignName: string; day: string; spend: string; results: string | null }[];
}

interface Judged {
  account: FlagAccount & { currency: string; timeZone: string };
  yesterday: string;
  pace: MonthPace | null;
  yesterdaySpend: Decimal;
}

// The flags of the figures at `now`, in a fixed order: pace, then day, then cost per result; the org's caps before each account's, and
// campaigns by name.
export function evaluateFlags(input: FlagInput, now: Date, thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS): AdsFlag[] {
  const spendOf = new Map<string, Map<string, Decimal>>();
  for (const row of input.accountDays) {
    const days = spendOf.get(row.adAccountId) ?? new Map<string, Decimal>();
    days.set(row.day, (days.get(row.day) ?? new Decimal(0)).plus(row.spend));
    spendOf.set(row.adAccountId, days);
  }
  const judged: Judged[] = [];
  for (const account of input.accounts) {
    if (account.currency === null || account.timeZone === null || account.syncedThrough === null) continue;
    const today = todayIn(account.timeZone, now);
    const yesterday = addDays(today, -1);
    if (account.syncedThrough < yesterday) continue;
    const days = spendOf.get(account.id) ?? new Map<string, Decimal>();
    const monthStart = monthStartOf(today);
    let spent = new Decimal(0);
    for (const [day, spend] of days) if (day >= monthStart && day < today) spent = spent.plus(spend);
    judged.push({
      account: account as Judged['account'],
      yesterday,
      pace: monthPace({ today, spentBeforeToday: spent, minDays: thresholds.paceMinDays }),
      yesterdaySpend: days.get(yesterday) ?? new Decimal(0),
    });
  }
  judged.sort((a, b) => a.account.name.localeCompare(b.account.name) || a.account.id.localeCompare(b.account.id));
  const pace: AdsFlag[] = [];
  const day: AdsFlag[] = [];
  // A cap in another currency than the account's is never compared: nothing is converted.
  const caps = [...input.caps].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'org' ? -1 : 1));
  for (const cap of caps) {
    const scoped = judged.filter((j) => j.account.currency === cap.currency && (cap.scope === 'org' || j.account.id === cap.adAccountId));
    if (scoped.length === 0) continue;
    const account = cap.scope === 'account' ? (scoped[0] as Judged).account : null;
    // The accounts of the cap's currency (all of the org's for an org cap) that were not judged because they have not read yesterday yet or have
    // no figures: the org's flag is about the others, and says how many were left out.
    const skippedAccounts = cap.scope === 'org' ? input.accounts.filter((a) => a.currency === cap.currency && !judged.some((j) => j.account.id === a.id)).length : 0;
    const base = { scope: cap.scope, adAccountId: account?.id ?? null, accountName: account?.name ?? null, currency: cap.currency, skippedAccounts };
    if (cap.period === 'monthly') {
      const paced = scoped.filter((j): j is Judged & { pace: MonthPace } => j.pace !== null);
      if (paced.length > 0) {
        const projected = paced.reduce((sum, j) => sum.plus(j.pace.projected), new Decimal(0));
        if (projected.gt(cap.amount)) {
          const first = (paced[0] as Judged & { pace: MonthPace }).pace;
          pace.push({
            kind: 'pace',
            ...base,
            cap: flagAmount(cap.amount, cap.currency),
            spent: flagAmount(paced.reduce((sum, j) => sum.plus(j.pace.spent), new Decimal(0)), cap.currency),
            projected: flagAmount(projected, cap.currency),
            elapsedDays: first.elapsedDays,
            daysInMonth: first.daysInMonth,
          });
        }
      }
    }
    const first = scoped[0] as Judged;
    const daysInMonth = daysInMonthOf(first.yesterday);
    const share = dailyShare(cap, daysInMonth);
    const spend = scoped.reduce((sum, j) => sum.plus(j.yesterdaySpend), new Decimal(0));
    const ratio = dayOverShare({ spend, cap, daysInMonth, factor: thresholds.dayFactor });
    if (ratio !== null) {
      day.push({ kind: 'day', ...base, period: cap.period, cap: flagAmount(cap.amount, cap.currency), share: flagAmount(share, cap.currency), day: first.yesterday, spend: flagAmount(spend, cap.currency), ratio });
    }
  }
  const cpr: AdsFlag[] = [];
  type Campaign = { name: string; nameDay: string; figures: DayFigure[] };
  const campaignsOf = new Map<string, Map<string, Campaign>>();
  for (const row of input.campaignDays) {
    const campaigns = campaignsOf.get(row.adAccountId) ?? new Map<string, Campaign>();
    const campaign = campaigns.get(row.campaignId) ?? { name: row.campaignName, nameDay: row.day, figures: [] };
    // The name is the latest one the campaign carried (a rename inside the days read), whatever the order the rows come in.
    if (row.day > campaign.nameDay) {
      campaign.name = row.campaignName;
      campaign.nameDay = row.day;
    }
    campaign.figures.push({ day: row.day, spend: row.spend, results: row.results });
    campaigns.set(row.campaignId, campaign);
    campaignsOf.set(row.adAccountId, campaigns);
  }
  for (const j of judged) {
    if (j.account.resultKind === null) continue;
    const campaigns = [...(campaignsOf.get(j.account.id) ?? [])].sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]));
    for (const [campaignId, campaign] of campaigns) {
      const jump = cprJump({ figures: campaign.figures, lastDay: j.yesterday, currency: j.account.currency, thresholds });
      if (jump) cpr.push({ kind: 'cpr', adAccountId: j.account.id, accountName: j.account.name, campaignId, campaignName: campaign.name, currency: j.account.currency, day: j.yesterday, ...jump });
    }
  }
  return [...pace, ...day, ...cpr];
}
