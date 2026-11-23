// SPDX-License-Identifier: AGPL-3.0-only
// What reversing an entry means for a marketplace settlement (#3329, option C of the Accounting PO, part of #2516 plan docs/plan/stock-and-marketplaces.md section 8.4; working answer A6 of #2520): a
// settlement posts as one voucher per month of delivery (slice C1) and its payout as one more, and each is reversed on its own through the generic `finance.journal.reverse`, one approval per
// voucher. No new command and no approval-policy change: finance.journal.prepare_reversal (R1) and the reversal itself ask this module, which
// - REFUSES to reverse a settlement's voucher while its payout stands ("reverse the payout first", MARKETPLACE_SETTLEMENT_PAYOUT_STANDS): the payout cleared the receivable the settlement posted;
// - REFUSES a reversal dated in a closed period (PERIOD_LOCKED), as the database does at approval, so the request fails before an approver is asked;
// - WARNS (a note in the proposal's title the approver reads) when the entry is a payout, which is matched to its bank line (the reversal opens the line again), and when one month of a settlement is
//   reversed while other months stand (the settlement is then half reversed: the payout stays refused until the rest is reversed too).
// Every other entry gets no note and no refusal. Facts only: nothing is written and no model is asked.
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';
import { DomainError } from '@ludy/kernel-runtime';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';
import { reversedSource } from './source-entry.ts';

type Ctx = QueryContext;

export interface ReversedEntry {
  id: string;
  source_type: string;
  source_id: string;
  legal_entity_id: string;
}

// The notes for the approver (empty for an entry that is no part of a marketplace posting). Throws when the reversal must not be asked for.
export async function marketplaceReversalNotes(ctx: Ctx, entry: ReversedEntry, entryDate: string): Promise<string[]> {
  if (entry.source_type !== JOURNAL_VOUCHER_SOURCE) return [];
  const voucher = await ctx.trx
    .selectFrom('ludy_finance.journal_voucher')
    .select(['id', 'settlement_id', 'payout_settlement_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', entry.source_id)
    .executeTakeFirst();
  const settlementId = voucher?.settlement_id ?? voucher?.payout_settlement_id ?? null;
  if (!voucher || settlementId === null) return [];
  const lockedThrough = await periodLockedThrough(ctx, entry.legal_entity_id);
  if (lockedThrough && entryDate <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(entryDate)}`, { lockedThrough, entryDate });
  }
  if (voucher.payout_settlement_id !== null) {
    // The payout is matched to its bank line (the voucher names it); reversing it frees the line for a bank voucher.
    return ['cảnh báo: khoản sàn trả này đã khớp một dòng ngân hàng, đảo sẽ mở lại dòng đó'];
  }
  // A settlement's own voucher (one month): its payout must be reversed first, and the other months, when they stand, are to be reversed too. The platform's lock (the one the payout's approval takes,
  // marketplace-payout-record.ts) is held first, so a payout approved at the same moment is either seen here or sees this reversal: the two cannot both pass their checks and both commit.
  const settlement = await ctx.trx.selectFrom('ludy_finance.channel_settlement').select(['legal_entity_id', 'platform']).where('org_id', '=', ctx.orgId).where('id', '=', settlementId).executeTakeFirst();
  if (settlement) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`channel_settlement:${ctx.orgId}:${settlement.legal_entity_id}:${settlement.platform}`}, 0))`.execute(ctx.trx);
  }
  const payout = await ctx.trx
    .selectFrom('ludy_finance.journal_voucher as p')
    .select('p.id')
    .where('p.org_id', '=', ctx.orgId)
    .where('p.payout_settlement_id', '=', settlementId)
    .where((eb) => eb.not(reversedSource('p', JOURNAL_VOUCHER_SOURCE)))
    .executeTakeFirst();
  if (payout) {
    throw new DomainError('MARKETPLACE_SETTLEMENT_PAYOUT_STANDS', 409, 'Khoản sàn trả của kỳ đối soát này còn hiệu lực: hãy đảo khoản sàn trả trước, rồi mới đảo ghi sổ kỳ đối soát', { settlementId });
  }
  const standing = await ctx.trx
    .selectFrom('ludy_finance.journal_voucher as j')
    .select('j.id')
    .where('j.org_id', '=', ctx.orgId)
    .where('j.settlement_id', '=', settlementId)
    .where('j.id', '<>', voucher.id)
    .where((eb) => eb.not(reversedSource('j', JOURNAL_VOUCHER_SOURCE)))
    .execute();
  return standing.length > 0 ? [`cảnh báo: kỳ đối soát còn ${standing.length} tháng chưa đảo`] : [];
}
