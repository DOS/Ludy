// SPDX-License-Identifier: AGPL-3.0-only
// The quarterly return worksheet 01/CNKD of a household business that pays by a percentage of revenue (#2518, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 7), a view over the ledger
// and the stored marketplace settlements. A WORKSHEET: Ludy never files and never calls the tax authority.
// - finance.household.cnkd (every role that reads the ledger): one quarter of one household entity. Revenue is the ledger's own movement of account 511 over the quarter (the same source as S1a, so
//   the two cannot disagree), split by the trades of the profile. A household with one trade has it all on that trade; with several, the ask carries the split the household entered (nothing is
//   stored) and what is not given a trade yet is `unassigned`, which holds the totals back: the code never guesses a split. VAT and PIT are revenue times the percentage in force on the quarter's last
//   day, each rounded to a whole dong, and the exempt band of the year is not deducted because that rule is unconfirmed (#2520). The tax the platforms already withheld is the sum of the stored
//   settlements whose period ends in the quarter, reversed ones and reversals left out: it is not posted to the ledger yet (#2516), so it comes from the settlement record.
// - The worksheet is `commentary` while any row behind it (the form, a percentage) is not confirmed by the accountant; `forExport` then refuses (HOUSEHOLD_RULES_UNCONFIRMED), and so it does while
//   revenue is unassigned. Refused too for an entity with no profile in the quarter, a household that files no return (group 1), the income method (a later slice), and a profile that changes inside
//   the quarter (the quarter cannot be asked for in parts).
// Amounts are decimal strings through decimal.js, never JS numbers.
import type { HouseholdCnkd, HouseholdCnkdLine } from '@crove/kernel-contract';
import { HOUSEHOLD_TRADES, zHouseholdCnkd, zHouseholdCnkdGet } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { pickInForce } from './domain/household-rules.ts';
import { householdProfileView } from './household.ts';
import { accountLedgerOf } from './ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const SALES_ACCOUNT = '511';
const FORM = '01/CNKD';

const notRequired = () => new DomainError('HOUSEHOLD_RETURN_NOT_REQUIRED', 422, 'Hộ kinh doanh này không phải kê khai tờ khai 01/CNKD theo quý trong kỳ đã chọn');

// Revenue times a percentage, rounded to a whole dong; a quarter with net returns owes nothing (it never goes negative).
function taxOn(revenue: string, percent: string): string {
  const base = money(revenue);
  if (base.lte(0)) return '0';
  return toMoney(base.times(money(percent)).div(100).toDecimalPlaces(0));
}

const nonNegative = (value: ReturnType<typeof money>) => (value.lt(0) ? money(0) : value);

export const householdCnkd = defineQuery({
  name: 'finance.household.cnkd',
  input: zHouseholdCnkdGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdCnkd> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const ledger = await accountLedgerOf(ctx, `${input.year}-Q${input.quarter}`, entity, SALES_ACCOUNT);
    const { to } = ledger.period;
    // The return starts the day the household's first profile took effect: days before it are outside it.
    const opened = await ctx.trx
      .selectFrom('crove_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!opened || opened.effective_from > to) throw notRequired();
    const from = ledger.period.from > opened.effective_from ? ledger.period.from : opened.effective_from;
    // One profile for the whole quarter: a change inside it would need two returns' worth of parts, which a quarter cannot be asked for.
    const changed = await ctx.trx
      .selectFrom('crove_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('effective_from', '>', from)
      .where('effective_from', '<=', to)
      .executeTakeFirst();
    if (changed) throw new DomainError('HOUSEHOLD_RETURN_PROFILE_CHANGED', 422, 'Hồ sơ hộ kinh doanh đổi trong quý này nên chưa lập được tờ khai theo quý; nhờ kế toán lập', { effectiveFrom: changed.effective_from });
    const view = await householdProfileView(ctx, entity, from);
    const profile = view.profile;
    if (!profile || profile.pitMethod === null) throw notRequired();
    if (profile.pitMethod !== 'percentage') throw new DomainError('HOUSEHOLD_RETURN_METHOD', 422, 'Tờ khai theo phương pháp thu nhập chưa có trong Ludy: hộ nộp theo thu nhập nhờ kế toán lập');

    // The form in force on the quarter's last day, and the percentage of each trade the profile names.
    const forms = await ctx.trx
      .selectFrom('crove_finance.household_return_form_version')
      .select(['form', 'version', 'effective_from', 'name', 'pit_methods', 'status'])
      .where('form', '=', FORM)
      .where('effective_from', '<=', to)
      .execute();
    const form = pickInForce(forms, (r) => r.form, to)[0];
    if (!form || !form.pit_methods.includes('percentage')) throw notRequired();
    const rateRows = await ctx.trx
      .selectFrom('crove_finance.household_trade_rate')
      .select(['trade', 'effective_from', 'vat_percent', 'pit_percent', 'status'])
      .where('effective_from', '<=', to)
      .execute();
    const rates = new Map(pickInForce(rateRows, (r) => r.trade, to).map((r) => [r.trade, r]));
    const trades = HOUSEHOLD_TRADES.filter((t) => profile.trades.includes(t));
    for (const t of trades) {
      if (!rates.has(t)) throw new DomainError('HOUSEHOLD_RATE_MISSING', 422, 'Chưa có tỷ lệ thuế cho một ngành nghề trong hồ sơ', { trade: t });
    }

    // Revenue: the ledger's movement of 511 over the days of the return (credit less debit, so a return or a reversal lowers it).
    const days = ledger.lines.filter((l) => l.entryDate >= from);
    const revenue = toMoney(sum(days.map((l) => l.credit)).minus(sum(days.map((l) => l.debit))));

    // The split: a single trade takes everything and cannot be split; several trades take what the household entered, each once, none negative, together no more than the revenue.
    const invalid = (message: string) => new DomainError('HOUSEHOLD_SPLIT_INVALID', 422, message);
    const given = new Map<string, string>();
    if (trades.length === 1) {
      if (input.split && input.split.length > 0) throw invalid('Hộ chỉ có một ngành nghề nên không chia doanh thu');
      given.set(trades[0]!, revenue);
    } else {
      for (const part of input.split ?? []) {
        if (!trades.includes(part.trade)) throw invalid('Ngành nghề không có trong hồ sơ hộ kinh doanh');
        if (given.has(part.trade)) throw invalid('Mỗi ngành nghề chỉ nhập một lần');
        if (money(part.revenue).lt(0)) throw invalid('Doanh thu của một ngành nghề không được âm');
        given.set(part.trade, toMoney(money(part.revenue)));
      }
    }
    // What can be split is the revenue when it is positive; a quarter of net returns has nothing to split and nothing unassigned.
    const splittable = money(revenue).gt(0) ? money(revenue) : money(0);
    if (trades.length > 1 && money(sum([...given.values()])).gt(splittable)) throw invalid('Tổng doanh thu đã chia theo ngành vượt doanh thu trên sổ cái');
    const unassigned = toMoney(trades.length === 1 ? money(0) : splittable.minus(sum([...given.values()])));

    const lines: HouseholdCnkdLine[] = trades.map((trade) => {
      const rate = rates.get(trade)!;
      const rev = given.get(trade) ?? '0';
      const vatPercent = toMoney(money(rate.vat_percent));
      const pitPercent = toMoney(money(rate.pit_percent));
      return { trade, revenue: rev, vatPercent, pitPercent, vat: taxOn(rev, vatPercent), pit: taxOn(rev, pitPercent) };
    });
    // The totals wait for the whole revenue to have a trade.
    const complete = money(unassigned).isZero();
    const totalVat = sum(lines.map((l) => l.vat));
    const totalPit = sum(lines.map((l) => l.pit));
    const totals = complete ? { revenue: toMoney(sum(lines.map((l) => l.revenue))), vat: toMoney(totalVat), pit: toMoney(totalPit), tax: toMoney(totalVat.plus(totalPit)) } : null;

    // The tax the platforms already withheld: settlements of the entity that stand (not reversed, not a reversal) and end in the quarter.
    const settlements = await ctx.trx
      .selectFrom('crove_finance.channel_settlement')
      .select(['id', 'platform', 'period_start', 'period_end', 'reversal_of'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('period_end', '>=', from)
      .where('period_end', '<=', to)
      .execute();
    const reversed = new Set(settlements.map((s) => s.reversal_of).filter((id): id is string => id !== null));
    // A reversal is for the same platform and period as the settlement it undoes, so both fall in the quarter together.
    const standing = settlements.filter((s) => s.reversal_of === null && !reversed.has(s.id)).sort((a, b) => a.period_end.localeCompare(b.period_end) || a.id.localeCompare(b.id));
    const taxBySettlement = new Map<string, string[]>();
    if (standing.length > 0) {
      const taxLines = await ctx.trx
        .selectFrom('crove_finance.channel_settlement_line')
        .select(['settlement_id', 'tax_withheld'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', entity)
        .where('settlement_id', 'in', standing.map((s) => s.id))
        .execute();
      for (const l of taxLines) taxBySettlement.set(l.settlement_id, [...(taxBySettlement.get(l.settlement_id) ?? []), l.tax_withheld]);
    }
    const withheldRows = standing.map((s) => ({ id: s.id, platform: s.platform, periodStart: s.period_start, periodEnd: s.period_end, taxWithheld: toMoney(sum(taxBySettlement.get(s.id) ?? [])) }));
    const withheldTotal = sum(withheldRows.map((r) => r.taxWithheld));
    const owed = totals ? money(totals.tax) : null;

    const unconfirmed: HouseholdCnkd['unconfirmed'] = [];
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `${FORM} ${form.version}`, effectiveFrom: form.effective_from });
    for (const t of trades) {
      const rate = rates.get(t)!;
      if (rate.status !== 'confirmed') unconfirmed.push({ kind: 'rate', key: t, effectiveFrom: rate.effective_from });
    }
    const commentary = unconfirmed.length > 0;
    if (input.forExport) {
      if (commentary) throw new DomainError('HOUSEHOLD_RULES_UNCONFIRMED', 422, 'Biểu mẫu hoặc tỷ lệ thuế còn chờ kế toán xác nhận nên chưa xuất được tờ khai ra Excel', { unconfirmed });
      if (!totals) throw invalid('Chưa chia hết doanh thu theo ngành nghề nên chưa xuất được tờ khai');
    }

    const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirstOrThrow();
    return zHouseholdCnkd.parse({
      period: { year: input.year, quarter: input.quarter, from, to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: profile.representativeName },
      form: { form: FORM, version: form.version, name: form.name, status: form.status },
      revenue,
      lines,
      unassigned,
      totals,
      withheld: { total: toMoney(withheldTotal), settlements: withheldRows },
      due: owed ? toMoney(nonNegative(owed.minus(withheldTotal))) : null,
      overpaid: owed ? toMoney(nonNegative(withheldTotal.minus(owed))) : null,
      unconfirmed,
      commentary,
    });
  },
});

export const householdReturnQueries = [householdCnkd];
