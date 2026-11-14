// SPDX-License-Identifier: AGPL-3.0-only
// The facts behind the finance coworker's one line on the Sàn screen (#2516 slice E, plan docs/plan/stock-and-marketplaces.md section 8.4), read by code from the books and the stored
// settlements, never from a model: how many stored settlements still wait to be posted (slice A's `journal_voucher.settlement_id` is the posting link), how many platforms are linked, what the
// platforms still owe (131) and the fees whose invoice has not come (1388), the last two being the sums of slice D's balance rows. Read only and the same scope as the balance: the row policies
// keep it to the entities the caller may see. No platform name, order, buyer or bank data is in the answer.
import { sql } from 'kysely';
import { zMarketplaceBalanceInput, type MarketplaceFacts } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { loadMarketplaceBalance } from './marketplace-balance.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const marketplaceFacts = defineQuery({
  name: 'finance.marketplace.facts',
  input: zMarketplaceBalanceInput,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceFacts> => {
    const balance = await loadMarketplaceBalance(ctx, input.legalEntityId);
    // A settlement that stands (not reversed, not itself a reversal) and has no posting voucher: the platform paid for it and the books do not say so yet.
    const entity = input.legalEntityId === undefined ? sql`TRUE` : sql`s.legal_entity_id = ${input.legalEntityId}::uuid`;
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM crove_finance.channel_settlement s
      WHERE s.org_id = ${ctx.orgId}::uuid AND ${entity} AND s.reversal_of IS NULL
        AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)
        AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher v WHERE v.org_id = s.org_id AND v.settlement_id = s.id)`.execute(ctx.trx);
    return {
      settlementsToPost: Number(rows[0]?.n ?? '0'),
      platforms: balance.rows.length,
      awaitingPayout: toMoney(sum(balance.rows.map((r) => money(r.awaitingPayout)))),
      feesAwaitingInvoice: toMoney(sum(balance.rows.map((r) => money(r.feesAwaitingInvoice)))),
    };
  },
});

export const marketplaceFactsQueries = [marketplaceFacts];
