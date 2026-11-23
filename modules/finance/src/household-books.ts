// SPDX-License-Identifier: AGPL-3.0-only
// The books of Circular 152/2025/TT-BTC of a household business (#2517, plan docs/plan/stock-and-marketplaces.md section 8.5), as views over the ledger. This file holds S1a-HKD, the sales listing of
// a household of group 1: one row per entry that touched account 511 (and its sub-accounts) in a period, with its date, its document reference, its description and its amount, so the total is
// the ledger's own movement of 511 and the book cannot disagree with it. The books of the other methods (S2a to S2e) come later.
// - finance.household.s1a (every role that reads the ledger): the rows for a month, a quarter or a year. Refused for an entity that is not a household, that has no profile, or whose profile (on the
//   first and the last day of the period) does not require S1a: a household is shown only the books of its method (HOUSEHOLD_BOOK_NOT_REQUIRED).
// - finance.household.export: the audit row of an Excel download of a book (R0; the period, the book and the number of rows, never the rows).
// Amounts are decimal strings added with decimal.js, never JS numbers.
import { z } from 'zod';
import { zHouseholdBook, zHouseholdReturnForm, zId, zLedgerPeriod, zHouseholdS1aGet, type HouseholdBookRule, type HouseholdProfile, type HouseholdS1a } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { sum, toMoney } from '@ludy/l10n-vn';
import { householdProfileView } from './household.ts';
import { accountLedgerOf } from './ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Sales revenue: TT133 account 511 and the sub-accounts that roll up to it.
const SALES_ACCOUNT = '511';

export const HOUSEHOLD_S1A_ROW_LIMIT = 20_000;

const notRequired = (book: string) =>
  new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, `Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ ${book} trong kỳ đã chọn`);

// The days a household book covers and who it is for, shared by the books that are views of account 511 (S1a, S2a, S2b, S2c, S2d, S2e): the book starts the day the household's first profile took effect (days before
// it are outside it, so a household that sets its profile today still gets this month's book from today), and every profile in force inside its days must require the book: the one at its first day
// and each one that starts after it, so a change of method inside the period is asked for in shorter parts. Refused (HOUSEHOLD_BOOK_NOT_REQUIRED) otherwise. S2a and S2b also refuse a period whose profiles name different trades (HOUSEHOLD_TRADES_CHANGED, #3714).
export interface HouseholdBookWindow {
  entity: string;
  ledger: Awaited<ReturnType<typeof accountLedgerOf>>;
  from: string;
  to: string;
  openedOn: string;
  form: HouseholdBookRule;
  profile: HouseholdProfile;
  representativeName: string | null;
}

export async function householdBookWindow(ctx: QueryContext, legalEntityId: string, period: string, book: 'S1a' | 'S2a' | 'S2b' | 'S2c' | 'S2d' | 'S2e'): Promise<HouseholdBookWindow> {
  const entity = await resolveLegalEntity(ctx, legalEntityId);
  const ledger = await accountLedgerOf(ctx, period, entity, SALES_ACCOUNT);
  const { to } = ledger.period;
  const opened = await ctx.trx
    .selectFrom('ludy_finance.household_profile')
    .select('effective_from')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .orderBy('effective_from', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (!opened || opened.effective_from > to) throw notRequired(book);
  const from = ledger.period.from > opened.effective_from ? ledger.period.from : opened.effective_from;
  const changes = await ctx.trx
    .selectFrom('ludy_finance.household_profile')
    .select('effective_from')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('effective_from', '>', from)
    .where('effective_from', '<=', to)
    .orderBy('effective_from', 'asc')
    .execute();
  let form: HouseholdBookRule | undefined;
  let profile: HouseholdProfile | null = null;
  let tradesOfFirstDay: string | null = null;
  let vatAnswerOfFirstDay: string | null | undefined;
  for (const day of [from, ...changes.map((c) => c.effective_from)]) {
    const view = await householdProfileView(ctx, entity, day);
    form = view.books.find((b) => b.book === book);
    if (!view.profile || !form) throw notRequired(book);
    // The books that split revenue by trade (S2a, S2b) read one trade list for the whole period, so every profile in it must name the same trades: a later profile that drops a trade would otherwise move
    // the earlier sales to another line. The user asks for the parts on either side of the change instead (HOUSEHOLD_TRADES_CHANGED); no trade is guessed.
    const trades = [...view.profile.trades].sort().join(',');
    if (book === 'S2a' || book === 'S2b') {
      if (tradesOfFirstDay !== null && trades !== tradesOfFirstDay) {
        throw new DomainError('HOUSEHOLD_TRADES_CHANGED', 422, `Ngành nghề của hộ kinh doanh đổi trong kỳ đã chọn nên sổ ${book} chưa chia được doanh thu; hãy chọn kỳ ngắn hơn, trước và sau ngày đổi`);
      }
      tradesOfFirstDay ??= trades;
      // The VAT cut answer is one answer for the whole period too (#3710): a part before and a part after a change would need the cut on one and not the other, which the one set of lines cannot show.
      if (vatAnswerOfFirstDay !== undefined && view.profile.vatCutEligible !== vatAnswerOfFirstDay) {
        throw new DomainError('HOUSEHOLD_VAT_CUT_CHANGED', 422, `Câu trả lời về giảm thuế GTGT của hộ kinh doanh đổi trong kỳ đã chọn nên sổ ${book} chưa tính được; hãy chọn kỳ ngắn hơn, trước và sau ngày đổi`);
      }
      if (vatAnswerOfFirstDay === undefined) vatAnswerOfFirstDay = view.profile.vatCutEligible;
    }
    profile = view.profile;
  }
  if (!form || !profile) throw notRequired(book);
  return { entity, ledger, from, to, openedOn: opened.effective_from, form, profile, representativeName: profile.representativeName };
}

// One row per entry: an entry may touch 511 on several lines (a goods line and a service line), and a discount may debit a sub-account; the row is the entry's net.
export interface HouseholdSalesRow {
  entryId: string;
  date: string;
  reference: string | null;
  description: string;
  amount: string;
  reversal: boolean;
}

export function householdSalesRows(lines: Awaited<ReturnType<typeof accountLedgerOf>>['lines'], from: string, limit = HOUSEHOLD_S1A_ROW_LIMIT): HouseholdSalesRow[] {
  const byEntry = new Map<string, { entryId: string; date: string; reference: string | null; description: string; reversal: boolean; credit: string[]; debit: string[] }>();
  for (const l of lines) {
    if (l.entryDate < from) continue;
    const row = byEntry.get(l.entryId) ?? { entryId: l.entryId, date: l.entryDate, reference: l.reference, description: l.description, reversal: l.reversal, credit: [], debit: [] };
    row.credit.push(l.credit);
    row.debit.push(l.debit);
    byEntry.set(l.entryId, row);
  }
  const rows = [...byEntry.values()].map((r) => ({
    entryId: r.entryId,
    date: r.date,
    reference: r.reference,
    description: r.description,
    amount: toMoney(sum(r.credit).minus(sum(r.debit))),
    reversal: r.reversal,
  }));
  if (rows.length > limit) throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng trong một kỳ; hãy chọn kỳ ngắn hơn');
  return rows;
}

export const householdS1a = defineQuery({
  name: 'finance.household.s1a',
  input: zHouseholdS1aGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS1a> => {
    const w = await householdBookWindow(ctx, input.legalEntityId, input.period, 'S1a');
    const rows = householdSalesRows(w.ledger.lines, w.from);
    const entityRow = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', w.entity).executeTakeFirstOrThrow();
    return {
      period: { period: w.ledger.period.period, from: w.from, to: w.to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: w.representativeName, openedOn: w.openedOn },
      form: w.form,
      rows,
      total: toMoney(sum(rows.map((r) => r.amount))),
    };
  },
});

// Records one Excel download of a household book after the workbook is built: no row, no download. It changes nothing; the audit row names the entity, the book, the period and the count.
export const householdExport = defineCommand({
  name: 'finance.household.export',
  input: z.object({ legalEntityId: zId, book: z.union([zHouseholdBook, zHouseholdReturnForm]), period: zLedgerPeriod, rows: z.number().int().min(0).max(HOUSEHOLD_S1A_ROW_LIMIT * 2) }),
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
