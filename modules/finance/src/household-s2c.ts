// SPDX-License-Identifier: AGPL-3.0-only
// S2c-HKD, the revenue and expense detail of a household business that pays PIT on income (#2517 slice 2b, Circular 152/2025/TT-BTC, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 6), a view
// of the ledger like S1a and S2a. A BOOK: Ludy never files anything.
// - finance.household.s2c (every role that reads the ledger): the revenue rows of S1a (one per entry that touched account 511, so the revenue total is the ledger's own movement of 511) and one row per
//   journal line on an expense account (TT133 classes 6 and 8) with its document reference, account, group and amount. The group comes from household_expense_group_map (dated rows, the longest account prefix
//   decides, the row in force on the period's last day), never from a constant. An expense account no row covers is shown apart (`unmapped`) and holds the income figure back: the code never guesses a group.
// - The PIT is not computed: no income-method rate is in the data and which expenses are deductible is unconfirmed (#2520), so the book stops at revenue less expenses.
// - While the S2c layout row or a map row in use is `commentary` (the accountant has not confirmed it, #2520) the book is still given, with `commentary` and the list of unconfirmed rows, so the screen and the
//   Excel file label the expense and income figures "Số liệu tạm, kế toán chưa xác nhận tỷ lệ"; the label goes by itself when later dated `confirmed` rows exist (owner's direction of 2026-11-17).
// Amounts are decimal strings through decimal.js, never JS numbers.
import { HOUSEHOLD_EXPENSE_GROUPS, zHouseholdS2c, zHouseholdS2cGet, type HouseholdS2c, type HouseholdS2cExpenseRow } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { groupRowFor, isExpenseAccount } from './domain/household-expense.ts';
import { pickInForce } from './domain/household-rules.ts';
import { HOUSEHOLD_S1A_ROW_LIMIT, householdBookWindow, householdSalesRows } from './household-books.ts';
import { periodLinesOf } from './ledger-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const householdS2c = defineQuery({
  name: 'finance.household.s2c',
  input: zHouseholdS2cGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS2c> => {
    const w = await householdBookWindow(ctx, input.legalEntityId, input.period, 'S2c');
    // S2c is the book of the income method; the form row says so, and the profile must agree on the last day.
    if (w.profile.pitMethod !== 'income') throw new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S2c trong kỳ đã chọn');

    const revenueRows = householdSalesRows(w.ledger.lines, w.from);
    const revenue = toMoney(sum(revenueRows.map((r) => r.amount)));

    // The expense lines: every journal line of the entity on a class 6 or 8 account in the book's days.
    const all = await periodLinesOf(ctx, input.period, w.entity);
    const mapRows = await ctx.trx
      .selectFrom('crove_finance.household_expense_group_map')
      .select(['expense_group', 'account_prefix', 'effective_from', 'source', 'status'])
      .where('effective_from', '<=', w.to)
      .execute();
    const used = new Map<string, (typeof mapRows)[number]>();
    const expenseRows: HouseholdS2cExpenseRow[] = [];
    for (const l of all.lines) {
      if (l.entryDate < w.from || !isExpenseAccount(l.accountCode)) continue;
      const row = groupRowFor(l.accountCode, mapRows, w.to);
      if (row) used.set(row.account_prefix, row);
      expenseRows.push({
        entryId: l.entryId,
        lineNo: l.lineNo,
        date: l.entryDate,
        reference: l.reference,
        description: l.description,
        accountCode: l.accountCode,
        group: row ? (row.expense_group as (typeof HOUSEHOLD_EXPENSE_GROUPS)[number]) : null,
        amount: toMoney(money(l.debit).minus(money(l.credit))),
        reversal: l.reversal,
      });
    }
    if (expenseRows.length > HOUSEHOLD_S1A_ROW_LIMIT) throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng trong một kỳ; hãy chọn kỳ ngắn hơn');

    const groups = HOUSEHOLD_EXPENSE_GROUPS.map((group) => ({ group, amount: toMoney(sum(expenseRows.filter((r) => r.group === group).map((r) => r.amount))) }));
    const unmappedRows = expenseRows.filter((r) => r.group === null);
    const unmapped = toMoney(sum(unmappedRows.map((r) => r.amount)));
    // The income waits for every expense line to have a group: any unmapped line with an amount holds it back, even when the net of the unmapped lines is zero.
    const unmappedGross = toMoney(unmappedRows.reduce((acc, r) => acc.plus(money(r.amount).abs()), money(0)));
    const expenseTotal = toMoney(sum(expenseRows.map((r) => r.amount)));
    const income = money(unmappedGross).isZero() ? toMoney(money(revenue).minus(money(expenseTotal))) : null;

    // What the answer rests on and the accountant has not confirmed: the S2c layout in force on the last day, and each map row that decided at least one line.
    const unconfirmed: HouseholdS2c['unconfirmed'] = [];
    const formRows = await ctx.trx.selectFrom('crove_finance.household_form_version').select(['book', 'version', 'effective_from', 'name', 'status']).where('book', '=', 'S2c').where('effective_from', '<=', w.to).execute();
    const formInForce = pickInForce(formRows, (r) => r.book, w.to)[0];
    const form = formInForce ? { book: formInForce.book, version: formInForce.version, name: formInForce.name, status: formInForce.status } : w.form;
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `S2c ${form.version}`, effectiveFrom: formInForce?.effective_from ?? w.from });
    for (const prefix of [...used.keys()].sort()) {
      const row = used.get(prefix)!;
      if (row.status !== 'confirmed') unconfirmed.push({ kind: 'group', key: prefix, effectiveFrom: row.effective_from });
    }

    const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', w.entity).executeTakeFirstOrThrow();
    return zHouseholdS2c.parse({
      period: { period: w.ledger.period.period, from: w.from, to: w.to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: w.representativeName, openedOn: w.openedOn },
      form,
      revenueRows,
      revenue,
      expenseRows,
      groups,
      unmapped,
      unmappedGross,
      expenseTotal,
      income,
      unconfirmed,
      commentary: unconfirmed.length > 0,
    });
  },
});

export const householdS2cQueries = [householdS2c];
