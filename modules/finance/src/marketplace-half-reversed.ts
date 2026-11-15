// SPDX-License-Identifier: AGPL-3.0-only
// The settlements that are half reversed (#3329, option C of the Accounting PO; plan docs/plan/stock-and-marketplaces.md section 8.4): a settlement posts as one voucher per month of delivery and each
// voucher is reversed on its own, so a settlement can have some vouchers reversed and some still standing. The payout of such a settlement is refused until the rest is reversed too (settlementPosted),
// and the Sàn screen lists it with the count of months still standing ("đảo dở: còn N tháng chưa đảo") so the accountant finishes it. A settlement with every voucher reversed, or none, is not half
// reversed. Facts only, read from the books; the row policies keep it to the entities the caller may see.
import { sql } from 'kysely';
import type { QueryContext } from '@crove/kernel-runtime';
import { postingsOf } from './marketplace-settlement-months.ts';

export interface HalfReversedSettlement {
  id: string;
  legalEntityId: string;
  platform: string;
  periodFrom: string;
  periodTo: string;
  // Month vouchers still standing and month vouchers reversed.
  standing: number;
  reversed: number;
}

const MAX_HALF_REVERSED = 50;

export async function halfReversedSettlements(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string | undefined): Promise<HalfReversedSettlement[]> {
  const entity = legalEntityId === undefined ? sql`TRUE` : sql`s.legal_entity_id = ${legalEntityId}::uuid`;
  // Settlements with at least one reversed voucher (an original entry with a reversal), the few the full read below looks at.
  const candidates = (
    await sql<{ id: string; legal_entity_id: string; platform: string; period_start: string; period_end: string }>`
      SELECT s.id, s.legal_entity_id, s.platform, s.period_start::text, s.period_end::text
      FROM crove_finance.channel_settlement s
      WHERE s.org_id = ${ctx.orgId}::uuid AND ${entity} AND s.reversal_of IS NULL
        AND EXISTS (
          SELECT 1 FROM crove_finance.journal_voucher v
          JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL
          JOIN crove_finance.journal_entry r ON r.org_id = e.org_id AND r.reverses_entry_id = e.id
          WHERE v.org_id = s.org_id AND v.settlement_id = s.id)
      ORDER BY s.period_end DESC, s.id LIMIT ${MAX_HALF_REVERSED * 4}`.execute(ctx.trx)
  ).rows;
  const postings = await postingsOf(ctx, candidates.map((c) => c.id));
  const out: HalfReversedSettlement[] = [];
  for (const c of candidates) {
    const p = postings.get(c.id) ?? [];
    const standing = p.filter((x) => !x.reversed).length;
    const reversed = p.length - standing;
    if (standing === 0 || reversed === 0) continue;
    out.push({ id: c.id, legalEntityId: c.legal_entity_id, platform: c.platform, periodFrom: c.period_start, periodTo: c.period_end, standing, reversed });
    if (out.length >= MAX_HALF_REVERSED) break;
  }
  return out;
}
