// SPDX-License-Identifier: AGPL-3.0-only
// Accounting's side of the first cross-app rule (Vy V4, #2967; contract in packages/kernel-contract/src/signals.ts): `finance.signals.sales`, one small R0 read that answers,
// for the parties it is asked about (the parties of the won deals the CRM listed), the day of their latest sales invoice and how many there are, so the kernel can tell a won deal
// that was invoiced from one that was not. No text, no model, no write.
//
// What counts as invoiced: a sales invoice that is recorded in the books and not voided, with a positive total (an adjustment that only lowers an invoice is not a sale). A party
// and the parties marked as its duplicates are one customer, as on the customers list: an invoice of a duplicate counts for the kept party and the other way round, and a row is answered
// for each asked id.
//
// The honesty rule: an EMPTY answer means "no sales invoice exists for these parties", so the read REFUSES whenever the caller cannot see all of them. Sales invoices are rows of a
// legal entity, so a caller whose entity scope is narrower than the org (a branch-limited accountant) gets a DomainError with the code SIGNAL_PARTIAL_VIEW, never a list of the rows they
// can see; a caller with no user identity gets FORBIDDEN. The composition reads a refusal as "no item".
import { SIGNAL_PARTIAL_VIEW_CODE, zFinanceSalesSignals, zFinanceSalesSignalsInput, type FinanceSalesSignal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const financeSalesSignals = defineQuery({
  name: 'finance.signals.sales',
  input: zFinanceSalesSignalsInput,
  access: ALL,
  handler: async (ctx, input): Promise<FinanceSalesSignal[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    // The whole org or nothing: the scope is the one the sealed context carries, read as the row policies of the books read it.
    const { rows: scope } = await sql<{ whole: boolean }>`SELECT coalesce('*' = ANY (crove_kernel.ctx_le_scope()::text[]), false) AS whole`.execute(ctx.trx);
    if (scope[0]?.whole !== true) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Bạn chỉ xem được một phần sổ sách nên chưa kiểm tra được hóa đơn bán hàng');
    const { rows } = await sql<{ party_id: string; last_sale_on: string; sales: string }>`
      SELECT a.id AS party_id, to_char(max(d.invoice_date), 'YYYY-MM-DD') AS last_sale_on, count(*)::text AS sales
      FROM crove_kernel.party a
      JOIN crove_kernel.party x ON x.org_id = a.org_id AND coalesce(x.duplicate_of, x.id) = coalesce(a.duplicate_of, a.id)
      JOIN crove_finance.purchase_document d ON d.org_id = x.org_id AND d.party_id = x.id
      LEFT JOIN crove_finance.purchase_document_void v ON v.org_id = d.org_id AND v.document_id = d.id
      WHERE a.org_id = ${ctx.orgId}::uuid AND a.id IN (${sql.join(input.partyIds.map((id) => sql`${id}::uuid`))})
        AND d.direction = 'sale' AND d.total > 0 AND v.document_id IS NULL
      GROUP BY a.id
      ORDER BY a.id`.execute(ctx.trx);
    // The answer is held to the contract before it leaves: an id, a real day and a count per party, and nothing else.
    return zFinanceSalesSignals.parse(rows.map((r) => ({ partyId: r.party_id, lastSaleOn: r.last_sale_on, count: Number(r.sales) })));
  },
});
