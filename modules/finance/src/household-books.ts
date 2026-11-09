// SPDX-License-Identifier: AGPL-3.0-only
// The books of Circular 152/2025/TT-BTC of a household business (#2517, plan docs/plan/stock-and-marketplaces.md section 8.5), as views over the ledger. This file holds S1a-HKD, the sales listing of
// a household of group 1: one row per entry that touched account 511 (and its sub-accounts) in a period, with its date, its document reference, its description and its amount, so the total is
// the ledger's own movement of 511 and the book cannot disagree with it. The books of the other methods (S2a to S2e) come later.
// - finance.household.s1a (every role that reads the ledger): the rows for a month, a quarter or a year. Refused for an entity that is not a household, that has no profile, or whose profile (on the
//   first and the last day of the period) does not require S1a: a household is shown only the books of its method (HOUSEHOLD_BOOK_NOT_REQUIRED).
// - finance.household.export: the audit row of an Excel download of a book (R0; the period, the book and the number of rows, never the rows).
// Amounts are decimal strings added with decimal.js, never JS numbers.
import { z } from 'zod';
import { zHouseholdBook, zId, zLedgerPeriod, zHouseholdS1aGet, type HouseholdS1a } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { householdProfileView } from './household.ts';
import { accountLedgerOf } from './ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Sales revenue: TT133 account 511 and the sub-accounts that roll up to it.
const SALES_ACCOUNT = '511';

export const HOUSEHOLD_S1A_ROW_LIMIT = 20_000;

const notRequired = () =>
  new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S1a trong kỳ đã chọn');

export const householdS1a = defineQuery({
  name: 'finance.household.s1a',
  input: zHouseholdS1aGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS1a> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const ledger = await accountLedgerOf(ctx, input.period, entity, SALES_ACCOUNT);
    const { from, to } = ledger.period;
    // The profile on the first and the last day of the period must both require S1a: a period over a change of method is asked for in shorter parts.
    const first = await householdProfileView(ctx, entity, from);
    const last = await householdProfileView(ctx, entity, to);
    const form = last.books.find((b) => b.book === 'S1a');
    if (!first.profile || !last.profile || !form || !first.books.some((b) => b.book === 'S1a')) throw notRequired();
    const rows = ledger.lines.map((l) => ({
      entryId: l.entryId,
      date: l.entryDate,
      reference: l.reference,
      description: l.description,
      amount: toMoney(money(l.credit).minus(money(l.debit))),
      reversal: l.reversal,
    }));
    if (rows.length > HOUSEHOLD_S1A_ROW_LIMIT) throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng trong một kỳ; hãy chọn kỳ ngắn hơn');
    const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirstOrThrow();
    const opened = await ctx.trx
      .selectFrom('crove_finance.household_profile')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return {
      period: { period: ledger.period.period, from, to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: last.profile.representativeName, openedOn: opened.effective_from },
      form,
      rows,
      total: toMoney(sum(rows.map((r) => r.amount))),
    };
  },
});

// Records one Excel download of a household book after the workbook is built: no row, no download. It changes nothing; the audit row names the entity, the book, the period and the count.
export const householdExport = defineCommand({
  name: 'finance.household.export',
  input: z.object({ legalEntityId: zId, book: zHouseholdBook, period: zLedgerPeriod, rows: z.number().int().min(0).max(HOUSEHOLD_S1A_ROW_LIMIT) }),
  risk: 'R0',
  sideEffect: 'none',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ legalEntityId: input.legalEntityId, book: input.book, period: input.period, rows: input.rows });
    return { ok: true as const };
  },
});

export const householdBookCommands = [householdExport];
export const householdBookQueries = [householdS1a];
