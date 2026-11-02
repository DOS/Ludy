// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of a campaign plan (W1, issue #2295, plan docs/plan/ads-write.md sections 3.2, 3.3 and 10): how long the flight is, the largest amount
// it can spend, what local validation says about a plan, and the hash that binds a submitted plan to its approval. No database and no model: the same
// plan and the same caps always give the same answer, so a draft the AI coworker wrote is judged exactly as one a person wrote. Money is a decimal string
// and every product and comparison goes through decimal.js (AGENTS.md "Money"); amounts of different currencies are never compared.
import { Decimal } from 'decimal.js';
import { ADS_PLAN_LIMITS, zAdsCampaignPlan, type AdsCampaignPlan, type AdsCampaignPlanDraft, type AdsPlanIssue } from '@crove/kernel-contract';
import { sha256Hex } from '@crove/kernel-runtime';
import { currencyDecimals } from './domain.ts';

const DAY = 24 * 60 * 60 * 1000;

// The days of a flight, the start and the end day both included; null when either is missing or the end is before the start.
export function flightDays(startOn: string | null | undefined, endOn: string | null | undefined): number | null {
  if (!startOn || !endOn) return null;
  const days = Math.round((Date.parse(`${endOn}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / DAY) + 1;
  return Number.isFinite(days) && days >= 1 ? days : null;
}

// The largest amount the plan can spend: the daily budget times the days of the flight, as a decimal string in the budget's own units.
export function maxSpendOf(dailyBudget: string, days: number): string {
  return new Decimal(dailyBudget).times(days).toFixed();
}

// The days of the flight in each calendar month it touches ('YYYY-MM' to a count), for the monthly caps.
export function daysByMonth(startOn: string, endOn: string): Map<string, number> {
  const months = new Map<string, number>();
  const last = Date.parse(`${endOn}T00:00:00Z`);
  for (let t = Date.parse(`${startOn}T00:00:00Z`); t <= last; t += DAY) {
    const month = new Date(t).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  return months;
}

// What the validation needs to know about the account and the org, read from the database by the caller.
export interface PlanContext {
  // The account's own date today (its time zone), 'YYYY-MM-DD'.
  today: string;
  // The account's currency; null before its first sync.
  currency: string | null;
  // The caps in force (the latest row of each scope, account and period).
  caps: ReadonlyArray<{ scope: 'org' | 'account'; adAccountId: string | null; period: 'daily' | 'monthly'; amount: string; currency: string }>;
  adAccountId: string;
  // The org's switch, the account's flag and the block on launches (W0): none of them is a reason not to draft, all of them are to submit.
  writeEnabled: boolean;
  accountWriteEnabled: boolean;
  launchesBlocked: boolean;
  // Whether the Page a Messenger ad names is a connection of the org (null when no Page is named).
  pageOk: boolean | null;
}

const issue = (severity: AdsPlanIssue['severity'], code: string, field: string | null, params: AdsPlanIssue['params'] = {}): AdsPlanIssue => ({ code, severity, field, params });

// What local validation says about a plan in progress. An error stops a submission; a warning only tells. `maxSpend` and `days` are what the card shows.
export function validatePlan(draft: AdsCampaignPlanDraft, context: PlanContext): { issues: AdsPlanIssue[]; maxSpend: string | null; days: number | null } {
  const issues: AdsPlanIssue[] = [];
  const error = (code: string, field: string | null, params?: AdsPlanIssue['params']) => issues.push(issue('error', code, field, params));
  const warning = (code: string, field: string | null, params?: AdsPlanIssue['params']) => issues.push(issue('warning', code, field, params));

  // What is still missing, in the order the builder asks for it.
  const missing: string[] = [];
  if (!draft.dailyBudget) missing.push('dailyBudget');
  if (!draft.startOn) missing.push('startOn');
  if (!draft.endOn) missing.push('endOn');
  if (!draft.targeting) missing.push('targeting');
  if (!draft.variants || draft.variants.length === 0) missing.push('variants');
  if (draft.objective !== 'messenger' && !draft.linkUrl) missing.push('linkUrl');
  if (draft.objective === 'messenger' && !draft.pageConnectionId) missing.push('pageConnectionId');
  for (const field of missing) error('missing_field', field);

  const days = flightDays(draft.startOn, draft.endOn);
  if (draft.startOn && draft.endOn && days === null) error('end_before_start', 'endOn');
  if (draft.startOn && draft.startOn < context.today) error('start_in_past', 'startOn', { today: context.today });
  if (days !== null && days > ADS_PLAN_LIMITS.daysMax) error('flight_too_long', 'endOn', { days, max: ADS_PLAN_LIMITS.daysMax });

  if (draft.targeting && draft.targeting.ageMin > draft.targeting.ageMax) error('age_range', 'targeting', { ageMin: draft.targeting.ageMin, ageMax: draft.targeting.ageMax });
  if (draft.targeting && draft.targeting.interests.length !== new Set(draft.targeting.interests.map((i) => i.toLowerCase())).size) warning('interests_repeated', 'targeting');

  for (const [index, variant] of (draft.variants ?? []).entries()) {
    if ([...variant.headline].length > ADS_PLAN_LIMITS.headlineSoft) warning('headline_long', 'variants', { variant: index + 1, soft: ADS_PLAN_LIMITS.headlineSoft });
    if ([...variant.primaryText].length > ADS_PLAN_LIMITS.primaryTextSoft) warning('primary_text_long', 'variants', { variant: index + 1, soft: ADS_PLAN_LIMITS.primaryTextSoft });
    if (draft.objective === 'messenger' && variant.callToAction !== 'send_message') warning('messenger_call_to_action', 'variants', { variant: index + 1 });
  }
  if (draft.objective === 'messenger' && draft.pageConnectionId && context.pageOk === false) error('page_not_found', 'pageConnectionId');

  // The money: a currency to be in, whole units where the currency has no cents, and the caps.
  const currency = context.currency;
  if (currency === null) error('account_currency_unknown', null);
  let maxSpend: string | null = null;
  if (draft.dailyBudget) {
    const budget = new Decimal(draft.dailyBudget);
    if (currency !== null && budget.decimalPlaces() > currencyDecimals(currency)) error('budget_decimals', 'dailyBudget', { currency, decimals: currencyDecimals(currency) });
    if (days !== null) maxSpend = maxSpendOf(draft.dailyBudget, days);
    if (currency !== null) {
      const caps = context.caps.filter((c) => c.scope === 'org' || c.adAccountId === context.adAccountId);
      // A cap in another currency is not compared (a launch is refused with ADS_CAP_CURRENCY until every org cap that applies is in the account's).
      if (caps.some((c) => c.currency !== currency)) error('cap_currency', null, { currency });
      const usable = caps.filter((c) => c.currency === currency);
      // At least one cap in force, the account's or the org's, daily or monthly (no cap, no launch: Q3 A, plan section 3.3); the plan is judged against
      // every cap that exists.
      if (usable.length === 0 && !caps.some((c) => c.currency !== currency)) error('no_cap', null);
      for (const cap of usable.filter((c) => c.period === 'daily')) {
        if (budget.gt(cap.amount)) error('daily_cap_exceeded', 'dailyBudget', { scope: cap.scope, cap: cap.amount, budget: draft.dailyBudget });
      }
      if (draft.startOn && draft.endOn && days !== null && days <= ADS_PLAN_LIMITS.daysMax) {
        for (const [month, count] of daysByMonth(draft.startOn, draft.endOn)) {
          const spend = budget.times(count);
          for (const cap of usable.filter((c) => c.period === 'monthly')) {
            if (spend.gt(cap.amount)) error('monthly_cap_exceeded', 'dailyBudget', { scope: cap.scope, cap: cap.amount, month, spend: spend.toFixed() });
          }
        }
      }
    }
  }

  // Running ads has to be switched on for the org and the account, and not blocked: to draft is free, to submit is not.
  if (!context.writeEnabled) error('writing_off', null);
  else if (!context.accountWriteEnabled) error('account_not_enabled', null);
  if (context.launchesBlocked) error('launches_blocked', null);
  return { issues, maxSpend, days };
}

// The complete plan, when the draft has everything the plan needs (and nothing more); null while it does not.
export function completePlan(draft: AdsCampaignPlanDraft): AdsCampaignPlan | null {
  const parsed = zAdsCampaignPlan.safeParse({
    name: draft.name,
    objective: draft.objective,
    dailyBudget: draft.dailyBudget,
    startOn: draft.startOn,
    endOn: draft.endOn,
    targeting: draft.targeting,
    linkUrl: draft.linkUrl ?? null,
    pageConnectionId: draft.pageConnectionId ?? null,
    sourcePostId: draft.sourcePostId ?? null,
    mediaFileId: draft.mediaFileId ?? null,
    variants: draft.variants,
  });
  return parsed.success ? parsed.data : null;
}

// JSON with the keys in order and no spaces, so a hash does not depend on how an object was built.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The hash that binds a submitted plan: the account, its currency and the plan itself. A change to a budget, a date, a creative or the account after
// the request is a different hash, so an approval of the old plan runs nothing (plan section 3.2).
export function planHash(plan: AdsCampaignPlan, adAccountId: string, currency: string): string {
  return `sha256:${sha256Hex(new TextEncoder().encode(canonicalJson({ adAccountId: adAccountId.toLowerCase(), currency, plan })))}`;
}
