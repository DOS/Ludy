// SPDX-License-Identifier: AGPL-3.0-only
// The facts behind the finance coworker's one line on the Sàn screen (#2516 slice E, plan docs/plan/stock-and-marketplaces.md section 8.4), read by code from the books and the stored
// settlements, never from a model: how many stored settlements still wait to be posted (slice A's `journal_voucher.settlement_id` and, since slice C1, `settlement_month` are the posting link), what the
// platforms still owe (131) and the fees whose invoice has not come (1388), the last two being the sums of slice D's balance rows over the platforms that owe (a negative balance, an overpaid platform or a reversed payout, is not waiting and is never netted against another platform's debt). Read only and the same scope as the balance: the row policies
// keep it to the entities the caller may see. No platform name, order, buyer or bank data is in the answer.
import { sql } from 'kysely';
import { zMarketplaceBalanceInput, type MarketplaceFacts } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { loadMarketplaceBalance } from './marketplace-balance.ts';
import { halfReversedSettlements } from './marketplace-half-reversed.ts';
import { postingsOf, settlementMonthsFor, settlementPosted } from './marketplace-settlement-months.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const marketplaceFacts = defineQuery({
  name: 'finance.marketplace.facts',
  input: zMarketplaceBalanceInput,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceFacts> => {
    const balance = await loadMarketplaceBalance(ctx, input.legalEntityId);
    // The settlements that stand (not reversed, not itself a reversal). A settlement posts as one voucher per month of delivery (#2516 rework, slice C1), so what waits is read from its months.
    const entity = input.legalEntityId === undefined ? sql`TRUE` : sql`s.legal_entity_id = ${input.legalEntityId}::uuid`;
    const standing = (
      await sql<{ id: string; period_end: string }>`
        SELECT s.id, s.period_end::text FROM crove_finance.channel_settlement s
        WHERE s.org_id = ${ctx.orgId}::uuid AND ${entity} AND s.reversal_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)
          -- A settlement with a payout voucher waits for nothing (it counts in neither number), so the history of paid settlements is not read each time.
          AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher p WHERE p.org_id = s.org_id AND p.payout_settlement_id = s.id)`.execute(ctx.trx)
    ).rows;
    const ids = standing.map((s) => s.id);
    const months = await settlementMonthsFor(ctx, standing.map((s) => ({ id: s.id, periodEnd: s.period_end })));
    const postings = await postingsOf(ctx, ids);
    // Waiting to be posted: no voucher yet and either a month to post or sales that wait for their delivery day (a settlement of zero net has nothing to post). Waiting for the platform's transfer to be
    // recorded: the posting stands and there is no payout voucher yet (a reversed payout counts as a payout voucher: it is not posted again).
    let toPost = 0;
    let toMatch = 0;
    for (const s of standing) {
      const m = months.get(s.id) ?? { months: [], waiting: 0 };
      const p = postings.get(s.id) ?? [];
      if (p.length === 0 && (m.months.length > 0 || m.waiting > 0)) toPost += 1;
      if (settlementPosted(p)) toMatch += 1;
    }
    return {
      settlementsToPost: toPost,
      payoutsToMatch: toMatch,
      settlementsHalfReversed: (await halfReversedSettlements(ctx, input.legalEntityId)).length,
      awaitingPayout: toMoney(sum(balance.rows.map((r) => money(r.awaitingPayout)).filter((v) => v.gt(0)))),
      feesAwaitingInvoice: toMoney(sum(balance.rows.map((r) => money(r.feesAwaitingInvoice)).filter((v) => v.gt(0)))),
    };
  },
});

export const marketplaceFactsQueries = [marketplaceFacts];
