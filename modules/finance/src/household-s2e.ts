// SPDX-License-Identifier: AGPL-3.0-only
// S2e-HKD, the cash and bank book of a household business that pays PIT on income (#2517 slice 2e, Circular 152/2025/TT-BTC, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 6), a view of the
// ledger like S1a and S2c. A BOOK: Ludy never files anything.
// - finance.household.s2e (every role that reads the ledger): per account that is 111 or 112 or a sub-account of them, the opening balance, one row per journal line on that account (cash in, cash out, the accounts
//   on the other side, the running balance) and the closing balance. The sections add up to the ledger's balance of 111 and 112 (a DB test checks it). A negative balance is flagged, never hidden.
// - While the S2e layout row is `commentary` (the accountant has not confirmed it, #2520) the book is still given, with `commentary` and the unconfirmed row, so the screen and the Excel file carry
//   "Số liệu tạm, kế toán chưa xác nhận bố cục sổ" (no rate stands behind it); the label goes by itself when a later dated `confirmed` row exists (owner's direction of 2026-11-17). No rate is involved.
// - Nothing in it is AI: every figure is a bank or cash fact from the ledger; matching bank lines is #2514.
// Amounts are decimal strings through decimal.js, never JS numbers.
import { zHouseholdS2e, zHouseholdS2eGet, type HouseholdS2e } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { cashBook } from './domain/household-cash.ts';
import { pickInForce } from './domain/household-rules.ts';
import { HOUSEHOLD_S1A_ROW_LIMIT, householdBookWindow } from './household-books.ts';
import { periodDataOf } from './ledger-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const householdS2e = defineQuery({
  name: 'finance.household.s2e',
  input: zHouseholdS2eGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS2e> => {
    const w = await householdBookWindow(ctx, input.legalEntityId, input.period, 'S2e');
    // S2e is a book of the income method; the form row says so, and the profile must agree on the last day.
    if (w.profile.pitMethod !== 'income') throw new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S2e trong kỳ đã chọn');

    const data = await periodDataOf(ctx, input.period, w.entity);
    const sections = cashBook(data.chart, data.opening, data.lines, w.from);
    const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
    if (rowCount > HOUSEHOLD_S1A_ROW_LIMIT) throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng trong một kỳ; hãy chọn kỳ ngắn hơn');
    const accounts = sections.map((s) => ({ ...s, negative: money(s.closing).isNegative() }));
    const totals = {
      opening: toMoney(sum(accounts.map((a) => a.opening))),
      in: toMoney(sum(accounts.map((a) => a.totalIn))),
      out: toMoney(sum(accounts.map((a) => a.totalOut))),
      closing: toMoney(sum(accounts.map((a) => a.closing))),
    };

    // What the answer rests on and the accountant has not confirmed: the S2e layout in force on the last day.
    const unconfirmed: HouseholdS2e['unconfirmed'] = [];
    const formRows = await ctx.trx.selectFrom('crove_finance.household_form_version').select(['book', 'version', 'effective_from', 'name', 'status']).where('book', '=', 'S2e').where('effective_from', '<=', w.to).execute();
    const formInForce = pickInForce(formRows, (r) => r.book, w.to)[0];
    const form = formInForce ? { book: formInForce.book, version: formInForce.version, name: formInForce.name, status: formInForce.status } : w.form;
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `S2e ${form.version}`, effectiveFrom: formInForce?.effective_from ?? w.from });

    const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', w.entity).executeTakeFirstOrThrow();
    return zHouseholdS2e.parse({
      period: { period: data.period.period, from: w.from, to: w.to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: w.representativeName, openedOn: w.openedOn },
      form,
      accounts,
      totals,
      unconfirmed,
      commentary: unconfirmed.length > 0,
    });
  },
});

export const householdS2eQueries = [householdS2e];
