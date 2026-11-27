// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic invoice and receivable summary per customer contact for pre-meeting briefs (#4991 PM1):
// returns counts, ISO dates, and canonical decimal-string overdue amounts under the caller's own RLS and legal-entity scope.
// No free text, no customer contact fields, no model call, and no writes.
import { sql } from 'kysely';
import {
  SIGNAL_PARTIAL_VIEW_CODE,
  zPartyInvoiceSummaryInput,
  zPartyInvoiceSummaryOutput,
  type PartyInvoiceSummary,
  type PartyInvoiceSummaryOutput,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery } from '@ludy/kernel-runtime';
import { Decimal, RECEIVABLE_ACCOUNT, money } from '@ludy/l10n-vn';
import { canonical } from './domain/money.ts';
import { loadCustomers } from './payment-reminders.ts';
import { databaseToday } from './period-lock.ts';
import { latestRevision } from './source-entry.ts';

const STAFF: readonly MemberRole[] = ['owner', 'admin', 'member'];

interface AggregateRow {
  openCount: number;
  overdueAmount: InstanceType<typeof Decimal>;
  lastInvoiceDate: string | null;
  lastPaidDate: string | null;
}

export const partyInvoiceSummaryQuery = defineQuery({
  name: 'finance.party.invoice_summary',
  input: zPartyInvoiceSummaryInput,
  access: STAFF,
  handler: async (ctx, input): Promise<PartyInvoiceSummaryOutput> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đọc được tóm tắt hóa đơn');
    }
    const { rows: scope } = await sql<{ whole: boolean }>`SELECT coalesce('*' = ANY (ludy_kernel.ctx_le_scope()::text[]), false) AS whole`.execute(ctx.trx);
    if (scope[0]?.whole !== true) {
      throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Bạn chỉ xem được một phần sổ sách nên chưa đọc được tóm tắt hóa đơn');
    }
    const uniqueAsked = [...new Set(input.partyIds)];
    if (uniqueAsked.length === 0) return { items: [] };

    const { rows: askedRows } = await sql<{ id: string; kept: string }>`
      SELECT a.id, COALESCE(a.duplicate_of, a.id) AS kept
      FROM ludy_kernel.party a
      WHERE a.org_id = ${ctx.orgId}::uuid
        AND a.id = ANY(${uniqueAsked}::uuid[])
    `.execute(ctx.trx);
    if (askedRows.length === 0) return { items: [] };

    const keptIds = [...new Set(askedRows.map((r) => r.kept))];
    const byKept = new Map<string, AggregateRow>();
    for (const id of keptIds) {
      byKept.set(id, {
        openCount: 0,
        overdueAmount: new Decimal(0),
        lastInvoiceDate: null,
        lastPaidDate: null,
      });
    }

    const today = await databaseToday(ctx.trx);
    const entities = await ctx.trx
      .selectFrom('ludy_kernel.legal_entity')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .orderBy('id')
      .execute();

    for (const entity of entities) {
      for (const customer of await loadCustomers(ctx, entity.id, today, keptIds)) {
        const entry = byKept.get(customer.partyId);
        if (!entry) continue;
        entry.openCount += customer.receivable.open.length;
        for (const inv of customer.overdue) {
          entry.overdueAmount = entry.overdueAmount.plus(money(inv.amountDue));
        }
      }
    }

    const keptExpr = sql<string>`COALESCE(x.duplicate_of, x.id)`;
    const salesDates = await ctx.trx
      .selectFrom('ludy_finance.purchase_document as d')
      .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
      .leftJoin('ludy_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
      .select(keptExpr.as('kept'))
      .select((eb) => eb.fn.max('d.invoice_date').as('last_invoice_date'))
      .where('d.org_id', '=', ctx.orgId)
      .where('d.direction', '=', 'sale')
      .where('v.document_id', 'is', null)
      .where(sql<boolean>`COALESCE(x.duplicate_of, x.id) = ANY(${sql.val(keptIds)}::uuid[])`)
      .groupBy(keptExpr)
      .execute();

    for (const row of salesDates) {
      const entry = byKept.get(row.kept);
      if (entry && row.last_invoice_date) {
        entry.lastInvoiceDate = row.last_invoice_date;
      }
    }

    const paidDates = await ctx.trx
      .selectFrom('ludy_finance.journal_line as l')
      .innerJoin('ludy_finance.journal_entry as je', (join) => join.onRef('je.org_id', '=', 'l.org_id').onRef('je.id', '=', 'l.entry_id'))
      .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
      .select(keptExpr.as('kept'))
      .select((eb) => eb.fn.max('je.entry_date').as('last_paid_date'))
      .where('l.org_id', '=', ctx.orgId)
      .where('l.account_code', 'like', `${RECEIVABLE_ACCOUNT}%`)
      .where('l.credit', '>', '0')
      .where('je.reverses_entry_id', 'is', null)
      .where('je.source_type', 'not in', ['finance.purchase_document', 'finance.opening_balance'])
      .where(latestRevision('je'))
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM ludy_finance.journal_entry rev WHERE rev.org_id = je.org_id AND rev.reverses_entry_id = je.id)`,
      )
      .where(sql<boolean>`COALESCE(x.duplicate_of, x.id) = ANY(${sql.val(keptIds)}::uuid[])`)
      .groupBy(keptExpr)
      .execute();

    for (const row of paidDates) {
      const entry = byKept.get(row.kept);
      if (entry && row.last_paid_date) {
        entry.lastPaidDate = row.last_paid_date;
      }
    }

    const items: PartyInvoiceSummary[] = askedRows.map((a) => {
      const agg = byKept.get(a.kept);
      return {
        partyId: a.id,
        openCount: agg?.openCount ?? 0,
        overdueAmount: canonical(agg?.overdueAmount ?? new Decimal(0)),
        lastInvoiceDate: agg?.lastInvoiceDate ?? null,
        lastPaidDate: agg?.lastPaidDate ?? null,
      };
    });

    return zPartyInvoiceSummaryOutput.parse({ items });
  },
});
