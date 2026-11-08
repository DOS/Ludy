// SPDX-License-Identifier: AGPL-3.0-only
// The spend caps judged against what is already committed (W2, issue #2296, plan docs/plan/ads-write.md section 3.3, ADR-0043 point 2). W1's local validation
// judges a plan alone against the caps in force; a launch is judged against the plan AND every launch already live or scheduled, because two plans that
// each fit a cap can pass it together. The caller (the approving command, under the org's lock, and the launch job before its first platform call) reads
// the commitments from the database; this file is the arithmetic only, with no database and no number that is not a decimal.
//
// A commitment is the most a launch can still spend, as the window it can spend in: its daily budget on each day from its first day to its last. The
// last day is the end of the flight, or the day the launch was paused or stopped if that is sooner (what ran up to then counts, what would have run
// after does not), and a launch that never delivered has no commitment at all. A daily cap is checked day by day, a monthly cap month by month, and an
// org cap counts every account of the org (an account cap, that account's alone). A cap in another currency than the plan's is not compared here:
// local validation refuses it (`cap_currency`), since converting would add a rate the approver did not see.
import { Decimal } from 'decimal.js';
import { daysByMonth } from './campaign-plan.ts';
import { addDays } from './domain.ts';

export interface Commitment {
  adAccountId: string;
  currency: string;
  // The daily budget, a decimal string in the account's currency.
  dailyBudget: string;
  // The first and the last day it can spend, both included (YYYY-MM-DD).
  startOn: string;
  endOn: string;
}

export interface CommittedCap {
  scope: 'org' | 'account';
  adAccountId: string | null;
  period: 'daily' | 'monthly';
  amount: string;
  currency: string;
}

// What would pass a cap: which cap, what is committed already, what the plan adds, and the first day (or the month) where it passes.
export interface CommittedProblem {
  code: 'daily_cap_exceeded' | 'monthly_cap_exceeded';
  scope: 'org' | 'account';
  period: 'daily' | 'monthly';
  cap: string;
  committed: string;
  plan: string;
  day?: string;
  month?: string;
}

export interface CommittedPlan {
  adAccountId: string;
  currency: string;
  dailyBudget: string;
  startOn: string;
  endOn: string;
}

const covers = (c: Pick<Commitment, 'startOn' | 'endOn'>, day: string): boolean => c.startOn <= day && day <= c.endOn;

// The days of a window, one by one (a flight is at most 90 days).
function eachDay(startOn: string, endOn: string): string[] {
  const days: string[] = [];
  for (let day = startOn; day <= endOn; day = addDays(day, 1)) days.push(day);
  return days;
}

// The caps a plan would pass given what is committed: none when it fits them all. Empty `others` is the plan against the caps alone.
export function committedProblems(plan: CommittedPlan, others: readonly Commitment[], caps: readonly CommittedCap[]): CommittedProblem[] {
  const problems: CommittedProblem[] = [];
  const planDaily = new Decimal(plan.dailyBudget);
  const planDays = eachDay(plan.startOn, plan.endOn);
  const planMonths = daysByMonth(plan.startOn, plan.endOn);
  // Each commitment's days by month once, for the monthly caps.
  const monthsOf = new Map(others.map((o) => [o, daysByMonth(o.startOn, o.endOn)] as const));
  for (const cap of caps) {
    if (cap.currency !== plan.currency) continue;
    if (cap.scope === 'account' && cap.adAccountId !== plan.adAccountId) continue;
    // What counts towards this cap: an account cap, that account's launches; an org cap, every launch in the cap's currency.
    const counted = others.filter((o) => o.currency === cap.currency && (cap.scope === 'org' || o.adAccountId === plan.adAccountId));
    const limit = new Decimal(cap.amount);
    if (cap.period === 'daily') {
      for (const day of planDays) {
        const committed = counted.filter((o) => covers(o, day)).reduce((sum, o) => sum.plus(o.dailyBudget), new Decimal(0));
        if (committed.plus(planDaily).gt(limit)) {
          problems.push({ code: 'daily_cap_exceeded', scope: cap.scope, period: 'daily', cap: cap.amount, committed: committed.toFixed(), plan: planDaily.toFixed(), day });
          break;
        }
      }
    } else {
      for (const [month, days] of planMonths) {
        const committed = counted.reduce((sum, o) => sum.plus(new Decimal(o.dailyBudget).times(monthsOf.get(o)?.get(month) ?? 0)), new Decimal(0));
        const adds = planDaily.times(days);
        if (committed.plus(adds).gt(limit)) {
          problems.push({ code: 'monthly_cap_exceeded', scope: cap.scope, period: 'monthly', cap: cap.amount, committed: committed.toFixed(), plan: adds.toFixed(), month });
          break;
        }
      }
    }
  }
  return problems;
}
