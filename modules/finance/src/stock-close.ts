// SPDX-License-Identifier: AGPL-3.0-only
// The close of a month of stock (#2513, ADR-0045 point 2, plan stock-and-marketplaces.md section 8.3): the month's moves are priced at the month's weighted average, the cost of what left
// is posted once, Dr 632 / Cr the stock accounts, and what the month held of each item is stored, so a report of a closed month reads that and never folds the moves again. The pure
// part (the figures and the entry) is domain/stock-close.ts; this file reads the moves, asks for the entry through the proposal path and stores the result.
// - finance.stock.prepare_close (R1): a user names the month through kernel.proposal.request; this reads the moves and builds the entry as a general journal voucher proposal. It writes
//   nothing. The month must be over, not closed, and the months before it closed (or empty); no item may be below zero at its end. A month with no cost has no entry to approve.
// - finance.stock.close_period (R3, proposal): runs only through kernel.proposal.approve (P10 four-eyes, P11 fresh MFA, P12 eligible approvers). It builds the figures again from the
//   moves and refuses a proposal they no longer match, posts the voucher like any NVK (journal-voucher.ts, stock_closing_month set) and stores the month and its items in the same
//   transaction. The database keeps a month from existing without its voucher (20261123140000) and from taking a move dated in it.
// - finance.stock.close_empty (R3, owners and admins): the same close for a month whose cost is zero (nothing left the stock, or the cost of what left nets to nothing): no entry, no approval.
// One close of an entity at a time, and no move is written while one runs (the same advisory lock, taken shared by writeStockMove), so the figures are those of every move that
// committed before it. A closed month is never reopened here: a correction is a move of the open month. Money is decimal.js and decimal strings throughout.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  JOURNAL_VOUCHER_KIND,
  STOCK_CLOSE_COMMAND,
  zStockCloseEmptyResult,
  zStockCloseProposal,
  zStockCloseRequest,
  type StockCloseEmptyResult,
  type StockCloseProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { closeDescription, closeMonth, monthEnd, stockMoveLockKey, type CloseItem, type CloseResult } from './domain/stock-close.ts';
import { assertUsableAccounts } from './accounts.ts';
import { nextMonth, previousMonth } from './domain/stock-cost.ts';
import { journalVoucherProblems, journalVoucherTitle } from './domain/journal-voucher.ts';
import { postJournalVoucher } from './journal-voucher.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday, dateLabel, periodLockedThrough } from './period-lock.ts';
import { closedMonths, costOf, movesUpTo } from './stock-report.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const CLOSERS: readonly MemberRole[] = ['owner', 'admin'];

const label = (month: string) => `${month.slice(5)}/${month.slice(0, 4)}`;
const chunks = <T>(rows: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

interface Built {
  month: string;
  legalEntityId: string;
  result: CloseResult;
  // SHA-256 of the canonical figures of every item, in item order: what makes a proposal stale when one changed.
  hash: string;
}

// The figures of every item as one fingerprint: the ids and the nine figures of each, in the order of the ids.
function fingerprint(result: CloseResult): string {
  const rows = [...result.items]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((f) => [f.itemId, f.openingQuantity, f.openingValue, f.inQuantity, f.inValue, f.outQuantity, f.outValue, f.closingQuantity, f.closingValue, f.unitCost]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// Everything a close needs, read once: refuses a month not over, one closed already (or before a closed one), one whose earlier months still hold moves, and any item below zero at the end.
async function build(ctx: QueryContext, month: string, legalEntityId: string): Promise<Built> {
  const today = await databaseToday(ctx.trx);
  if (`${nextMonth(month)}-01` > today) throw new DomainError('STOCK_CLOSE_NOT_ENDED', 422, `Tháng ${label(month)} chưa kết thúc nên chưa đóng sổ kho được`);
  const { rows: later } = await sql<{ month: string }>`
    SELECT pg_catalog.to_char(p.period_month, 'YYYY-MM') AS month FROM crove_finance.stock_period p
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${legalEntityId}::uuid AND p.period_month >= ${`${month}-01`}::date
    ORDER BY p.period_month LIMIT 1`.execute(ctx.trx);
  if (later[0]) {
    const same = later[0].month === month;
    throw new DomainError('STOCK_CLOSE_DONE', 409, same ? `Tháng ${label(month)} đã đóng sổ kho rồi` : `Tháng ${label(later[0].month)} đã đóng sổ kho nên tháng ${label(month)} không đóng riêng được`, { month });
  }
  const closed = await closedMonths(ctx, previousMonth(month), legalEntityId);
  const last = closed.lastByEntity.get(legalEntityId);
  // Months close in order: no move may sit between the last closed month and this one. Only the moves after the last closed month are read, the closed ones are stored.
  const gapFrom = last === undefined ? '0000-01-01' : `${nextMonth(last)}-01`;
  const moves = await movesUpTo(ctx, month, { legalEntityId, ...(last === undefined ? {} : { from: gapFrom }) });
  const gap = moves.find((m) => m.move_date >= gapFrom && m.move_date < `${month}-01`);
  if (gap) {
    const earlier = gap.move_date.slice(0, 7);
    throw new DomainError('STOCK_CLOSE_ORDER', 409, `Tháng ${label(earlier)} còn phát sinh kho chưa đóng sổ; hãy đóng tháng đó trước`, { month: earlier });
  }
  const items = await ctx.trx
    .selectFrom('crove_finance.stock_item')
    .select(['id', 'code', 'name', 'unit', 'stock_account'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .orderBy('id')
    .execute();
  const byItem = new Map<string, ReturnType<typeof costOf>[]>();
  for (const move of moves) {
    if (move.move_date < gapFrom) continue;
    const bucket = byItem.get(move.item_id);
    if (bucket) bucket.push(costOf(move));
    else byItem.set(move.item_id, [costOf(move)]);
  }
  const closeItems: CloseItem[] = items.map((item) => {
    const snapshot = closed.snapshots.get(item.id);
    return {
      itemId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      stockAccount: item.stock_account,
      moves: byItem.get(item.id) ?? [],
      ...(snapshot ? { opening: { quantity: snapshot.closing_quantity, value: snapshot.closing_value } } : {}),
    };
  });
  const result = closeMonth(closeItems, month);
  if (result.negative.length > 0) {
    const named = result.negative.slice(0, 5).map((n) => n.code).join(', ');
    throw new DomainError(
      'STOCK_CLOSE_NEGATIVE',
      422,
      `Còn mặt hàng âm kho cuối tháng ${label(month)}: ${named}${result.negative.length > 5 ? '…' : ''}; hãy nhập mua hàng hoặc kiểm kê trước khi đóng sổ`,
      { items: result.negative.slice(0, 50).map((n) => ({ itemId: n.itemId, code: n.code, closingQuantity: n.closingQuantity })), count: result.negative.length },
    );
  }
  if (result.unpriced.length > 0) {
    const named = result.unpriced.slice(0, 5).map((n) => n.code).join(', ');
    throw new DomainError(
      'STOCK_CLOSE_UNPRICED',
      422,
      `Mặt hàng ${named}${result.unpriced.length > 5 ? '…' : ''} có xuất hoặc nhập lại trong tháng ${label(month)} nhưng chưa có giá trị để tính giá vốn (chưa có hóa đơn mua ghi giá trị); hãy nhập hóa đơn mua của mặt hàng trước khi đóng sổ`,
      { items: result.unpriced.slice(0, 50).map((n) => ({ itemId: n.itemId, code: n.code, outQuantity: n.outQuantity })), count: result.unpriced.length },
    );
  }
  return { month, legalEntityId, result, hash: fingerprint(result) };
}

async function assertLedgerOpen(ctx: QueryContext, month: string, legalEntityId: string) {
  const lockedThrough = await periodLockedThrough(ctx, legalEntityId);
  if (lockedThrough && monthEnd(month) <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(monthEnd(month))}`, {
      lockedThrough,
      entryDate: monthEnd(month),
    });
  }
}

// The entry is checked the way a voucher entered by hand is, when it is asked for and again when it is posted: its lines are sound and its accounts exist in the org's chart and are in use
// (a stock sub-account deactivated since the items were booked is refused here, not posted to).
async function assertPostable(ctx: QueryContext, built: Built) {
  const lines = built.result.lines.map((l) => ({ account: l.account, partyId: null, debit: l.debit, credit: l.credit }));
  const problems = journalVoucherProblems(lines);
  if (problems.length > 0) throw new DomainError('STOCK_CLOSE_UNSUPPORTED', 422, `Không lập được bút toán giá vốn tháng ${label(built.month)}: bút toán không hợp lệ`, { problems });
  await assertUsableAccounts(ctx, lines.map((l) => l.account));
}

function proposalOf(built: Built): StockCloseProposal {
  const payload = {
    date: monthEnd(built.month),
    description: closeDescription(built.month),
    lines: built.result.lines.map((l) => ({ account: l.account, party: null, debit: l.debit, credit: l.credit })),
    total: built.result.total,
    closingMonth: built.month,
    itemCount: built.result.items.length,
    figuresHash: built.hash,
    legalEntityId: built.legalEntityId,
  };
  const parsed = zStockCloseProposal.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError('STOCK_CLOSE_UNSUPPORTED', 422, `Không lập được bút toán giá vốn tháng ${label(built.month)}: quá nhiều tài khoản kho hoặc có số tiền lẻ dưới 1 đồng`, {
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
    });
  }
  return parsed.data;
}

const sameProposal = (a: StockCloseProposal, b: StockCloseProposal) =>
  a.date === b.date &&
  a.description === b.description &&
  a.total === b.total &&
  a.closingMonth === b.closingMonth &&
  a.itemCount === b.itemCount &&
  a.figuresHash === b.figuresHash &&
  JSON.stringify(a.lines.map((l) => [l.account, l.debit, l.credit])) === JSON.stringify(b.lines.map((l) => [l.account, l.debit, l.credit]));

// Takes the entity's lock alone: a close waits for the moves being written, and the moves that come after wait for the close.
async function lockEntityMoves(ctx: CommandContext, legalEntityId: string) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${stockMoveLockKey(ctx.orgId, legalEntityId)}, 0))`.execute(ctx.trx);
}

// Stores the month and what it held of each item. `voucherId` is the voucher that posted the cost, null for a month with none.
async function storePeriod(ctx: CommandContext, built: Built, voucherId: string | null): Promise<string> {
  const period = await ctx.trx
    .insertInto('crove_finance.stock_period')
    .values({
      org_id: ctx.orgId,
      legal_entity_id: built.legalEntityId,
      period_month: `${built.month}-01`,
      voucher_id: voucherId,
      total_cost: built.result.total,
      closed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const batch of chunks(built.result.items, 500)) {
    await ctx.trx
      .insertInto('crove_finance.stock_period_item')
      .values(
        batch.map((f) => ({
          org_id: ctx.orgId,
          period_id: period.id,
          item_id: f.itemId,
          opening_quantity: f.openingQuantity,
          opening_value: f.openingValue,
          in_quantity: f.inQuantity,
          in_value: f.inValue,
          out_quantity: f.outQuantity,
          out_value: f.outValue,
          closing_quantity: f.closingQuantity,
          closing_value: f.closingValue,
          unit_cost: f.unitCost,
        })),
      )
      .execute();
  }
  ctx.audit({ month: built.month, legal_entity_id: built.legalEntityId, items: built.result.items.length, total: built.result.total, entry: voucherId !== null });
  return period.id;
}

export const prepareStockClose = defineCommand({
  name: 'finance.stock.prepare_close',
  input: zStockCloseRequest,
  risk: 'R1',
  sideEffect: 'internal',
  access: REQUESTERS,
  handler: async (ctx, { month, legalEntityId: requested }) => {
    // The legal entity whose stock is closed (#1280), stored with the proposal so the approver posts it there.
    const legalEntityId = await resolveLegalEntity(ctx, requested);
    const built = await build(ctx, month, legalEntityId);
    if (built.result.lines.length === 0) {
      throw new DomainError('STOCK_CLOSE_NO_COST', 422, `Tháng ${label(month)} không có giá vốn để ghi sổ; đóng sổ kho tháng này trực tiếp, không cần duyệt`);
    }
    await assertLedgerOpen(ctx, month, legalEntityId);
    await assertPostable(ctx, built);
    const payload = proposalOf(built);
    return { kind: JOURNAL_VOUCHER_KIND, command: STOCK_CLOSE_COMMAND, title: journalVoucherTitle(payload), payload };
  },
});

export const recordStockClose = defineCommand({
  name: STOCK_CLOSE_COMMAND,
  input: z.object({ payload: zStockCloseProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const month = payload.closingMonth;
    const legalEntityId = await resolveLegalEntity(ctx, payload.legalEntityId);
    await lockEntityMoves(ctx, legalEntityId);
    const built = await build(ctx, month, legalEntityId);
    await assertLedgerOpen(ctx, month, legalEntityId);
    await assertPostable(ctx, built);
    // The figures are built again from the moves as they read now; a move written since the proposal was made changes them, and the proposal is refused rather than posting a cost
    // that leaves the month's stock behind.
    if (built.result.lines.length === 0 || !sameProposal(proposalOf(built), payload)) {
      throw new DomainError('STOCK_CLOSE_STALE', 409, `Số liệu kho tháng ${label(month)} đã thay đổi từ khi lập đề xuất đóng sổ; hãy từ chối đề xuất này và lập lại`);
    }
    const posted = await postJournalVoucher(ctx, { ...payload, legalEntityId }, null, month);
    const periodId = await storePeriod(ctx, built, posted.voucherId);
    return { ...posted, periodId };
  },
});

export const closeEmptyStockMonth = defineCommand({
  name: 'finance.stock.close_empty',
  input: zStockCloseRequest,
  // Closing a month cannot be undone here (its moves are locked and its figures kept), so it is R3 like the posting that closes a month with cost, but it posts nothing.
  risk: 'R3',
  sideEffect: 'internal',
  access: CLOSERS,
  handler: async (ctx, { month, legalEntityId: requested }): Promise<StockCloseEmptyResult> => {
    const legalEntityId = await resolveLegalEntity(ctx, requested);
    await lockEntityMoves(ctx, legalEntityId);
    const built = await build(ctx, month, legalEntityId);
    if (built.result.lines.length > 0) {
      throw new DomainError('STOCK_CLOSE_HAS_COST', 409, `Tháng ${label(month)} có giá vốn cần ghi sổ; hãy lập đề xuất đóng sổ kho để chủ sở hữu hoặc quản trị viên duyệt`);
    }
    const periodId = await storePeriod(ctx, built, null);
    return zStockCloseEmptyResult.parse({ periodId, items: built.result.items.length });
  },
});

export const stockCloseCommands = [prepareStockClose, recordStockClose, closeEmptyStockMonth];
