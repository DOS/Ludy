// SPDX-License-Identifier: AGPL-3.0-only
// The annual PIT finalization worksheet 02/CNKD-TNCN-QTT of a household that pays by the income method (#5285, plan docs/plan/stock-and-marketplaces.md section 8.5), a view over the ledger and the stored
// marketplace settlements. A WORKSHEET: Ludy never files and never calls the tax authority; the person files, by 31 March of the next year (Decree 68/2026/NĐ-CP Art. 8(3)(c)).
// - finance.household.qtt (every role that reads the ledger): one calendar year of one household entity. Part A of the form in the layout of Circular 89/2026/TT-BTC Phụ lục I, lines [09] to [20], with
//   the form's own codes and labels; the arithmetic is `domain/household-qtt.ts`. Revenue [09] is the ledger's own movement of account 511 over the year (the same source as S1a and 01/CNKD, so they cannot
//   disagree); [09b] is the revenue of the stored platform settlements whose period ends in the year, reversed ones and reversals left out (as the 01/CNKD worksheet reads the withheld tax); the deductible
//   costs [10a] to [10e] are the expense lines of S2c (TT133 classes 6 and 8) by the group of `household_expense_group_map`, summed in SQL per account (no row cap); the rate [12] is the row of
//   `household_income_rate` for the year's revenue; the tax withheld by platforms [14], the tax prepaid in the year [15] and the revenue of platforms with no payment function [09c] are ENTERED by the
//   household per ask, nothing stored, because the settlement record has one tax column for VAT and PIT together and Ludy keeps no record of what the household paid the tax office.
// - Refused, as the quarterly worksheet is: an entity that is not a household or has no profile in the year, a household that files no return (group 1), a household on the revenue-percentage method
//   (it files 01/CNKD each quarter and has no annual form), and a profile that changes inside the year (the year cannot be asked for in parts).
// - Held, never guessed (`holds`): revenue at or under the tax-free threshold (no PIT, no return), a loss (no clause says how a loss is treated), an expense account no group covers, a platform revenue
//   larger than the ledger's revenue, a year closed to account 911, a revenue no rate row covers. `forExport` refuses while anything is held.
// - The 30% PIT cut (NQ 43/2026/QH16, Decree 398/2026/NĐ-CP) has no line on this form: [13] to [20] are BEFORE it and `reduction` shows the tax and the balance on both sides.
// - `commentary` is true while a row behind the figures (the form, the rate, the threshold, an expense group, the cut) is not confirmed by the accountant; the screen and the Excel file then label every
//   figure HOUSEHOLD_PROVISIONAL_LABEL.
// Amounts are decimal strings through decimal.js, never JS numbers.
import { sql } from 'kysely';
import { HOUSEHOLD_EXPENSE_GROUPS, HOUSEHOLD_QTT_FORM, vietnamToday, zHouseholdQtt, zHouseholdQttGet, type HouseholdQtt } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { money, toMoney } from '@ludy/l10n-vn';
import { groupRowFor } from './domain/household-expense.ts';
import { pickInForce } from './domain/household-rules.ts';
import { bandFor, computeQtt, reductionMemo, type QttHold } from './domain/household-qtt.ts';
import { THRESHOLD_CODE } from './household-annual.ts';
import { householdProfileView } from './household.ts';
import { reductionInForce } from './household-vat-cut.ts';
import { salesTotalsOf } from './household-year-sales.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
type Group = (typeof HOUSEHOLD_EXPENSE_GROUPS)[number];

const notRequired = () => new DomainError('HOUSEHOLD_RETURN_NOT_REQUIRED', 422, 'Hộ kinh doanh này không phải quyết toán thuế thu nhập cá nhân năm (tờ khai 02/CNKD-TNCN-QTT) trong năm đã chọn');

// What a held figure says when the file is asked for: the household can finish some of them, the accountant the rest.
const HELD_MESSAGES: Readonly<Record<QttHold, string>> = {
  below_threshold: 'Doanh thu năm không vượt ngưỡng chịu thuế nên hộ không phải nộp thuế thu nhập cá nhân và không có tờ khai quyết toán',
  loss: 'Thu nhập tính thuế của năm không dương; chưa có quy định nào nói cách xử lý khoản lỗ nên nhờ kế toán lập tờ khai',
  unmapped_costs: 'Còn chi phí chưa thuộc nhóm chi phí nào nên chưa tính được thu nhập tính thuế; hãy xếp nhóm cho các tài khoản chi phí',
  platform_split: 'Doanh thu trên nền tảng lớn hơn doanh thu trên sổ cái; nhờ kế toán kiểm tra việc ghi sổ các kỳ đối soát',
  rate_missing: 'Chưa có thuế suất cho mức doanh thu này',
  closing_entries: 'Năm đã kết chuyển về tài khoản 911 nên doanh thu và chi phí trên sổ đã triệt tiêu; nhờ kế toán lập tờ khai',
};

export const householdQtt = defineQuery({
  name: 'finance.household.qtt',
  input: zHouseholdQttGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdQtt> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const yearStart = `${input.year}-01-01`;
    const to = `${input.year}-12-31`;
    // The return starts the day the household's first profile took effect: days before it are outside it.
    const opened = await ctx.trx
      .selectFrom('ludy_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!opened || opened.effective_from > to) throw notRequired();
    const from = yearStart > opened.effective_from ? yearStart : opened.effective_from;
    // One profile for the whole year: the method is fixed for two years once chosen, and a change inside the year cannot be asked for in parts.
    const changed = await ctx.trx
      .selectFrom('ludy_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .where('effective_from', '>', from)
      .where('effective_from', '<=', to)
      .executeTakeFirst();
    if (changed) throw new DomainError('HOUSEHOLD_RETURN_PROFILE_CHANGED', 422, 'Hồ sơ hộ kinh doanh đổi trong năm này nên chưa lập được bảng quyết toán năm; nhờ kế toán lập', { effectiveFrom: changed.effective_from });
    const profile = (await householdProfileView(ctx, entity, from)).profile;
    if (!profile || profile.pitMethod === null) throw notRequired();
    if (profile.pitMethod !== 'income') {
      throw new DomainError('HOUSEHOLD_RETURN_METHOD', 422, 'Hộ nộp thuế thu nhập cá nhân theo tỷ lệ trên doanh thu khai tờ khai 01/CNKD theo quý và không có tờ khai quyết toán năm 02/CNKD-TNCN-QTT');
    }

    const formRows = await ctx.trx
      .selectFrom('ludy_finance.household_return_form_version')
      .select(['form', 'version', 'effective_from', 'name', 'pit_methods', 'status'])
      .where('form', '=', HOUSEHOLD_QTT_FORM)
      .where('effective_from', '<=', to)
      .execute();
    const form = pickInForce(formRows, (r) => r.form, to)[0];
    if (!form || !form.pit_methods.includes('income')) throw notRequired();

    // What the household enters (per ask, nothing stored): never negative.
    const entered = {
      withheld: toMoney(money(input.withheld ?? '0')),
      prepaid: toMoney(money(input.prepaid ?? '0')),
      noPaymentRevenue: toMoney(money(input.noPaymentRevenue ?? '0')),
    };
    for (const value of Object.values(entered)) {
      if (money(value).lt(0)) throw new DomainError('HOUSEHOLD_QTT_INPUT', 422, 'Số tiền nhập vào không được âm');
    }

    const thresholdRows = await ctx.trx
      .selectFrom('ludy_finance.household_threshold')
      .select(['code', 'effective_from', 'amount', 'status'])
      .where('code', '=', THRESHOLD_CODE)
      .where('effective_from', '<=', to)
      .execute();
    const thresholdRow = pickInForce(thresholdRows, (r) => r.code, to)[0];
    const threshold = thresholdRow ? toMoney(money(thresholdRow.amount)) : '0';

    // [09]: the movement of 511 over the days of the return, as one scalar from one statement.
    const revenue = (await salesTotalsOf(ctx, entity, { yearStart: from, from, to })).quarter;

    // [09b]: the revenue of the settlements of the year that stand (not reversed, not a reversal): sales less the seller's discounts and the refunds.
    const platformRow = await ctx.trx
      .selectFrom('ludy_finance.channel_settlement as s')
      .innerJoin('ludy_finance.channel_settlement_line as l', (join) => join.onRef('l.org_id', '=', 's.org_id').onRef('l.settlement_id', '=', 's.id'))
      .select(sql<string>`COALESCE(SUM(l.sales - l.seller_discount - l.refund), 0)::text`.as('revenue'))
      .where('s.org_id', '=', ctx.orgId)
      .where('s.legal_entity_id', '=', entity)
      .where('s.period_end', '>=', from)
      .where('s.period_end', '<=', to)
      .where('s.reversal_of', 'is', null)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM ludy_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.reversal_of = s.id)`)
      .executeTakeFirst();
    const platformTotal = money(platformRow?.revenue ?? '0');
    const platformRevenue = toMoney(platformTotal.gt(0) ? platformTotal : money(0));

    // A year closed to the closing account 911 nets revenue and costs to nothing, so no figure of the year can be read from it.
    const closing = await ctx.trx
      .selectFrom('ludy_finance.journal_entry as j')
      .innerJoin('ludy_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'j.org_id').onRef('l.entry_id', '=', 'j.id'))
      .select('j.id')
      .where('j.org_id', '=', ctx.orgId)
      .where('j.legal_entity_id', '=', entity)
      .where('j.entry_date', '>=', from)
      .where('j.entry_date', '<=', to)
      .where('l.account_code', 'like', '911%')
      .limit(1)
      .executeTakeFirst();

    // [10a] to [10e]: the net debit of each expense account (classes 6 and 8) over the days of the return, in one grouped statement, then by the group of the map row in force on the last day.
    const costRows = await ctx.trx
      .selectFrom('ludy_finance.journal_entry as j')
      .innerJoin('ludy_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'j.org_id').onRef('l.entry_id', '=', 'j.id'))
      .select('l.account_code')
      .select(sql<string>`SUM(l.debit - l.credit)::text`.as('net'))
      .where('j.org_id', '=', ctx.orgId)
      .where('j.legal_entity_id', '=', entity)
      .where('j.entry_date', '>=', from)
      .where('j.entry_date', '<=', to)
      .where(sql<boolean>`l.account_code ~ '^[68]'`)
      .groupBy('l.account_code')
      .execute();
    const mapRows = await ctx.trx
      .selectFrom('ludy_finance.household_expense_group_map')
      .select(['expense_group', 'account_prefix', 'effective_from', 'source', 'status'])
      .where('effective_from', '<=', to)
      .execute();
    const used = new Map<string, (typeof mapRows)[number]>();
    const costs = Object.fromEntries(HOUSEHOLD_EXPENSE_GROUPS.map((g) => [g, money(0)])) as Record<Group, ReturnType<typeof money>>;
    let unmappedGross = money(0);
    for (const r of costRows) {
      const net = money(r.net);
      const row = groupRowFor(r.account_code, mapRows, to);
      if (!row) {
        unmappedGross = unmappedGross.plus(net.abs());
        continue;
      }
      used.set(row.account_prefix, row);
      const group = row.expense_group as Group;
      costs[group] = costs[group].plus(net);
    }

    // [12]: the band of the year's revenue among the rows in force on the last day.
    const rateRows = await ctx.trx
      .selectFrom('ludy_finance.household_income_rate')
      .select(['revenue_over', 'effective_from', 'percent', 'status'])
      .where('effective_from', '<=', to)
      .execute();
    const bands = pickInForce(rateRows, (r) => r.revenue_over, to).map((r) => ({
      revenueOver: toMoney(money(r.revenue_over)),
      percent: toMoney(money(r.percent)),
      effectiveFrom: r.effective_from,
      status: r.status,
    }));
    const band = bandFor(revenue, bands);

    const result = computeQtt({
      revenue,
      platformRevenue,
      noPaymentRevenue: entered.noPaymentRevenue,
      costs: Object.fromEntries(HOUSEHOLD_EXPENSE_GROUPS.map((g) => [g, toMoney(costs[g])])) as Record<Group, string>,
      unmappedGross: toMoney(unmappedGross),
      threshold,
      band,
      withheld: entered.withheld,
      prepaid: entered.prepaid,
      closed: closing !== undefined,
    });
    if (input.forExport && result.holds.length > 0) throw new DomainError('HOUSEHOLD_RETURN_HELD', 422, HELD_MESSAGES[result.holds[0]!]);

    // The 30% cut on both sides, only when the tax of the year was worked out and a cut is in force on the last day.
    const cutRow = await reductionInForce(ctx, 'pit', to);
    const reduction =
      result.tax !== null && cutRow && money(cutRow.percent).gt(0)
        ? (() => {
            const memo = reductionMemo({ tax: result.tax, revenue, percent: cutRow.percent, ceiling: cutRow.ceiling, withheld: entered.withheld, prepaid: entered.prepaid });
            return { percent: cutRow.percent, ceiling: cutRow.ceiling, applies: memo.applies, cut: memo.cut, before: memo.before, after: memo.after, effectiveFrom: cutRow.effectiveFrom, status: cutRow.status };
          })()
        : null;

    const platformEntered = money(platformRevenue).plus(money(entered.noPaymentRevenue)).gt(0);
    const notes: HouseholdQtt['notes'] = [];
    if (input.withheld === undefined && platformEntered) notes.push('withheld_not_entered');
    if (input.prepaid === undefined) notes.push('prepaid_not_entered');
    notes.push('costs_not_checked');
    const ended = vietnamToday() > to;
    if (!ended) notes.push('year_not_ended');
    if (reduction?.applies) notes.push('reduction_not_in_form');

    // What the figures rest on and the accountant has not confirmed.
    const unconfirmed: HouseholdQtt['unconfirmed'] = [];
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `${HOUSEHOLD_QTT_FORM} ${form.version}`, effectiveFrom: form.effective_from });
    if (thresholdRow && thresholdRow.status !== 'confirmed') unconfirmed.push({ kind: 'threshold', key: THRESHOLD_CODE, effectiveFrom: thresholdRow.effective_from });
    if (band && band.status !== 'confirmed') unconfirmed.push({ kind: 'rate', key: `${band.percent}%`, effectiveFrom: band.effectiveFrom });
    for (const prefix of [...used.keys()].sort()) {
      const row = used.get(prefix)!;
      if (row.status !== 'confirmed') unconfirmed.push({ kind: 'group', key: prefix, effectiveFrom: row.effective_from });
    }
    if (reduction?.applies && reduction.status !== 'confirmed') unconfirmed.push({ kind: 'reduction', key: 'pit', effectiveFrom: reduction.effectiveFrom });

    const entityRow = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirstOrThrow();
    return zHouseholdQtt.parse({
      period: { year: input.year, from, to, ended },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: profile.representativeName },
      form: { form: HOUSEHOLD_QTT_FORM, version: form.version, name: form.name, status: form.status },
      lines: result.lines,
      rate: band ? { revenueOver: band.revenueOver, percent: band.percent, effectiveFrom: band.effectiveFrom, status: band.status } : null,
      threshold,
      unmappedCosts: toMoney(unmappedGross),
      holds: result.holds,
      notes,
      entered,
      reduction,
      unconfirmed,
      commentary: unconfirmed.length > 0,
    });
  },
});

export const householdQttQueries = [householdQtt];
