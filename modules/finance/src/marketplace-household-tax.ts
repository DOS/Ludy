// SPDX-License-Identifier: AGPL-3.0-only
// The rate pair that splits the tax a platform withheld from a household seller into VAT and PIT (#2516 rework, slice C2; plan docs/plan/stock-and-marketplaces.md section 8.4, rows 9 and 18).
// A settlement line holds ONE amount withheld, no split by the platform (no real file gives one yet, #2521), so the split rule is the household's: the percentages of its ONE line of business on the
// day of the settlement's last day (household_trade_rate, dated rows). A household with no line of business or several is refused, never guessed: with several the pair is ambiguous.
// A seller that is no household (an entity that is not of kind household) has no tax lines at all (null); a household with no profile in force is refused. A rate row still `commentary` is refused too: nothing that computes a tax
// may rely on a row the accountant has not checked (household.ts, #2520).
import { DomainError, type QueryContext } from '@crove/kernel-runtime';
import { pickInForce } from './domain/household-rules.ts';
import type { HouseholdTaxRate } from './marketplace-settlement-posting.ts';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

export async function householdTaxRate(ctx: Ctx, legalEntityId: string, date: string): Promise<HouseholdTaxRate | null> {
  const entity = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', legalEntityId).executeTakeFirst();
  if (entity?.kind !== 'household') return null;
  const profile = await ctx.trx
    .selectFrom('crove_finance.household_profile')
    .select('trades')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  // An entity of kind household with no profile in force is no company: its tax cannot be split, so it is refused, never treated as a seller with no tax lines.
  if (!profile) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Hộ kinh doanh chưa có hồ sơ hiệu lực vào ngày đối soát nên chưa tách được thuế sàn đã khấu trừ: hãy lập hồ sơ hộ kinh doanh', { reason: 'TAX_SPLIT_PROFILE' });
  const trades = [...profile.trades];
  const trade = trades[0];
  if (trades.length !== 1 || trade === undefined) {
    throw new DomainError(
      'MARKETPLACE_SETTLEMENT_NOT_POSTABLE',
      422,
      trades.length === 0
        ? 'Hồ sơ hộ kinh doanh chưa có ngành nghề nên chưa tách được thuế sàn đã khấu trừ: hãy chọn ngành nghề'
        : 'Hồ sơ hộ kinh doanh có nhiều ngành nghề nên chưa tách được thuế sàn đã khấu trừ theo một cặp tỷ lệ',
      { reason: 'TAX_SPLIT_TRADES', trades: trades.length },
    );
  }
  const rows = await ctx.trx
    .selectFrom('crove_finance.household_trade_rate')
    .select(['trade', 'effective_from', 'vat_percent', 'pit_percent', 'status'])
    .where('trade', '=', trade)
    .where('effective_from', '<=', date)
    .execute();
  const rate = pickInForce(rows, (r) => r.trade, date)[0];
  if (!rate) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Chưa có tỷ lệ thuế của ngành nghề này vào ngày đối soát', { reason: 'TAX_SPLIT_RATE', trade });
  if (rate.status !== 'confirmed') {
    throw new DomainError('MARKETPLACE_TAX_RATE_UNCONFIRMED', 409, 'Tỷ lệ thuế của ngành nghề chưa được kế toán xác nhận: chờ kế toán xác nhận', { trade });
  }
  return { vatPercent: rate.vat_percent, pitPercent: rate.pit_percent };
}
