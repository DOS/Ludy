// SPDX-License-Identifier: AGPL-3.0-only
// The balance of each marketplace for one legal entity (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4): what the platform still owes the business (account 131 under the platform's
// party), the fees waiting for their own invoice (account 1388), as of a day. Read only, from the ledger: journal lines by account and by the party linked in marketplace_party, so it needs no record of
// its own and shows zeros until a settlement is posted. A sub-account counts under its parent (131.XXX under 131). Sums are NUMERIC added as decimal strings (decimal.js), never JS numbers.
// - finance.marketplace.balance (every role that reads the ledger): the platforms of the entity with their figures and the totals.
import { sql } from 'kysely';
import { vietnamToday, zMarketplaceBalanceGet, type MarketplaceBalance, type MarketplacePlatformBalance } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Receivables from the platform and the fees awaiting an invoice: TT133 and TT99 both keep 131 and 1388.
const RECEIVABLE = '131';
const FEES_AWAITING_INVOICE = '1388';

export const marketplaceBalance = defineQuery({
  name: 'finance.marketplace.balance',
  input: zMarketplaceBalanceGet,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceBalance> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const asOf = input.asOf ?? vietnamToday();
    // Every platform the entity has a party, a settlement or an order for.
    const known = await sql<{ platform: string }>`
      SELECT platform FROM crove_finance.marketplace_party WHERE org_id = ${ctx.orgId} AND legal_entity_id = ${entity}
      UNION SELECT platform FROM crove_finance.channel_settlement WHERE org_id = ${ctx.orgId} AND legal_entity_id = ${entity}
      UNION SELECT platform FROM crove_finance.channel_order WHERE org_id = ${ctx.orgId} AND legal_entity_id = ${entity}
      ORDER BY platform`.execute(ctx.trx);
    const parties = await ctx.trx
      .selectFrom('crove_finance.marketplace_party as m')
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
      .select(['m.platform', 'm.party_id', 'p.name'])
      .where('m.org_id', '=', ctx.orgId)
      .where('m.legal_entity_id', '=', entity)
      .execute();
    const byParty = new Map(parties.map((p) => [p.party_id, p.platform]));
    // The debits and credits of 131 and 1388 under those parties, as of the day.
    const lines =
      byParty.size === 0
        ? []
        : (
            await sql<{ party_id: string; root: string; debit: string; credit: string }>`
              SELECT l.party_id,
                     CASE WHEN l.account_code LIKE ${`${FEES_AWAITING_INVOICE}%`} THEN ${FEES_AWAITING_INVOICE} ELSE ${RECEIVABLE} END AS root,
                     pg_catalog.sum(l.debit)::text AS debit,
                     pg_catalog.sum(l.credit)::text AS credit
              FROM crove_finance.journal_line l
              JOIN crove_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id
              WHERE l.org_id = ${ctx.orgId} AND l.legal_entity_id = ${entity} AND j.entry_date <= ${asOf}::date
                AND l.party_id = ANY (${[...byParty.keys()]}::uuid[])
                AND (l.account_code LIKE ${`${RECEIVABLE}%`} OR l.account_code LIKE ${`${FEES_AWAITING_INVOICE}%`})
              GROUP BY l.party_id, root`.execute(ctx.trx)
          ).rows;
    const platforms: MarketplacePlatformBalance[] = known.rows.map(({ platform }) => {
      const party = parties.find((p) => p.platform === platform) ?? null;
      const mine = party ? lines.filter((l) => l.party_id === party.party_id) : [];
      const receivable = mine.find((l) => l.root === RECEIVABLE);
      const fees = mine.find((l) => l.root === FEES_AWAITING_INVOICE);
      const sales = money(receivable?.debit ?? '0');
      const payouts = money(receivable?.credit ?? '0');
      return {
        platform,
        partyId: party?.party_id ?? null,
        partyName: party?.name ?? null,
        sales: toMoney(sales),
        payouts: toMoney(payouts),
        owed: toMoney(sales.minus(payouts)),
        feesAwaitingInvoice: toMoney(money(fees?.debit ?? '0').minus(money(fees?.credit ?? '0'))),
      };
    });
    const total = (pick: (p: MarketplacePlatformBalance) => string) => toMoney(sum(platforms.map(pick)));
    return {
      legalEntityId: entity,
      asOf,
      platforms,
      totals: { sales: total((p) => p.sales), payouts: total((p) => p.payouts), owed: total((p) => p.owed), feesAwaitingInvoice: total((p) => p.feesAwaitingInvoice) },
    };
  },
});

export const marketplaceBalanceQueries = [marketplaceBalance];
