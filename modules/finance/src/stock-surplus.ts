// SPDX-License-Identifier: AGPL-3.0-only
// The resolution of the surplus of a count of stock (#3712 slice 2a; plan stock-and-marketplaces.md section 8.2, research row C3). It is not a command of its own and it has no approval policy of
// its own: it is a prefilled general journal voucher that finance.journal_voucher.record posts, so it follows every rule of a posting (R3, four-eyes, fresh MFA, the ledger policy).
// - The request (kernel.proposal.request, command finance.journal_voucher.record, input { surplus: { countId, account, partyId? } }) reaches finance.journal_voucher.prepare, which calls
//   `surplusVoucherRequest` below to build the voucher: Dr 3381 / Cr `account`, for the amount the books give, never one the requester sent. The account is one of 711, 3388 and 331 (331 with a supplier).
// - The proposal carries `surplusCountId`. At approval `checkSurplusVoucher` works the amount out again from the count's adjustments and refuses a proposal that is not exactly that voucher
//   (STOCK_SURPLUS_STALE); the voucher is then written with the tag column journal_voucher.surplus_count_id, which the database accepts only from an executing finance.journal_voucher.record proposal
//   and only once per count (20270117110000).
// - A surplus is resolved once: a standing voucher (STOCK_SURPLUS_RESOLVED) or another proposal waiting (STOCK_SURPLUS_PENDING) refuses a second. A voucher whose entry is later reversed keeps the
//   count resolved: correcting it is a journal voucher by hand, not a second resolution.
// Facts only, no model.
import { sql } from 'kysely';
import {
  JOURNAL_VOUCHER_KIND,
  STOCK_SURPLUS_NOTE_ITEMS,
  zStockCountIdInput,
  type JournalVoucherProposal,
  type JournalVoucherRequest,
  type StockSurplusSource,
  type SurplusResolutionRequest,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { SURPLUS_ACCOUNT } from './domain/stock-count.ts';
import { isSurplusVoucher, surplusAmount, surplusDescription, surplusVoucherLines } from './domain/stock-surplus.ts';
import { databaseToday } from './period-lock.ts';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

interface CountSurplus {
  countId: string;
  legalEntityId: string;
  countDate: string;
  status: string;
  // Whole dong, '0' when the count has none.
  amount: string;
}

// A count of the org and what its adjustments brought in. `lock` serializes the request and the approval of the same count.
async function countSurplus(ctx: Ctx, countId: string, lock: boolean): Promise<CountSurplus> {
  if (lock) await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.stock_surplus:${ctx.orgId}:${countId}`}, 0))`.execute(ctx.trx);
  const { rows } = await sql<{ id: string; legal_entity_id: string; count_date: string; status: string }>`
    SELECT c.id::text AS id, c.legal_entity_id::text AS legal_entity_id, c.count_date::text AS count_date, c.status
    FROM crove_finance.stock_count c WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ${countId}::uuid`.execute(ctx.trx);
  const head = rows[0];
  if (!head) throw new DomainError('STOCK_COUNT_NOT_FOUND', 404, 'Không tìm thấy lần kiểm kê này');
  const { rows: moves } = await sql<{ amount: string }>`
    SELECT m.amount::text AS amount
    FROM crove_finance.stock_move m
    JOIN crove_finance.stock_count_line l ON l.org_id = m.org_id AND l.id = m.count_line_id
    WHERE m.org_id = ${ctx.orgId}::uuid AND l.count_id = ${countId}::uuid AND m.source_type = 'count'`.execute(ctx.trx);
  return { countId: head.id, legalEntityId: head.legal_entity_id, countDate: head.count_date, status: head.status, amount: surplusAmount(moves) };
}

// The voucher that resolved a count's surplus, and the proposal of one that waits (or was approved and has not run), other than `ownProposalId`.
export async function surplusStanding(ctx: Ctx, countId: string, ownProposalId?: string): Promise<{ voucherId: string | null; proposalId: string | null }> {
  const voucher = await ctx.trx.selectFrom('crove_finance.journal_voucher').select('id').where('org_id', '=', ctx.orgId).where('surplus_count_id', '=', countId).executeTakeFirst();
  let query = ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', JOURNAL_VOUCHER_KIND)
    .where('status', 'in', ['pending', 'approved'])
    .where(sql<boolean>`payload->>'surplusCountId' = ${countId}`)
    .orderBy('created_at')
    .orderBy('id');
  if (ownProposalId) query = query.where('id', '<>', ownProposalId);
  const proposal = await query.executeTakeFirst();
  return { voucherId: voucher?.id ?? null, proposalId: proposal?.id ?? null };
}

function refuseUnresolvable(count: CountSurplus): void {
  if (count.status !== 'confirmed') throw new DomainError('STOCK_SURPLUS_NOT_CONFIRMED', 409, 'Chỉ xử lý được hàng thừa của một lần kiểm kê đã xác nhận');
  if (count.amount === '0') throw new DomainError('STOCK_SURPLUS_NONE', 422, 'Lần kiểm kê này không có hàng thừa để xử lý');
}

// The request of the voucher a person asked for: the lines from the count, never from the requester; dated today (the voucher's own guards refuse a locked period). Called by the voucher's
// preparer, which builds the proposal from it as for any voucher and then tags it with the count.
export async function surplusVoucherRequest(ctx: Ctx, request: SurplusResolutionRequest): Promise<{ request: JournalVoucherRequest; surplusCountId: string }> {
  // An id is compared and locked as text below: the lower-case form, whatever case the requester wrote (a uuid is accepted in both).
  const countId = request.surplus.countId.toLowerCase();
  const { account } = request.surplus;
  const partyId = request.surplus.partyId?.toLowerCase();
  if (account === '331' && !partyId) throw new DomainError('STOCK_SURPLUS_PARTY_REQUIRED', 422, 'Ghi nhận vào 331 cần chọn nhà cung cấp là chủ của số hàng thừa');
  if (account !== '331' && partyId) throw new DomainError('STOCK_SURPLUS_PARTY_UNEXPECTED', 422, 'Chỉ chọn nhà cung cấp khi ghi nhận vào 331');
  const count = await countSurplus(ctx, countId, true);
  refuseUnresolvable(count);
  const standing = await surplusStanding(ctx, countId);
  if (standing.voucherId) throw new DomainError('STOCK_SURPLUS_RESOLVED', 409, 'Hàng thừa của lần kiểm kê này đã được xử lý', { voucherId: standing.voucherId });
  if (standing.proposalId) throw new DomainError('STOCK_SURPLUS_PENDING', 409, 'Đã có đề xuất xử lý hàng thừa của lần kiểm kê này đang chờ duyệt: hãy duyệt hoặc từ chối đề xuất đó', { proposalId: standing.proposalId });
  const today = await databaseToday(ctx.trx);
  const date = today < count.countDate ? count.countDate : today;
  return {
    surplusCountId: countId,
    request: {
      date,
      description: surplusDescription(count.countDate, account),
      legalEntityId: count.legalEntityId,
      lines: surplusVoucherLines(count.amount, account, partyId ?? null).map((l) => ({ account: l.account, partyId: l.partyId, debit: l.debit, credit: l.credit })),
    },
  };
}

// The approval's check, on the stored payload: the count is confirmed and in the voucher's legal entity, its surplus is worth what the voucher says now, the voucher is exactly Dr 3381 / Cr one
// of the three accounts, and nothing resolved it in between. A requester never reaches this amount: the payload is built by the preparer, and this refuses one that is not what the books say.
export async function checkSurplusVoucher(ctx: Ctx, payload: JournalVoucherProposal, ownProposalId: string): Promise<void> {
  const countId = payload.surplusCountId;
  if (!countId) return;
  const count = await countSurplus(ctx, countId, true);
  refuseUnresolvable(count);
  const stale = () =>
    new DomainError('STOCK_SURPLUS_STALE', 409, 'Số liệu hàng thừa của lần kiểm kê đã thay đổi từ khi lập đề xuất; hãy từ chối đề xuất này và lập lại');
  if (!payload.legalEntityId || payload.legalEntityId !== count.legalEntityId) throw stale();
  if (payload.date < count.countDate) throw stale();
  if (!isSurplusVoucher(payload, count.amount).ok) throw stale();
  const standing = await surplusStanding(ctx, countId, ownProposalId);
  if (standing.voucherId) throw new DomainError('STOCK_SURPLUS_RESOLVED', 409, 'Hàng thừa của lần kiểm kê này đã được xử lý', { voucherId: standing.voucherId });
}

// What a person needs to decide where the surplus goes (#3712 slice 2b), read from the books and nothing else: the items in surplus (largest by value first), the total, the supplier the goods were
// last received from when there is one, and whether a person already made an entry by hand on 3381 since the count. The supplier is a hint the screen may offer; it is never chosen here, and what
// the person picks still goes through the resolution request above. A count that is not confirmed or has no surplus is refused like a resolution is.
// A viewer is left out: the answer names a supplier and may spend from the AI budget.
const SURPLUS_VIEW_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

// A quantity as the person reads it: the column's trailing zeros dropped ("3.000000" is "3", "2.500000" is "2.5"), by a scan from the end.
function plainQuantity(value: string): string {
  if (!value.includes('.')) return value;
  let end = value.length;
  while (end > 0 && value[end - 1] === '0') end -= 1;
  if (end > 0 && value[end - 1] === '.') end -= 1;
  return value.slice(0, end);
}

export const surplusSource = defineQuery({
  name: 'finance.stock_count.surplus_source',
  input: zStockCountIdInput,
  access: SURPLUS_VIEW_ROLES,
  handler: async (ctx, input): Promise<StockSurplusSource> => {
    const countId = input.countId.toLowerCase();
    const count = await countSurplus(ctx, countId, false);
    refuseUnresolvable(count);
    const { rows: moves } = await sql<{ item_id: string; name: string; unit: string; quantity: string; amount: string }>`
      SELECT m.item_id::text AS item_id, i.name, i.unit, m.quantity::text AS quantity, m.amount::text AS amount
      FROM crove_finance.stock_move m
      JOIN crove_finance.stock_count_line l ON l.org_id = m.org_id AND l.id = m.count_line_id
      JOIN crove_finance.stock_item i ON i.org_id = m.org_id AND i.id = m.item_id
      WHERE m.org_id = ${ctx.orgId}::uuid AND l.count_id = ${countId}::uuid AND m.source_type = 'count' AND m.amount > 0
      ORDER BY m.amount DESC, i.name, m.id`.execute(ctx.trx);
    const shown = moves.slice(0, STOCK_SURPLUS_NOTE_ITEMS).map((m) => ({ name: m.name, quantity: plainQuantity(m.quantity), unit: m.unit, value: money(m.amount).toDecimalPlaces(0).toFixed() }));
    // The party of the latest purchase that received any of these items, in the count's own entity, up to the count date; a voided document is none.
    const itemIds = [...new Set(moves.map((m) => m.item_id))];
    let supplier: StockSurplusSource['supplier'] = null;
    if (itemIds.length > 0) {
      const { rows } = await sql<{ party_id: string; name: string; received: string }>`
        SELECT d.party_id::text AS party_id, p.name, m.move_date::text AS received
        FROM crove_finance.stock_move m
        JOIN crove_finance.purchase_document d ON d.org_id = m.org_id AND d.id = m.document_id
        JOIN crove_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
        WHERE m.org_id = ${ctx.orgId}::uuid AND m.legal_entity_id = ${count.legalEntityId}::uuid AND m.source_type = 'document_line' AND m.quantity > 0 AND d.direction = 'purchase'
          AND m.item_id = ANY (${itemIds}::uuid[]) AND m.move_date <= ${count.countDate}::date
          AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id)
        ORDER BY m.move_date DESC, m.created_at DESC, m.id DESC
        LIMIT 1`.execute(ctx.trx);
      const hit = rows[0];
      if (hit) supplier = { partyId: hit.party_id, name: hit.name, lastReceived: hit.received };
    }
    // A manual entry on 3381 in this entity since the count: a general voucher of a person's own (no count, no resolution tag), not a reversal.
    const { rows: manual } = await sql<{ one: number }>`
      SELECT 1 AS one
      FROM crove_finance.journal_line jl
      JOIN crove_finance.journal_entry e ON e.org_id = jl.org_id AND e.id = jl.entry_id
      JOIN crove_finance.journal_voucher v ON v.org_id = e.org_id AND v.id::text = e.source_id::text
      WHERE jl.org_id = ${ctx.orgId}::uuid AND jl.account_code = ${SURPLUS_ACCOUNT} AND jl.legal_entity_id = ${count.legalEntityId}::uuid
        AND e.source_type = 'finance.journal_voucher' AND e.reverses_entry_id IS NULL AND e.entry_date >= ${count.countDate}::date
        AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)
        AND v.stock_count_id IS NULL AND v.surplus_count_id IS NULL AND v.closing_year IS NULL AND v.stock_closing_month IS NULL
      LIMIT 1`.execute(ctx.trx);
    const standing = await surplusStanding(ctx, countId);
    return {
      countId,
      countDate: count.countDate,
      total: count.amount,
      items: shown,
      moreItems: Math.max(0, moves.length - shown.length),
      supplier,
      manualEntry: manual.length > 0,
      voucherId: standing.voucherId,
      proposalId: standing.proposalId,
    };
  },
});
