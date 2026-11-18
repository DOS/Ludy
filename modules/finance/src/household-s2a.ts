// SPDX-License-Identifier: AGPL-3.0-only
// S2a-HKD, the revenue book of a household business that pays a percentage of revenue (#2517 slice 2a, Circular 152/2025/TT-BTC, plan docs/plan/stock-and-marketplaces.md sections 8.5 and 12 row 6),
// a view of the ledger like S1a. A BOOK: Ludy never files anything.
// - finance.household.s2a (every role that reads the ledger): one row per entry that touched account 511 (and its sub-accounts) in a month, quarter or year, so the book's total is the ledger's own
//   movement of 511 and cannot disagree with S1a or the 01/CNKD. Each row's amount is shared between the business lines (trades) of the household, and the VAT and PIT of each line follow from the
//   percentage in force on the period's last day (household_trade_rate, a dated row, never a constant), each rounded to a whole dong. Refused for an entity whose profile does not require S2a.
// - The ledger has no trade on a 511 line, so the trade of a row comes from what the entry is built from and is never guessed: a household with one trade has every row on it; with several, an entry
//   made by posting a sale document takes the trade of each document line's stock item (the line's latest stock move), by the lines' amounts; a reversal follows the entry it undoes; any other entry
//   (a marketplace settlement, a manual voucher) and any item whose trade the profile does not list is `unassigned`. any `unassigned` part holds the totals back (`totals` is null), as in the CNKD.
// - While the form or a percentage in use is `commentary` (the accountant has not confirmed it, #2520) the book is still given, with `commentary` and the list of unconfirmed rows, so the screen
//   and the Excel file label every figure "Số liệu tạm, kế toán chưa xác nhận tỷ lệ"; the label goes by itself when later dated `confirmed` rows exist (owner's direction of 2026-11-17).
// Amounts are decimal strings through decimal.js, never JS numbers.
import type { HouseholdS2a, HouseholdS2aRow } from '@crove/kernel-contract';
import { HOUSEHOLD_TRADES, zHouseholdS2a, zHouseholdS2aGet, type HouseholdTrade } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { pickInForce } from './domain/household-rules.ts';
import { splitAmount, taxOn, type SplitBucket, type SplitWeight } from './domain/household-tax.ts';
import { householdBookWindow, householdSalesRows, type HouseholdBookWindow } from './household-books.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const CHUNK = 500;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// For the entries of a book: the sale document each was posted from (a reversal: the document of the entry it undoes), and for each such document the weights of its lines by trade.
// A line's trade is the trade of the stock item of its latest stock move (a voided sale keeps the trade it was made under); a line with no move has no trade, and one whose trade the profile does not list is unassigned.
export async function saleDocumentWeights(ctx: Ctx, entryIds: readonly string[], trades: readonly HouseholdTrade[]): Promise<Map<string, SplitWeight[]>> {
  const entries = new Map<string, { sourceType: string; sourceId: string | null; reverses: string | null }>();
  for (const ids of chunks(entryIds)) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.journal_entry')
      .select(['id', 'source_type', 'source_id', 'reverses_entry_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', ids)
      .execute();
    for (const r of rows) entries.set(r.id, { sourceType: r.source_type, sourceId: r.source_id, reverses: r.reverses_entry_id });
  }
  // A reversal takes the source of the entry it undoes (one step: a reversal of a reversal is not a sale of its own).
  const originals = [...new Set([...entries.values()].map((e) => e.reverses).filter((id): id is string => id !== null && !entries.has(id)))];
  for (const ids of chunks(originals)) {
    const rows = await ctx.trx
      .selectFrom('crove_finance.journal_entry')
      .select(['id', 'source_type', 'source_id', 'reverses_entry_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', ids)
      .execute();
    for (const r of rows) entries.set(r.id, { sourceType: r.source_type, sourceId: r.source_id, reverses: r.reverses_entry_id });
  }
  const documentOf = (entryId: string): string | null => {
    const e = entries.get(entryId);
    if (!e) return null;
    const base = e.reverses !== null ? entries.get(e.reverses) : e;
    return base && base.sourceType === 'finance.purchase_document' ? base.sourceId : null;
  };
  const documentIds = [...new Set(entryIds.map(documentOf).filter((id): id is string => id !== null))];
  // Only sale documents carry revenue; a purchase document is never a source of a 511 credit, and is not read.
  const saleDocs = new Set<string>();
  for (const ids of chunks(documentIds)) {
    const rows = await ctx.trx.selectFrom('crove_finance.purchase_document').select('id').where('org_id', '=', ctx.orgId).where('direction', '=', 'sale').where('id', 'in', ids).execute();
    for (const r of rows) saleDocs.add(r.id);
  }
  const weightsOfDoc = new Map<string, SplitWeight[]>();
  for (const ids of chunks([...saleDocs])) {
    const lines = await ctx.trx
      .selectFrom('crove_finance.purchase_line as l')
      .leftJoin('crove_finance.stock_move as m', (join) =>
        join
          .onRef('m.org_id', '=', 'l.org_id')
          .onRef('m.document_id', '=', 'l.document_id')
          .onRef('m.line_no', '=', 'l.line_no')
          .on('m.source_type', '=', 'document_line')
          // The line's latest try, reversed or not: a voided sale keeps the trade it was made under, and a line assigned again (try 2) takes the new item.
          .on((eb) =>
            eb(
              'm.line_attempt',
              '=',
              eb
                .selectFrom('crove_finance.stock_move as a')
                .select((e) => e.fn.max('a.line_attempt').as('latest'))
                .whereRef('a.org_id', '=', 'l.org_id')
                .whereRef('a.document_id', '=', 'l.document_id')
                .whereRef('a.line_no', '=', 'l.line_no')
                .where('a.source_type', '=', 'document_line'),
            ),
          ),
      )
      .leftJoin('crove_finance.stock_item as i', (join) => join.onRef('i.org_id', '=', 'm.org_id').onRef('i.id', '=', 'm.item_id'))
      .select(['l.document_id', 'l.line_no', 'l.amount', 'i.trade'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.document_id', 'in', ids)
      // Only lines that credit sales revenue count as weight: a line crediting another account (financial income, other income) is not part of the 511 amount being shared.
      .where((eb) => eb.or([eb('l.credit_account', 'is', null), eb('l.credit_account', 'like', '511%')]))
      .execute();
    for (const l of lines) {
      const trade = l.trade as HouseholdTrade | null;
      const bucket: SplitBucket = trade !== null && trades.includes(trade) ? trade : 'unassigned';
      weightsOfDoc.set(l.document_id, [...(weightsOfDoc.get(l.document_id) ?? []), { bucket, weight: l.amount }]);
    }
  }
  const out = new Map<string, SplitWeight[]>();
  for (const entryId of entryIds) {
    const doc = documentOf(entryId);
    const weights = doc ? weightsOfDoc.get(doc) : undefined;
    if (weights) out.set(entryId, weights);
  }
  return out;
}

// What S2a and S2b share: the rows of 511 shared between the profile's trades, the percentage of each trade in force on the period's last day, the revenue, VAT and PIT of each line, the totals that wait for
// every part to have a trade, and the rows behind the figures that the accountant has not confirmed. One code path, so the two books cannot disagree on a row, a split or a rounding. S2b drops the PIT.
export async function tradeRevenueBook(ctx: QueryContext, w: HouseholdBookWindow, book: 'S2a' | 'S2b') {
  const trades = HOUSEHOLD_TRADES.filter((t) => w.profile.trades.includes(t));

  // The percentage of each trade the profile names, in force on the period's last day.
  const rateRows = await ctx.trx
    .selectFrom('crove_finance.household_trade_rate')
    .select(['trade', 'effective_from', 'vat_percent', 'pit_percent', 'status'])
    .where('effective_from', '<=', w.to)
    .execute();
  const rates = new Map(pickInForce(rateRows, (r) => r.trade, w.to).map((r) => [r.trade, r]));
  for (const t of trades) {
    if (!rates.has(t)) throw new DomainError('HOUSEHOLD_RATE_MISSING', 422, 'Chưa có tỷ lệ thuế cho một ngành nghề trong hồ sơ', { trade: t });
  }

  const sales = householdSalesRows(w.ledger.lines, w.from);
  // One trade takes every row; with several, the rows are shared by what each entry is built from.
  const weights = trades.length > 1 ? await saleDocumentWeights(ctx, sales.map((r) => r.entryId), trades) : new Map<string, SplitWeight[]>();
  const rows: HouseholdS2aRow[] = sales.map((r) => {
    const parts = trades.length === 1 ? [{ bucket: trades[0]! as SplitBucket, amount: r.amount }] : splitAmount(r.amount, weights.get(r.entryId) ?? []);
    return { ...r, parts: parts.map((p) => ({ trade: p.bucket, amount: p.amount })) };
  });
  const total = toMoney(sum(rows.map((r) => r.amount)));

  const revenueOf = (bucket: SplitBucket) => toMoney(sum(rows.flatMap((r) => r.parts.filter((p) => p.trade === bucket).map((p) => p.amount))));
  const lines = trades.map((trade) => {
    const rate = rates.get(trade)!;
    const revenue = revenueOf(trade);
    const vatPercent = toMoney(money(rate.vat_percent));
    const pitPercent = toMoney(money(rate.pit_percent));
    return { trade, revenue, vatPercent, pitPercent, vat: taxOn(revenue, vatPercent), pit: taxOn(revenue, pitPercent) };
  });
  const unassigned = revenueOf('unassigned');
  // The totals wait for every part to have a trade: any unassigned part with an amount holds them back, even when the net of the unassigned parts is zero (two unrelated entries that cancel
  // each other would otherwise hide their tax). A sale and its void that are both unassigned therefore also hold the period's totals back: the safe side, never a tax total that leaves a part out.
  const unassignedParts = rows.flatMap((r) => r.parts.filter((p) => p.trade === 'unassigned').map((p) => money(p.amount)));
  const unassignedGross = toMoney(unassignedParts.reduce((acc, v) => acc.plus(v.abs()), money(0)));
  const totals = money(unassignedGross).isZero()
    ? (() => {
        const vat = sum(lines.map((l) => l.vat));
        const pit = sum(lines.map((l) => l.pit));
        return { revenue: toMoney(sum(lines.map((l) => l.revenue))), vat: toMoney(vat), pit: toMoney(pit), tax: toMoney(vat.plus(pit)) };
      })()
    : null;

  const unconfirmed: HouseholdS2a['unconfirmed'] = [];
  // The layout of the book in force on the period's last day, from its own row (the book rule of the profile view carries no date), so the label follows the same day as the rates.
  const formRows = await ctx.trx.selectFrom('crove_finance.household_form_version').select(['book', 'version', 'effective_from', 'name', 'status']).where('book', '=', book).where('effective_from', '<=', w.to).execute();
  const formInForce = pickInForce(formRows, (r) => r.book, w.to)[0];
  // The layout shown is the one in force on the last day too (the profile view's rule is read on the first day or on the last profile change), so the book, its status and its label agree.
  const form = formInForce ? { book: formInForce.book, version: formInForce.version, name: formInForce.name, status: formInForce.status } : w.form;
  if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `${book} ${form.version}`, effectiveFrom: formInForce?.effective_from ?? w.from });
  for (const t of trades) {
    const rate = rates.get(t)!;
    if (rate.status !== 'confirmed') unconfirmed.push({ kind: 'rate', key: t, effectiveFrom: rate.effective_from });
  }

  const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', w.entity).executeTakeFirstOrThrow();
  return {
    period: { period: w.ledger.period.period, from: w.from, to: w.to },
    household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: w.representativeName, openedOn: w.openedOn },
    form,
    rows,
    total,
    lines,
    unassigned,
    unassignedGross,
    totals,
    unconfirmed,
    commentary: unconfirmed.length > 0,
  };
}

export const householdS2a = defineQuery({
  name: 'finance.household.s2a',
  input: zHouseholdS2aGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS2a> => {
    const w = await householdBookWindow(ctx, input.legalEntityId, input.period, 'S2a');
    // S2a is the book of the percentage method; the form row says so, and the profile must agree on the last day.
    if (w.profile.pitMethod !== 'percentage') throw new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S2a trong kỳ đã chọn');
    return zHouseholdS2a.parse(await tradeRevenueBook(ctx, w, 'S2a'));
  },
});

export const householdS2aQueries = [householdS2a];
