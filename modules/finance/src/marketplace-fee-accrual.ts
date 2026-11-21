// SPDX-License-Identifier: AGPL-3.0-only
// What the Sàn work list offers for the month-end accrual of platform fees (#2516 rework, slice F, option 2 of the Accounting PO; plan docs/plan/stock-and-marketplaces.md section 8.4). Facts read from the
// ledger at the time of the request, never from a model, and the lines a person asks to have posted as an ordinary general journal voucher (finance.journal_voucher.prepare / record):
// - an ACCRUAL for a platform and the last month that has ended: Dr 6421 (the map's feeExpense; 641 under TT99, which has no marketplace map yet) / Cr 335 for the platform's debit balance on 331 at the end
//   of that month (the fees it kept at payouts whose invoice has not cleared them). Title "Trích trước phí sàn tháng MM/YYYY, ước tính". Once per platform and month: a month already accrued
//   (reversed or not) is not offered again, and none while an earlier accrual of the platform stands (the generic voucher commands refuse it too, marketplace-fee-accrual-guard.ts);
// - a REVERSAL of the standing accrual from the first day of the month after it: the generic `finance.journal.reverse` mirrors it, dated the first day of that month, so the invoice's own expense is not
//   counted twice (the next accrual then covers the whole outstanding balance again).
// Companies only: an entity of kind household keeps simplified books (Circular 152) and no accrual. An entity whose books have no map (TT99 today), a month in a locked period, and a platform with no debit
// balance get no offer. The map's rows are `commentary` until the accountant confirms them, and the screen keeps the buttons locked until then (the work list's postingConfirmed).
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';
import { money, toMoney } from '@ludy/l10n-vn';
import { REVERSAL_KIND } from './reversal.ts';
import type { MarketplacePostingMap } from './marketplace-posting-map.ts';
import { feeAccrualDescription, feeAccrualsOf, pendingFeeAccrualProposal } from './marketplace-fee-accrual-guard.ts';
import { lastDayOf } from './marketplace-settlement-months.ts';
import { booksOn } from './payroll-posting.ts';
import { addDays } from './domain/payment-reminder.ts';
import { periodLockedThrough } from './period-lock.ts';

export interface FeeAccrualOffer {
  legalEntityId: string;
  platform: string;
  month: string;
  // The date of the entry: the last day of the month.
  date: string;
  amount: string;
  expenseAccount: string;
  accruedAccount: string;
  description: string;
  proposalId: string | null;
}

export interface FeeAccrualReversalOffer {
  legalEntityId: string;
  platform: string;
  month: string;
  entryId: string;
  amount: string;
  // The first day of the month after the accrual's.
  reverseOn: string;
  proposalId: string | null;
}

type Maps = Readonly<Record<string, MarketplacePostingMap>>;

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

// The last month that has ended on `today`: this one on its last day, else the one before.
export const lastEndedMonth = (today: string): string => (today === lastDayOf(today.slice(0, 7)) ? today.slice(0, 7) : previousMonth(today.slice(0, 7)));

export async function feeAccrualOffers(
  ctx: QueryContext,
  legalEntityId: string | undefined,
  today: string,
  maps: Maps,
  platformName: (platform: string) => string,
): Promise<{ accruals: FeeAccrualOffer[]; reversals: FeeAccrualReversalOffer[] }> {
  let links = ctx.trx
    .selectFrom('crove_finance.marketplace_party as m')
    .innerJoin('crove_kernel.legal_entity as le', (join) => join.onRef('le.org_id', '=', 'm.org_id').onRef('le.id', '=', 'm.legal_entity_id'))
    .select(['m.legal_entity_id', 'm.platform', 'm.party_id', 'le.kind'])
    .where('m.org_id', '=', ctx.orgId);
  if (legalEntityId !== undefined) links = links.where('m.legal_entity_id', '=', legalEntityId);
  const accruals: FeeAccrualOffer[] = [];
  const reversals: FeeAccrualReversalOffer[] = [];
  const month = lastEndedMonth(today);
  const date = lastDayOf(month);
  for (const link of await links.orderBy('m.platform').orderBy('m.legal_entity_id').execute()) {
    // A household keeps no accrual.
    if (link.kind === 'household') continue;
    const { standing, everMonths } = await feeAccrualsOf(ctx, link.legal_entity_id, link.platform);
    const lockedThrough = await periodLockedThrough(ctx, link.legal_entity_id);
    if (standing.length > 0) {
      // A standing accrual is reversed from the first day of the month after it; nothing new is offered before.
      for (const s of standing) {
        const firstDay = `${nextMonth(s.month)}-01`;
        if (today < firstDay) continue;
        // A locked period refuses an entry dated inside it: the reversal is dated the day after the lock when that is later.
        const reverseOn = lockedThrough && lockedThrough >= firstDay ? addDays(lockedThrough, 1) : firstDay;
        const lines = await ctx.trx
          .selectFrom('crove_finance.journal_line')
          .select((eb) => eb.fn.sum<string>('credit').as('credit'))
          .where('org_id', '=', ctx.orgId)
          .where('entry_id', '=', s.entryId)
          .executeTakeFirst();
        const proposal = await ctx.trx
          .selectFrom('crove_kernel.proposal')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('kind', '=', REVERSAL_KIND)
          .where('status', 'in', ['pending', 'approved'])
          .where(sql<string>`pg_catalog.lower(payload->>'entryId')`, '=', s.entryId.toLowerCase())
          .orderBy('created_at')
          .executeTakeFirst();
        reversals.push({ legalEntityId: link.legal_entity_id, platform: link.platform, month: s.month, entryId: s.entryId, amount: toMoney(money(lines?.credit ?? '0')), reverseOn, proposalId: proposal?.id ?? null });
      }
      continue;
    }
    if (everMonths.has(month)) continue;
    if (lockedThrough && date <= lockedThrough) continue;
    const regime = (await booksOn(ctx, link.legal_entity_id, date)).regime;
    const map = Object.hasOwn(maps, regime) ? maps[regime] : undefined;
    if (!map) continue;
    // The fees the platform kept, as the books say at the end of the month: its debit balance on 331 (a credit balance is an invoice no fee waited for, and nothing to accrue).
    const balance = await ctx.trx
      .selectFrom('crove_finance.journal_line as l')
      .innerJoin('crove_finance.journal_entry as e', (join) => join.onRef('e.org_id', '=', 'l.org_id').onRef('e.id', '=', 'l.entry_id'))
      .select(sql<string>`coalesce(sum(l.debit) - sum(l.credit), 0)`.as('balance'))
      .where('l.org_id', '=', ctx.orgId)
      .where('l.legal_entity_id', '=', link.legal_entity_id)
      .where('l.party_id', '=', link.party_id)
      .where('l.account_code', 'like', '331%')
      .where('e.entry_date', '<=', date)
      .executeTakeFirst();
    const amount = money(balance?.balance ?? '0');
    if (!amount.greaterThan(0) || !amount.isInteger()) continue;
    accruals.push({
      legalEntityId: link.legal_entity_id,
      platform: link.platform,
      month,
      date,
      amount: toMoney(amount),
      expenseAccount: map.feeExpense.code,
      accruedAccount: map.accruedExpense.code,
      description: feeAccrualDescription(platformName(link.platform), link.platform, month),
      proposalId: await pendingFeeAccrualProposal(ctx, link.legal_entity_id, link.platform, month),
    });
  }
  return { accruals, reversals };
}
