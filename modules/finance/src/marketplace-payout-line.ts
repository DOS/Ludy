// SPDX-License-Identifier: AGPL-3.0-only
// What a platform's payout makes of a bank line (#2516): a bank line of the platform's transfer settles at most one payout, and a line a payout has posted or proposed is not free for a bank voucher.
// Apart from bank-match.ts (which imports this file, not the other way) because the bank voucher's check and the payout's own check ask the same question.
import { sql } from 'kysely';
import { MARKETPLACE_PAYOUT_COMMAND } from '@crove/kernel-contract';
import type { QueryContext } from '@crove/kernel-runtime';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import { reversedSource } from './source-entry.ts';

export type PayoutOfLine = { state: 'posted'; voucherId: string } | { state: 'proposed'; proposalId: string } | null;

// The payout voucher that names the line and whose entry is not reversed, else a pending payout proposal that names it, else null. With `reversedToo`, a payout voucher whose entry was reversed counts as
// well: the database allows one payout voucher per line for good (20261231150000), so the payout's own check must refuse a line that held one, though a bank voucher may take it again.
export async function payoutOfBankLine(ctx: QueryContext, bankLineId: string, options: { reversedToo?: boolean } = {}): Promise<PayoutOfLine> {
  let query = ctx.trx.selectFrom('crove_finance.journal_voucher as j').select('j.id').where('j.org_id', '=', ctx.orgId).where('j.payout_bank_line_id', '=', bankLineId);
  if (!options.reversedToo) query = query.where(sql<boolean>`NOT ${reversedSource('j', JOURNAL_VOUCHER_SOURCE)}`);
  const posted = await query.executeTakeFirst();
  if (posted) return { state: 'posted', voucherId: posted.id };
  const proposed = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', MARKETPLACE_PAYOUT_COMMAND)
    .where('status', '=', 'pending')
    .where(sql<string>`payload->>'bankLineId'`, '=', bankLineId)
    .orderBy('created_at')
    .executeTakeFirst();
  return proposed ? { state: 'proposed', proposalId: proposed.id } : null;
}
