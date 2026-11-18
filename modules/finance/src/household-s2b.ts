// SPDX-License-Identifier: AGPL-3.0-only
// S2b-HKD, the revenue book of a household business that pays PIT on income (#2517 slice 2c, Circular 152/2025/TT-BTC, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 6), a view of the
// ledger like S1a and S2a. A BOOK: Ludy never files anything.
// - finance.household.s2b (every role that reads the ledger): the same rows and the same split by business line as S2a (one row per entry that touched account 511, so the total is the ledger's own movement
//   of 511), with the VAT of each line by the percentage in force on the period's last day (household_trade_rate, a dated row, never a constant), rounded to a whole dong. There is no PIT: on the income method
//   the PIT comes from income (S2c), not from a percentage of revenue. Refused for an entity whose profile does not require the income method.
// - The split, the percentages and the label are the code path of S2a (`tradeRevenueBook`), so the two books cannot disagree. A part with no business line holds the VAT total back (`totals` is null), never a guess.
// - While the S2b layout or a percentage in use is `commentary` (the accountant has not confirmed it, #2520) the book is still given, with `commentary` and the list of unconfirmed rows, so the screen and the
//   Excel file label the figures "Số liệu tạm, kế toán chưa xác nhận tỷ lệ"; the label goes by itself when later dated `confirmed` rows exist (owner's direction of 2026-11-17).
// Amounts are decimal strings through decimal.js, never JS numbers.
import { zHouseholdS2b, zHouseholdS2bGet, type HouseholdS2b } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { householdBookWindow } from './household-books.ts';
import { tradeRevenueBook } from './household-s2a.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const householdS2b = defineQuery({
  name: 'finance.household.s2b',
  input: zHouseholdS2bGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS2b> => {
    const w = await householdBookWindow(ctx, input.legalEntityId, input.period, 'S2b');
    // S2b is the book of the income method; the form row says so, and the profile must agree on the last day.
    if (w.profile.pitMethod !== 'income') throw new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S2b trong kỳ đã chọn');
    const b = await tradeRevenueBook(ctx, w, 'S2b');
    return zHouseholdS2b.parse({
      ...b,
      lines: b.lines.map((l) => ({ trade: l.trade, revenue: l.revenue, vatPercent: l.vatPercent, vat: l.vat })),
      totals: b.totals ? { revenue: b.totals.revenue, vat: b.totals.vat } : null,
    });
  },
});

export const householdS2bQueries = [householdS2b];
