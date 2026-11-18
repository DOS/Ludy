// SPDX-License-Identifier: AGPL-3.0-only
// The quarterly return worksheet 01/CNKD of a household business that pays by a percentage of revenue (#2518, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 7), a view over the ledger
// and the stored marketplace settlements. A WORKSHEET: Ludy never files and never calls the tax authority.
// - finance.household.cnkd (every role that reads the ledger): one quarter of one household entity. Revenue is the ledger's own movement of account 511 over the quarter (the same source as S1a, so
//   the two cannot disagree), split by the trades of the profile. A household with one trade has it all on that trade; with several, the ask carries the split the household entered (nothing is
//   stored) and what is not given a trade yet is `unassigned`, which holds the totals back: the code never guesses a split. VAT and PIT are revenue times the percentage in force on the quarter's last
//   day, each rounded to a whole dong, and the exempt band of the year is not deducted because that rule is unconfirmed (#2520). The tax the platforms already withheld is the sum of the stored
//   settlements whose period ends in the quarter, reversed ones and reversals left out: it is not posted to the ledger yet (#2516), so it comes from the settlement record.
// - The worksheet is `commentary` while any row behind it (the form, a percentage) is not confirmed by the accountant (owner's direction of 2026-11-17: build on the working answers while the accountant
//   reviews, #2520). It is still given, with `commentary` and the list of unconfirmed rows, so the screen and the Excel file label every figure "Số liệu tạm, kế toán chưa xác nhận tỷ lệ"; the label goes
//   when the rows are confirmed, with no code change. `forExport` still refuses while revenue is unassigned. Refused too for an entity with no profile in the quarter, a household that files no
//   return (group 1), the income method (a later slice), and a profile that changes inside the quarter (the quarter cannot be asked for in parts).
// - The Decree 174 VAT cut is not applied to all revenue (#3710): the profile's answer decides. `vatCut` carries the cut by line, `totals.vat` stays the VAT before the cut, and `due` and `overpaid` follow the VAT
//   payable (VAT less the cut) plus the PIT.
// Amounts are decimal strings through decimal.js, never JS numbers.
import type { HouseholdCnkd, HouseholdCnkdLine } from '@crove/kernel-contract';
import { HOUSEHOLD_TRADES, zHouseholdCnkd, zHouseholdCnkdGet } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { pickInForce } from './domain/household-rules.ts';
import { taxOn } from './domain/household-tax.ts';
import { householdProfileView } from './household.ts';
import { yearToDateBlock } from './household-annual.ts';
import { salesEntriesOf, tradesDifferEarlierInYear } from './household-year-sales.ts';
import { vatCutBlock, vatCutInForce, vatCutUnconfirmed } from './household-vat-cut.ts';
import { accountLedgerOf } from './ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const SALES_ACCOUNT = '511';
const FORM = '01/CNKD';

const notRequired = () => new DomainError('HOUSEHOLD_RETURN_NOT_REQUIRED', 422, 'Hộ kinh doanh này không phải kê khai tờ khai 01/CNKD theo quý trong kỳ đã chọn');

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
    // The Decree 174 VAT cut on the quarter's last day, applied only as the profile's answer says (#3710): the VAT payable is the VAT less the cut, and what is owed follows it.
    const cutRow = await vatCutInForce(ctx, to);
    const vatCut = vatCutBlock({ answer: profile.vatCutEligible, cut: cutRow, lines, complete });
    // The yearly rule (#3710 slice 3): the year's revenue so far decides whether anything is owed. What is owed in the quarter is the year-to-date tax at its last day less the year-to-date tax before it.
    // The revenue before the quarter comes from the ledger; with several trades the household enters its split (`splitBefore`, per ask, nothing stored) and what is not given a trade holds the tax back.
    const beforeEntries = from > `${input.year}-01-01` ? await salesEntriesOf(ctx, entity, { from: `${input.year}-01-01`, before: from }) : [];
    const beforeRevenue = toMoney(sum(beforeEntries.map((e) => e.amount)));
    const beforeGiven = new Map<string, string>();
    if (trades.length === 1) {
      if (input.splitBefore && input.splitBefore.length > 0) throw invalid('Hộ chỉ có một ngành nghề nên không chia doanh thu');
      beforeGiven.set(trades[0]!, beforeRevenue);
    } else {
      for (const part of input.splitBefore ?? []) {
        if (!trades.includes(part.trade)) throw invalid('Ngành nghề không có trong hồ sơ hộ kinh doanh');
        if (beforeGiven.has(part.trade)) throw invalid('Mỗi ngành nghề chỉ nhập một lần');
        if (money(part.revenue).lt(0)) throw invalid('Doanh thu của một ngành nghề không được âm');
        beforeGiven.set(part.trade, toMoney(money(part.revenue)));
      }
    }
    const beforeSplittable = money(beforeRevenue).gt(0) ? money(beforeRevenue) : money(0);
    if (trades.length > 1 && money(sum([...beforeGiven.values()])).gt(beforeSplittable)) throw invalid('Tổng doanh thu đã chia theo ngành của các kỳ trước trong năm vượt doanh thu trên sổ cái');
    // Not clamped: net returns before the quarter (a negative figure) with no trade to put them on also hold the tax back.
    const beforeUnassigned = trades.length === 1 ? money(0) : money(beforeRevenue).minus(sum([...beforeGiven.values()]));
    // The quarter's own unassigned amount, not clamped: net returns with no trade to take them hold the tax back too, and every unassigned amount is counted in the year's totals.
    const quarterUnassigned = trades.length === 1 ? money(0) : money(revenue).minus(sum([...given.values()]));
    // One trade takes the whole year, so an earlier profile of the year with other trades makes the revenue before the quarter ambiguous: held for the accountant.
    const ambiguousBefore = trades.length === 1 && (await tradesDifferEarlierInYear(ctx, entity, String(input.year), from, trades));
    const toDate = new Map<string, string>(trades.map((t) => [t, toMoney(money(beforeGiven.get(t) ?? '0').plus(given.get(t) ?? '0'))]));
    const year = await yearToDateBlock(ctx, {
      to,
      trades,
      rates,
      answer: profile.vatCutEligible,
      pitApplies: true,
      deductionTrade: input.deductionTrade,
      revenue: {
        toDate,
        before: beforeGiven,
        unassigned: { toDate: toMoney(quarterUnassigned.plus(beforeUnassigned)), before: toMoney(beforeUnassigned) },
        unassignedHeld: !complete || !quarterUnassigned.isZero() || !beforeUnassigned.isZero() || ambiguousBefore,
      },
    });
    const owed = year.block.payable ? money(year.block.payable.vat).plus(year.block.payable.pit) : null;

    const unconfirmed: HouseholdCnkd['unconfirmed'] = [];
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `${FORM} ${form.version}`, effectiveFrom: form.effective_from });
    for (const t of trades) {
      const rate = rates.get(t)!;
      if (rate.status !== 'confirmed') unconfirmed.push({ kind: 'rate', key: t, effectiveFrom: rate.effective_from });
    }
    const cutUnconfirmed = vatCutUnconfirmed(vatCut, cutRow);
    if (cutUnconfirmed) unconfirmed.push(cutUnconfirmed);
    unconfirmed.push(...year.unconfirmed);
    const commentary = unconfirmed.length > 0;
    if (input.forExport && !totals) throw invalid('Chưa chia hết doanh thu theo ngành nghề nên chưa xuất được tờ khai');
    if (input.forExport && !year.block.payable) {
      // Revenue that no split can place (net returns, or an earlier profile with other trades) is the accountant's; the rest the household can finish.
      const accountants = money(beforeRevenue).lt(0) || (!quarterUnassigned.isZero() && money(revenue).lt(0)) || ambiguousBefore;
      throw invalid(
        year.block.deductionNeeded
          ? 'Chưa chọn ngành nghề được trừ ngưỡng doanh thu nên chưa tính được thuế năm và chưa xuất được tờ khai'
          : accountants
            ? 'Doanh thu thuần âm hoặc hồ sơ đổi ngành nghề trong năm nên chưa gắn được ngành nghề cho doanh thu; nhờ kế toán lập tờ khai'
            : 'Chưa chia hết doanh thu các kỳ trước trong năm theo ngành nghề nên chưa xuất được tờ khai',
      );
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
      vatCut,
      yearToDate: year.block,
      withheld: { total: toMoney(withheldTotal), settlements: withheldRows },
      due: owed ? toMoney(nonNegative(owed.minus(withheldTotal))) : null,
      overpaid: owed ? toMoney(nonNegative(withheldTotal.minus(owed))) : null,
      unconfirmed,
      commentary,
    });
  },
});

export const householdReturnQueries = [householdCnkd];
