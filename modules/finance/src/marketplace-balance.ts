// SPDX-License-Identifier: AGPL-3.0-only
// Where each platform's money stands in the books, for the Sàn screen (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"). Read only, from the ledger: the
// lines on the platform's balance account (131) and on the fees-awaiting-invoice account (1388) that name the platform's party (crove_finance.marketplace_party), per legal entity. Facts only:
// no model call, nothing written, no order or buyer data. A reversal entry takes back what the entry it reverses posted, so it counts against the same figure, never as a payout.
import { sql } from 'kysely';
import { zMarketplaceBalanceInput, type MarketplaceBalance } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { MARKETPLACE_POSTING_MAPS } from './marketplace-posting-map.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The accounts the plan names for the platform's balance and for the fees whose invoice has not come (the TT133 map, the one regime a map exists for); a sub-account extends its parent's code.
const RECEIVABLE = MARKETPLACE_POSTING_MAPS.tt133?.receivable.code ?? '131';
const FEES_AWAITING = MARKETPLACE_POSTING_MAPS.tt133?.feeAwaitingInvoice.code ?? '1388';

export const marketplaceBalance = defineQuery({
  name: 'finance.marketplace.balance',
  input: zMarketplaceBalanceInput,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceBalance> => {
    let links = ctx.trx
      .selectFrom('crove_finance.marketplace_party as mp')
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'mp.org_id').onRef('p.id', '=', 'mp.party_id'))
      .select(['mp.legal_entity_id', 'mp.platform', 'mp.party_id', 'p.name'])
      .where('mp.org_id', '=', ctx.orgId);
    if (input.legalEntityId !== undefined) links = links.where('mp.legal_entity_id', '=', input.legalEntityId);
    const linked = await links.orderBy('mp.platform').orderBy('mp.legal_entity_id').execute();
    if (linked.length === 0) return { rows: [] };
    // One read of the platforms' lines: per entity, party, account and whether the entry is a reversal, the sums of debit and credit. The row policies keep it to the entities the caller may see.
    const sums = await ctx.trx
      .selectFrom('crove_finance.journal_line as l')
      .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
      .select(['l.legal_entity_id', 'l.party_id'])
      .select(sql<string>`CASE WHEN l.account_code LIKE ${`${RECEIVABLE}%`} THEN 'receivable' ELSE 'fees' END`.as('account'))
      .select(sql<boolean>`j.reverses_entry_id IS NOT NULL`.as('reversal'))
      .select((eb) => [eb.fn.sum<string>('l.debit').as('debit'), eb.fn.sum<string>('l.credit').as('credit')])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.party_id', 'in', linked.map((l) => l.party_id))
      .where((eb) => eb.or([eb('l.account_code', 'like', `${RECEIVABLE}%`), eb('l.account_code', 'like', `${FEES_AWAITING}%`)]))
      .groupBy(sql`1, 2, 3, 4`)
      .execute();
    const rows = linked.map((link) => {
      let sales = money('0');
      let paid = money('0');
      let fees = money('0');
      for (const s of sums) {
        if (s.legal_entity_id !== link.legal_entity_id || s.party_id !== link.party_id) continue;
        const debit = money(s.debit);
        const credit = money(s.credit);
        if (s.account === 'fees') {
          fees = fees.plus(debit).minus(credit);
        } else if (s.reversal) {
          // A reversal of a settlement entry credits 131 (it takes the sales back), a reversal of a payout debits it (it takes the payout back).
          sales = sales.minus(credit);
          paid = paid.minus(debit);
        } else {
          sales = sales.plus(debit);
          paid = paid.plus(credit);
        }
      }
      return {
        legalEntityId: link.legal_entity_id,
        platform: link.platform,
        platformName: link.name,
        salesPosted: sales.toFixed(),
        paidOut: paid.toFixed(),
        awaitingPayout: sales.minus(paid).toFixed(),
        feesAwaitingInvoice: fees.toFixed(),
      };
    });
    return { rows };
  },
});

export const marketplaceBalanceQueries = [marketplaceBalance];
