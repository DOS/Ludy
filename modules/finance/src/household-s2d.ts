// SPDX-License-Identifier: AGPL-3.0-only
// S2d-HKD, the goods book of a household business that pays PIT on income (#2517 slice 2d, Circular 152/2025/TT-BTC, plan docs/plan/stock-and-marketplaces.md sections 8.3, 8.5 and 12 row 5), a view of #2513's
// stock data. A BOOK: Ludy never files anything.
// - finance.household.s2d (every role that reads the ledger): per item of the household's entity, for ONE month, the opening quantity and value, one row per stock move (quantity in or out, the value a purchase
//   line brought in, the document reference, the balance in quantity) and the totals (in, out, closing, unit cost). Nothing is recomputed: the moves, the weighted average and the stored close come from the
//   same functions as finance.stock.report, so the book and the report cannot disagree. What leaves is valued on the totals line only (a month average cannot be split per move without rounding drift).
// - The month is not closed until a person closes it (stock-close.ts): `monthClosed` is false and the screen and the Excel file say the cost is provisional. While the S2d layout row is `commentary` the book also
//   carries "Số liệu tạm, kế toán chưa xác nhận bố cục sổ" (no rate stands behind it); both go by themselves.
// - A quarter or a year is not offered: chaining the months or one whole-period average is the accountant's question (#2520, B5).
// - Nothing in it is AI: quantities and values are stock facts.
// Amounts and quantities are decimal strings through decimal.js, never JS numbers.
import { zHouseholdS2d, zHouseholdS2dGet, type HouseholdS2d, type HouseholdS2dItem } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { pickInForce } from './domain/household-rules.ts';
import { plainQuantity } from './domain/stock.ts';
import { HOUSEHOLD_S1A_ROW_LIMIT, householdBookWindow } from './household-books.ts';
import { closedMonths, figuresOf, movesUpTo } from './stock-report.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const householdS2d = defineQuery({
  name: 'finance.household.s2d',
  input: zHouseholdS2dGet,
  access: ALL,
  handler: async (ctx, input): Promise<HouseholdS2d> => {
    // The stock cost is a monthly average, so the book is one month; whether to chain months or take a whole-period average is the accountant's question (#2520, B5).
    if (!/^\d{4}-\d{2}$/.test(input.month)) throw new DomainError('HOUSEHOLD_S2D_MONTH_ONLY', 422, 'Sổ S2d chỉ lập theo từng tháng vì giá vốn tính bình quân theo tháng; hãy chọn một tháng');
    const w = await householdBookWindow(ctx, input.legalEntityId, input.month, 'S2d');
    // S2d is a book of the income method; the form row says so, and the profile must agree on the last day.
    if (w.profile.pitMethod !== 'income') throw new DomainError('HOUSEHOLD_BOOK_NOT_REQUIRED', 422, 'Hồ sơ hộ kinh doanh của pháp nhân này không yêu cầu sổ S2d trong kỳ đã chọn');

    const items = await ctx.trx
      .selectFrom('crove_finance.stock_item')
      .select(['id', 'code', 'name', 'unit', 'active'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', w.entity)
      .orderBy('code')
      .execute();
    const moves = await movesUpTo(ctx, input.month, { legalEntityId: w.entity });
    const closed = await closedMonths(ctx, input.month, w.entity);
    const monthStart = `${input.month}-01`;
    const byItem = new Map<string, typeof moves>();
    for (const m of moves) byItem.set(m.item_id, [...(byItem.get(m.item_id) ?? []), m]);

    // The invoice number of the purchase document a move came from, for the reference column.
    const docIds = [...new Set(moves.filter((m) => m.move_date >= monthStart && m.document_id !== null).map((m) => m.document_id as string))];
    const refs = new Map<string, string>();
    if (docIds.length > 0) {
      const docs = await ctx.trx.selectFrom('crove_finance.purchase_document').select(['id', 'invoice_series', 'invoice_number']).where('org_id', '=', ctx.orgId).where('id', 'in', docIds).execute();
      for (const d of docs) if (d.invoice_number) refs.set(d.id, `${d.invoice_series ? `${d.invoice_series}-` : ''}${d.invoice_number}`);
    }

    const out: HouseholdS2dItem[] = [];
    // The audit row of an export caps the rows it records, so a month with more moves than the other books allow is refused here, before any file is built.
    if (moves.filter((m) => m.move_date >= monthStart).length > HOUSEHOLD_S1A_ROW_LIMIT) throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng trong một kỳ; hãy chọn kỳ ngắn hơn');
    // The month is closed when the entity closed it: every item then comes from what the close stored.
    const monthClosed = closed.lastByEntity.get(w.entity) === input.month;
    for (const item of items) {
      const own = byItem.get(item.id) ?? [];
      const { figures } = figuresOf(own, input.month, item.id, w.entity, closed);
      if (own.length === 0 && !item.active && figures === null) continue;
      const inMonth = own.filter((m) => m.move_date >= monthStart);
      const zero = '0';
      const f = {
        openingQuantity: figures?.openingQuantity ?? zero,
        openingValue: figures?.openingValue ?? zero,
        inQuantity: figures?.inQuantity ?? zero,
        inValue: figures?.inValue ?? zero,
        outQuantity: figures?.outQuantity ?? zero,
        outValue: figures?.outValue ?? zero,
        closingQuantity: figures?.closingQuantity ?? zero,
        closingValue: figures?.closingValue ?? zero,
      };
      // An item with nothing in the month and nothing on hand has nothing to show.
      if (inMonth.length === 0 && money(f.openingQuantity).isZero() && money(f.openingValue).isZero() && money(f.closingQuantity).isZero() && money(f.closingValue).isZero()) continue;
      let balance = money(f.openingQuantity);
      const rows = inMonth.map((m) => {
        balance = balance.plus(money(m.quantity));
        const q = money(m.quantity);
        return {
          moveId: m.id,
          date: m.move_date,
          source: m.source_type,
          reference: m.document_id === null ? null : (refs.get(m.document_id) ?? null),
          quantityIn: q.isNegative() ? '0' : plainQuantity(m.quantity),
          quantityOut: q.isNegative() ? plainQuantity(q.negated().toFixed()) : '0',
          valueIn: m.value === null ? null : toMoney(money(m.value)),
          balanceQuantity: plainQuantity(balance.toFixed()),
        };
      });
      out.push({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, ...f, rows, unitCost: figures?.unitCost ?? null });
    }
    const totals = {
      openingValue: toMoney(sum(out.map((i) => i.openingValue))),
      inValue: toMoney(sum(out.map((i) => i.inValue))),
      outValue: toMoney(sum(out.map((i) => i.outValue))),
      closingValue: toMoney(sum(out.map((i) => i.closingValue))),
    };

    const unconfirmed: HouseholdS2d['unconfirmed'] = [];
    const formRows = await ctx.trx.selectFrom('crove_finance.household_form_version').select(['book', 'version', 'effective_from', 'name', 'status']).where('book', '=', 'S2d').where('effective_from', '<=', w.to).execute();
    const formInForce = pickInForce(formRows, (r) => r.book, w.to)[0];
    const form = formInForce ? { book: formInForce.book, version: formInForce.version, name: formInForce.name, status: formInForce.status } : w.form;
    if (form.status !== 'confirmed') unconfirmed.push({ kind: 'form', key: `S2d ${form.version}`, effectiveFrom: formInForce?.effective_from ?? w.from });

    const entityRow = await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', w.entity).executeTakeFirstOrThrow();
    return zHouseholdS2d.parse({
      period: { month: input.month, from: w.ledger.period.from, to: w.ledger.period.to },
      household: { name: entityRow.name, taxCode: entityRow.tax_code, representativeName: w.representativeName, openedOn: w.openedOn },
      form,
      items: out,
      totals,
      monthClosed,
      unconfirmed,
      commentary: unconfirmed.length > 0,
    });
  },
});

export const householdS2dQueries = [householdS2d];
