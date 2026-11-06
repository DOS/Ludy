// SPDX-License-Identifier: AGPL-3.0-only
// The count of stock (kiểm kê, #2513 part b, ADR-0045 point 2, plan stock-and-marketplaces.md section 8.2): a person counts the goods on a day and types what was counted per item; the server
// works out the difference from the books (the item's moves up to that day), prices it, and when the count is confirmed posts it as adjustment moves and as one entry. The pure part
// (differences, prices, the entry) is domain/stock-count.ts; this file reads the moves, asks for the entry through the proposal path and writes the moves.
// - finance.stock_count.create (R1): a draft with what was counted. The day must have come and be in a month the stock has not closed. The lines are fixed once it is made; a mistake is
//   put right by cancelling the draft (finance.stock_count.cancel) and counting again.
// - finance.stock.prepare_count (R1): a user asks to confirm a draft through kernel.proposal.request; this works out the differences and builds the entry as a general journal voucher
//   proposal. It writes nothing. An item that differs and has no cost to price it at is named (type a unit cost on its line); a count that differs nowhere has no entry to approve.
// - finance.stock.count_confirm (R3, proposal): runs only through kernel.proposal.approve (P10 four-eyes, P11 fresh MFA, P12 eligible approvers). It takes the entity's move lock, builds the
//   differences again and refuses a proposal they no longer match, posts the voucher like any NVK (journal-voucher.ts, stockCountId set), confirms the count and writes one adjustment move
//   per item that differs, with its value, in the same transaction. The database keeps a count from being confirmed without its voucher and an adjustment from a count that is not confirmed.
// - finance.stock_count.confirm_empty (R1): the confirmation of a count that differs from the books nowhere: nothing to post, nothing to move.
// A confirmed count is final and its adjustments are never reversed: a count that was wrong is put right by a new count. Money and quantities are decimal.js and decimal strings throughout.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  JOURNAL_VOUCHER_KIND,
  STOCK_COUNT_COMMAND,
  zStockCountCreate,
  zStockCountIdInput,
  zStockCountListInput,
  zStockCountPreviewInput,
  zStockCountProposal,
  type StockCount,
  type StockCountPreviewRow,
  type StockCountProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import { journalVoucherProblems, journalVoucherTitle } from './domain/journal-voucher.ts';
import { stockMoveLockKey } from './domain/stock-close.ts';
import { countDescription, countDifferences, type CountItem, type CountLine, type CountResult } from './domain/stock-count.ts';
import { monthFigures, nextMonth, previousMonth } from './domain/stock-cost.ts';
import { postJournalVoucher } from './journal-voucher.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday, dateLabel, periodLockedThrough } from './period-lock.ts';
import { writeStockMove } from './stock.ts';
import { closedMonths, costOf, movesUpTo } from './stock-report.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const chunks = <T>(rows: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

interface CountHead {
  id: string;
  legal_entity_id: string;
  count_date: string;
  status: 'draft' | 'confirmed' | 'cancelled';
  note: string | null;
  loss_norm_percent: string;
  created_at: Date | string;
  confirmed_at: Date | string | null;
  voucher_id: string | null;
}

interface LineRow {
  id: string;
  item_id: string;
  counted_quantity: string;
  unit_cost: string | null;
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// The count as the caller sees it (RLS); `lock` holds its row until the transaction ends, so a confirmation and a cancellation cannot both win.
async function loadCount(ctx: Ctx, countId: string, lock = false): Promise<{ head: CountHead; lines: LineRow[] }> {
  const { rows } = await sql<CountHead>`
    SELECT c.id::text AS id, c.legal_entity_id::text AS legal_entity_id, c.count_date::text AS count_date, c.status, c.note, c.loss_norm_percent::text AS loss_norm_percent,
           c.created_at, c.confirmed_at, c.voucher_id::text AS voucher_id
    FROM crove_finance.stock_count c
    WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ${countId}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(ctx.trx);
  const head = rows[0];
  if (!head) throw new DomainError('STOCK_COUNT_NOT_FOUND', 404, 'Không tìm thấy lần kiểm kê này');
  const lines = await loadLines(ctx, [head.id]);
  return { head, lines: lines.get(head.id) ?? [] };
}

async function loadLines(ctx: Ctx, countIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const byCount = new Map<string, LineRow[]>();
  if (countIds.length === 0) return byCount;
  const { rows } = await sql<LineRow & { count_id: string }>`
    SELECT l.id::text AS id, l.count_id::text AS count_id, l.item_id::text AS item_id, l.counted_quantity::text AS counted_quantity, l.unit_cost::text AS unit_cost
    FROM crove_finance.stock_count_line l
    WHERE l.org_id = ${ctx.orgId}::uuid AND l.count_id = ANY (${[...countIds]}::uuid[])
    ORDER BY l.item_id`.execute(ctx.trx);
  for (const row of rows) {
    const bucket = byCount.get(row.count_id);
    if (bucket) bucket.push(row);
    else byCount.set(row.count_id, [row]);
  }
  return byCount;
}

interface ItemRow {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  unit: string;
  stock_account: string;
  active: boolean;
}

async function loadItems(ctx: Ctx, itemIds: readonly string[]): Promise<Map<string, ItemRow>> {
  const items = new Map<string, ItemRow>();
  if (itemIds.length === 0) return items;
  const rows = await ctx.trx
    .selectFrom('crove_finance.stock_item')
    .select(['id', 'legal_entity_id', 'code', 'name', 'unit', 'stock_account', 'active'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...itemIds])
    .execute();
  for (const row of rows) items.set(row.id, row);
  return items;
}

// The day a count is on has come (Vietnam's day, as the database holds it) and is in a month the stock has not closed.
async function assertOpenDate(ctx: Ctx, legalEntityId: string, countDate: string) {
  if (countDate > (await databaseToday(ctx.trx))) throw new DomainError('STOCK_COUNT_FUTURE', 422, 'Ngày kiểm kê chưa tới nên chưa kiểm kê được');
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM crove_finance.stock_period p
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${legalEntityId}::uuid AND p.period_month >= pg_catalog.date_trunc('month', ${countDate}::date)::date
    LIMIT 1`.execute(ctx.trx);
  if (rows[0]) throw new DomainError('STOCK_COUNT_CLOSED', 409, `Tháng của ngày ${dateLabel(countDate)} đã đóng sổ kho nên không kiểm kê được; hãy kiểm kê vào một ngày của tháng đang mở`);
}

// What the books hold of each item of the entity on `countDate`: the quantity (the last closed month's closing, then every move up to the day) and the month's provisional average up to the
// day. An item with no move and no balance is not in the map (it holds nothing).
async function bookFigures(ctx: Ctx, legalEntityId: string, countDate: string): Promise<Map<string, { bookQuantity: string; averageCost: string | null }>> {
  const month = countDate.slice(0, 7);
  const closed = await closedMonths(ctx, previousMonth(month), legalEntityId);
  const last = closed.lastByEntity.get(legalEntityId);
  const moves = (await movesUpTo(ctx, month, { legalEntityId, ...(last === undefined ? {} : { from: `${nextMonth(last)}-01` }) })).filter((m) => m.move_date <= countDate);
  const byItem = new Map<string, typeof moves>();
  for (const move of moves) {
    const bucket = byItem.get(move.item_id);
    if (bucket) bucket.push(move);
    else byItem.set(move.item_id, [move]);
  }
  const figures = new Map<string, { bookQuantity: string; averageCost: string | null }>();
  const ids = new Set<string>([...byItem.keys(), ...closed.snapshots.keys()]);
  for (const itemId of ids) {
    const snapshot = closed.snapshots.get(itemId);
    const own = byItem.get(itemId) ?? [];
    const opening = snapshot ? { quantity: snapshot.closing_quantity, value: snapshot.closing_value } : undefined;
    const quantity = own.reduce((sum, m) => sum.plus(money(m.quantity)), money(snapshot ? snapshot.closing_quantity : '0'));
    const average = monthFigures(own.map(costOf), month, opening ? { opening } : {})?.unitCost ?? null;
    figures.set(itemId, { bookQuantity: quantity.toFixed(), averageCost: average });
  }
  return figures;
}

interface Built {
  head: CountHead;
  result: CountResult;
  // SHA-256 of the canonical figures of every line, in item order: what makes a proposal stale when one changed.
  hash: string;
}

function fingerprint(result: CountResult): string {
  const rows = result.lines.map((l) => [l.itemId, l.bookQuantity, l.countedQuantity, l.difference, l.unitCost, l.value, l.withinNorm]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function buildCount(ctx: Ctx, head: CountHead, lines: readonly LineRow[], books?: Map<string, { bookQuantity: string; averageCost: string | null }>): Promise<Built> {
  const figures = books ?? (await bookFigures(ctx, head.legal_entity_id, head.count_date));
  const items = await loadItems(ctx, lines.map((l) => l.item_id));
  const inputs: CountItem[] = lines.map((line) => {
    const item = items.get(line.item_id);
    if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
    const book = figures.get(line.item_id);
    return {
      itemId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      stockAccount: item.stock_account,
      bookQuantity: book?.bookQuantity ?? '0',
      averageCost: book?.averageCost ?? null,
      countedQuantity: line.counted_quantity,
      unitCost: line.unit_cost,
    };
  });
  const result = countDifferences(inputs, head.loss_norm_percent);
  return { head, result, hash: fingerprint(result) };
}

async function assertLedgerOpen(ctx: QueryContext, countDate: string, legalEntityId: string) {
  const lockedThrough = await periodLockedThrough(ctx, legalEntityId);
  if (lockedThrough && countDate <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(countDate)}`, { lockedThrough, entryDate: countDate });
  }
}

// The entry is checked the way a voucher entered by hand is, when it is asked for and again when it is posted.
async function assertPostable(ctx: QueryContext, built: Built) {
  const lines = built.result.entry.map((l) => ({ account: l.account, partyId: null, debit: l.debit, credit: l.credit }));
  const problems = journalVoucherProblems(lines);
  if (problems.length > 0) throw new DomainError('STOCK_COUNT_UNSUPPORTED', 422, 'Không lập được bút toán chênh lệch kiểm kê: bút toán không hợp lệ', { problems });
  await assertUsableAccounts(ctx, lines.map((l) => l.account));
}

function proposalOf(built: Built): StockCountProposal {
  const payload = {
    date: built.head.count_date,
    description: countDescription(built.head.count_date),
    lines: built.result.entry.map((l) => ({ account: l.account, party: null, debit: l.debit, credit: l.credit })),
    total: built.result.total,
    countId: built.head.id,
    lineCount: built.result.lines.length,
    figuresHash: built.hash,
    legalEntityId: built.head.legal_entity_id,
  };
  const parsed = zStockCountProposal.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError('STOCK_COUNT_UNSUPPORTED', 422, 'Không lập được bút toán chênh lệch kiểm kê: quá nhiều tài khoản hoặc có số tiền lẻ dưới 1 đồng', {
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
    });
  }
  return parsed.data;
}

const sameProposal = (a: StockCountProposal, b: StockCountProposal) =>
  a.date === b.date &&
  a.description === b.description &&
  a.total === b.total &&
  a.countId === b.countId &&
  a.lineCount === b.lineCount &&
  a.figuresHash === b.figuresHash &&
  JSON.stringify(a.lines.map((l) => [l.account, l.debit, l.credit])) === JSON.stringify(b.lines.map((l) => [l.account, l.debit, l.credit]));

// Takes the entity's move lock alone: a confirmation waits for the moves being written, and the moves that come after wait for it, so the books it reads are the books it adjusts.
async function lockEntityMoves(ctx: CommandContext, legalEntityId: string) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${stockMoveLockKey(ctx.orgId, legalEntityId)}, 0))`.execute(ctx.trx);
}

function requireDraft(head: CountHead) {
  if (head.status !== 'draft') throw new DomainError('STOCK_COUNT_NOT_DRAFT', 409, 'Lần kiểm kê này đã được xác nhận hoặc đã hủy');
}

export const createStockCount = defineCommand({
  name: 'finance.stock_count.create',
  input: zStockCountCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input) => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    await assertOpenDate(ctx, legalEntityId, input.countDate);
    const ids = input.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw new DomainError('STOCK_COUNT_DUPLICATE_ITEM', 409, 'Một mặt hàng chỉ có một dòng trong lần kiểm kê');
    const items = await loadItems(ctx, ids);
    for (const id of ids) {
      const item = items.get(id);
      if (!item) throw new DomainError('STOCK_ITEM_NOT_FOUND', 404, 'Không tìm thấy mặt hàng này');
      if (item.legal_entity_id !== legalEntityId) throw new DomainError('STOCK_ITEM_ENTITY_MISMATCH', 422, 'Mặt hàng và lần kiểm kê thuộc hai pháp nhân khác nhau');
      if (!item.active) throw new DomainError('STOCK_ITEM_INACTIVE', 409, 'Mặt hàng này đã ngừng dùng');
    }
    const head = await ctx.trx
      .insertInto('crove_finance.stock_count')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        count_date: input.countDate,
        note: input.note?.trim() ? input.note.trim() : null,
        loss_norm_percent: input.lossNormPercent,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const batch of chunks(input.lines, 500)) {
      await ctx.trx
        .insertInto('crove_finance.stock_count_line')
        .values(batch.map((l) => ({ org_id: ctx.orgId, count_id: head.id, item_id: l.itemId, counted_quantity: l.countedQuantity, unit_cost: l.unitCost ?? null })))
        .execute();
    }
    ctx.audit({ count_id: head.id, lines: input.lines.length, legal_entity_id: legalEntityId, count_date: input.countDate });
    return { id: head.id };
  },
});

export const cancelStockCount = defineCommand({
  name: 'finance.stock_count.cancel',
  input: zStockCountIdInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, { countId }) => {
    const { head } = await loadCount(ctx, countId, true);
    requireDraft(head);
    await ctx.trx.updateTable('crove_finance.stock_count').set({ status: 'cancelled' }).where('org_id', '=', ctx.orgId).where('id', '=', head.id).execute();
    ctx.audit({ count_id: head.id });
    return { id: head.id };
  },
});

export const confirmEmptyStockCount = defineCommand({
  name: 'finance.stock_count.confirm_empty',
  input: zStockCountIdInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, { countId }) => {
    const { head, lines } = await loadCount(ctx, countId, true);
    requireDraft(head);
    await assertOpenDate(ctx, head.legal_entity_id, head.count_date);
    await lockEntityMoves(ctx, head.legal_entity_id);
    const built = await buildCount(ctx, head, lines);
    if (built.result.lines.some((l) => !money(l.difference).isZero())) {
      throw new DomainError('STOCK_COUNT_HAS_DIFFERENCE', 409, 'Lần kiểm kê này có chênh lệch so với sổ; hãy gửi đề xuất xác nhận để chủ sở hữu hoặc quản trị viên duyệt');
    }
    await ctx.trx
      .updateTable('crove_finance.stock_count')
      .set({ status: 'confirmed', confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null, confirmed_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', head.id)
      .execute();
    ctx.audit({ count_id: head.id, lines: lines.length, adjusted: 0 });
    return { id: head.id };
  },
});

export const prepareStockCount = defineCommand({
  name: 'finance.stock.prepare_count',
  input: zStockCountIdInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, { countId }) => {
    const { head, lines } = await loadCount(ctx, countId);
    requireDraft(head);
    await assertOpenDate(ctx, head.legal_entity_id, head.count_date);
    const built = await buildCount(ctx, head, lines);
    if (built.result.unpriced.length > 0) {
      const named = built.result.unpriced.slice(0, 5).map((u) => u.code).join(', ');
      throw new DomainError(
        'STOCK_COUNT_UNPRICED',
        422,
        `Mặt hàng ${named}${built.result.unpriced.length > 5 ? '…' : ''} có chênh lệch nhưng chưa có giá vốn để tính giá trị; hãy hủy lần kiểm kê nháp này và kiểm kê lại, nhập đơn giá vốn cho mặt hàng`,
        { items: built.result.unpriced.slice(0, 50).map((u) => ({ itemId: u.itemId, code: u.code })), count: built.result.unpriced.length },
      );
    }
    if (built.result.entry.length === 0) {
      throw new DomainError('STOCK_COUNT_NO_DIFFERENCE', 422, 'Lần kiểm kê này không chênh lệch so với sổ nên không có bút toán để duyệt; hãy xác nhận trực tiếp');
    }
    await assertLedgerOpen(ctx, head.count_date, head.legal_entity_id);
    await assertPostable(ctx, built);
    const payload = proposalOf(built);
    return { kind: JOURNAL_VOUCHER_KIND, command: STOCK_COUNT_COMMAND, title: journalVoucherTitle(payload), payload };
  },
});

export const confirmStockCount = defineCommand({
  name: STOCK_COUNT_COMMAND,
  input: z.object({ payload: zStockCountProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const { head, lines } = await loadCount(ctx, payload.countId, true);
    requireDraft(head);
    const legalEntityId = await resolveLegalEntity(ctx, payload.legalEntityId);
    if (legalEntityId !== head.legal_entity_id) throw new DomainError('STOCK_COUNT_STALE', 409, 'Đề xuất không còn khớp lần kiểm kê; hãy từ chối đề xuất này và lập lại');
    await lockEntityMoves(ctx, legalEntityId);
    await assertOpenDate(ctx, legalEntityId, head.count_date);
    const built = await buildCount(ctx, head, lines);
    await assertLedgerOpen(ctx, head.count_date, legalEntityId);
    await assertPostable(ctx, built);
    // The differences are worked out again from the books as they read now; a move written since the proposal was made changes them, and the proposal is refused rather than adjusting
    // stock by a difference that is no longer there.
    if (built.result.unpriced.length > 0 || built.result.entry.length === 0 || !sameProposal(proposalOf(built), payload)) {
      throw new DomainError('STOCK_COUNT_STALE', 409, `Số liệu kho đã thay đổi từ khi lập đề xuất xác nhận kiểm kê ngày ${dateLabel(head.count_date)}; hãy từ chối đề xuất này và lập lại`);
    }
    const posted = await postJournalVoucher(ctx, { ...payload, legalEntityId }, null, null, head.id);
    await ctx.trx
      .updateTable('crove_finance.stock_count')
      .set({ status: 'confirmed', confirmed_by: ctx.actor.type === 'user' ? ctx.actor.userId : null, confirmed_at: sql<Date>`pg_catalog.now()`, voucher_id: posted.voucherId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', head.id)
      .execute();
    const lineOf = new Map(lines.map((l) => [l.item_id, l.id]));
    let adjusted = 0;
    for (const line of built.result.lines) {
      if (money(line.difference).isZero()) continue;
      await writeStockMove(ctx, { itemId: line.itemId, date: head.count_date, quantity: line.difference, source: { type: 'count', countLineId: lineOf.get(line.itemId) as string, amount: line.value } });
      adjusted += 1;
    }
    ctx.audit({ count_id: head.id, lines: lines.length, adjusted, total: built.result.total, legal_entity_id: legalEntityId });
    return { ...posted, countId: head.id };
  },
});

// The items of an entity with what the books hold of each on the day, to count against: the active items, in code order.
export const previewStockCount = defineQuery({
  name: 'finance.stock_count.preview',
  input: zStockCountPreviewInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockCountPreviewRow[]> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    await assertOpenDate(ctx, legalEntityId, input.countDate);
    const items = await ctx.trx
      .selectFrom('crove_finance.stock_item')
      .select(['id', 'code', 'name', 'unit'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('active', '=', true)
      .orderBy('code')
      .execute();
    const books = await bookFigures(ctx, legalEntityId, input.countDate);
    return items.map((item) => ({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, bookQuantity: money(books.get(item.id)?.bookQuantity ?? '0').toFixed(), averageCost: books.get(item.id)?.averageCost ?? null }));
  },
});

const iso = (value: Date | string) => new Date(value).toISOString();

// The counts, newest first. A draft is worked out from the books as they read now; a confirmed count shows what its adjustments made; a cancelled one shows what was counted.
export const listStockCounts = defineQuery({
  name: 'finance.stock_count.list',
  input: zStockCountListInput,
  access: ALL,
  handler: async (ctx, input): Promise<StockCount[]> => {
    const { rows } = await sql<CountHead>`
      SELECT c.id::text AS id, c.legal_entity_id::text AS legal_entity_id, c.count_date::text AS count_date, c.status, c.note, c.loss_norm_percent::text AS loss_norm_percent,
             c.created_at, c.confirmed_at, c.voucher_id::text AS voucher_id
      FROM crove_finance.stock_count c
      WHERE c.org_id = ${ctx.orgId}::uuid AND (${input.legalEntityId ?? null}::uuid IS NULL OR c.legal_entity_id = ${input.legalEntityId ?? null}::uuid)
      ORDER BY c.count_date DESC, c.id DESC
      LIMIT ${input.limit ?? 30}`.execute(ctx.trx);
    const lineRows = await loadLines(ctx, rows.map((r) => r.id));
    const allLines = [...lineRows.values()].flat();
    const items = await loadItems(ctx, [...new Set(allLines.map((l) => l.item_id))]);
    // What the adjustments of the confirmed counts made, by line.
    const confirmedLineIds = rows.filter((r) => r.status === 'confirmed').flatMap((r) => (lineRows.get(r.id) ?? []).map((l) => l.id));
    const adjustments = new Map<string, { quantity: string; amount: string }>();
    if (confirmedLineIds.length > 0) {
      const { rows: moves } = await sql<{ count_line_id: string; quantity: string; amount: string }>`
        SELECT m.count_line_id::text AS count_line_id, m.quantity::text AS quantity, m.amount::text AS amount
        FROM crove_finance.stock_move m WHERE m.org_id = ${ctx.orgId}::uuid AND m.count_line_id = ANY (${confirmedLineIds}::uuid[])`.execute(ctx.trx);
      for (const m of moves) adjustments.set(m.count_line_id, { quantity: m.quantity, amount: m.amount });
    }
    const books = new Map<string, Awaited<ReturnType<typeof bookFigures>>>();
    const out: StockCount[] = [];
    for (const head of rows) {
      const lines = lineRows.get(head.id) ?? [];
      let shown: CountLine[];
      if (head.status === 'draft') {
        const key = `${head.legal_entity_id}|${head.count_date}`;
        let figures = books.get(key);
        if (!figures) {
          figures = await bookFigures(ctx, head.legal_entity_id, head.count_date);
          books.set(key, figures);
        }
        shown = (await buildCount(ctx, head, lines, figures)).result.lines;
      } else {
        shown = lines.map((line) => {
          const item = items.get(line.item_id);
          const adjustment = adjustments.get(line.id);
          const difference = adjustment ? money(adjustment.quantity) : money(0);
          const counted = money(line.counted_quantity);
          return {
            itemId: line.item_id,
            code: item?.code ?? '',
            name: item?.name ?? '',
            unit: item?.unit ?? '',
            stockAccount: item?.stock_account ?? '',
            bookQuantity: counted.minus(difference).toFixed(),
            countedQuantity: counted.toFixed(),
            difference: difference.toFixed(),
            unitCost: adjustment ? money(adjustment.amount).abs().dividedBy(difference.abs()).toDecimalPlaces(4).toFixed() : null,
            value: adjustment ? money(adjustment.amount).toFixed() : '0',
            withinNorm: '0',
          };
        });
      }
      out.push({
        id: head.id,
        legalEntityId: head.legal_entity_id,
        countDate: head.count_date,
        status: head.status,
        note: head.note,
        lossNormPercent: money(head.loss_norm_percent).toFixed(),
        createdAt: iso(head.created_at),
        confirmedAt: head.confirmed_at === null ? null : iso(head.confirmed_at),
        voucherId: head.voucher_id,
        lines: shown.map((l) => ({
          itemId: l.itemId,
          code: l.code,
          name: l.name,
          unit: l.unit,
          countedQuantity: l.countedQuantity,
          bookQuantity: l.bookQuantity,
          difference: l.difference,
          unitCost: l.unitCost,
          value: l.value,
          withinNorm: l.withinNorm,
        })),
      });
    }
    return out;
  },
});

export const stockCountCommands = [createStockCount, cancelStockCount, confirmEmptyStockCount, prepareStockCount, confirmStockCount];
export const stockCountQueries = [previewStockCount, listStockCounts];
