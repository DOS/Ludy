// SPDX-License-Identifier: AGPL-3.0-only
// The committed spend of a month on the Ads screen (issue #3297, plan docs/plan/ads-write.md sections 3.3, 8 and 9): next to the actual spend, what the launches
// that still commit can spend in the month, the monthly cap and the room left, for the account and for the org, in the account's currency. A read only: it
// writes nothing, posts nothing to the books and calls no model. The sum is the lock's own (launch-caps.ts: countedFor and committedInMonth are what the monthly
// caps are checked with, and the commitments come from the same definer, crove_ads.launch_commitments), so what the screen shows and what the next approval is
// judged against cannot drift. Money is a decimal string and every sum goes through decimal.js (AGENTS.md "Money").
import { Decimal } from 'decimal.js';
import type { MemberRole } from '@crove/db';
import { zAdsCommittedInput, type AdsCommitted, type AdsCommittedLine } from '@crove/kernel-contract';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { contextBase } from './campaign-draft.ts';
import { committedInMonth, countedFor, type Commitment, type CommittedCap } from './launch-caps.ts';
import { committedLaunches } from './launch-ledger.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// One scope's line: what is committed in the month by the launches the scope counts, the monthly cap of that scope in the currency (the account's cap against the
// account's launches, the org's against every launch of the currency) and the room left, which is below zero when a cap was lowered under what is committed.
function line(commitments: readonly Commitment[], caps: readonly CommittedCap[], scope: 'org' | 'account', input: { month: string; adAccountId: string; currency: string }): AdsCommittedLine {
  const committed = committedInMonth(countedFor(commitments, scope, input.currency, input.adAccountId), input.month);
  const cap = caps.find((c) => c.scope === scope && c.period === 'monthly' && c.currency === input.currency && (scope === 'org' || c.adAccountId === input.adAccountId));
  return { committed: committed.toFixed(), cap: cap?.amount ?? null, left: cap ? new Decimal(cap.amount).minus(committed).toFixed() : null };
}

// The committed spend of one account's month, from the commitments of the org that overlap it and the caps in force. Pure: the query below reads both.
export function committedSpend(input: { month: string; adAccountId: string; currency: string; commitments: readonly Commitment[]; caps: readonly CommittedCap[] }): AdsCommitted {
  // A cap counts for this account when it is in the account's currency and is the org's or the account's own (the lock skips the others, local validation refuses
  // a plan against a cap in another currency: `cap_currency`). One cap, daily or monthly, is enough to launch; none means every launch is refused.
  const applies = input.caps.filter((c) => c.currency === input.currency && (c.scope === 'org' || c.adAccountId === input.adAccountId));
  const shared = { month: input.month, adAccountId: input.adAccountId, currency: input.currency };
  return {
    adAccountId: input.adAccountId,
    month: input.month,
    currency: input.currency,
    hasCap: applies.length > 0,
    // The caps that would apply by scope but are in another currency: the plan check refuses a launch against them (`cap_currency`), whatever else is set.
    capCurrencyMismatch: input.caps.some((c) => c.currency !== input.currency && (c.scope === 'org' || c.adAccountId === input.adAccountId)),
    account: line(input.commitments, applies, 'account', shared),
    org: line(input.commitments, applies, 'org', shared),
  };
}

// The first day of a month ('YYYY-MM'): committedLaunches reads the whole month a day of it falls in.
const firstOf = (month: string): string => `${month}-01`;

export const adsCommitted = defineQuery({
  name: 'ads.committed',
  input: zAdsCommittedInput,
  // The caps are read by owners and admins (ads.write.state); the figure that sits next to them is theirs too.
  access: MANAGERS,
  handler: async (ctx: QueryContext, input): Promise<AdsCommitted> => {
    const account = await ctx.trx.selectFrom('crove_ads.ad_account').select(['id', 'currency']).where('org_id', '=', ctx.orgId).where('id', '=', input.adAccountId).executeTakeFirst();
    // An account the caller does not read is hidden by the entity policy: it is not found.
    if (!account) throw new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
    if (!account.currency) throw new DomainError('ADS_CURRENCY_UNKNOWN', 409, 'Tài khoản này chưa đọc được đơn vị tiền');
    const base = await contextBase(ctx, account.id);
    // The commitments of the whole org (an org cap counts every account, whatever entities the caller reads), for the month alone.
    const commitments = await committedLaunches(ctx, account.currency, firstOf(input.month), firstOf(input.month));
    return committedSpend({ month: input.month, adAccountId: account.id, currency: account.currency, commitments, caps: base.caps });
  },
});

export const committedQueries = [adsCommitted];
