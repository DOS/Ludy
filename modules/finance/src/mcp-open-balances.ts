// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.open_balances` (#3849, tool 2): who owes the org money and whom the org owes, per party, as an AI app the owner connected may read it. Privacy review: per party its
// id, its name as the books hold it, the open amount, the amount per age bucket and the count of open invoices, all in the book currency as decimal strings; never an email, phone,
// address, bank account, invoice line, invoice number or any free text. Receivables are the screen's own (loadCustomers: the 131 balance of each customer laid under its sales invoices,
// aged by the customer's or the org's payment terms, so the buckets are DAYS PAST DUE). Payables are the received invoices not voided, with no approved or paid payment and no request waiting for approval (the list
// behind "Ask to pay", so an invoice already asked for is left out), aged by INVOICE DATE because the books hold no due date for a received invoice (#3701): a caller must not read them as days overdue; `basis` says which. Not the
// 331 balance by party. The figures are the whole org's or nothing (wholeOrgEntity). Oldest first, at most MCP_BALANCES_MAX parties.
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { sql } from 'kysely';
import { defineQuery } from '@ludy/kernel-runtime';
import { Decimal, money } from '@ludy/l10n-vn';
import { SUPPLIER_PAYMENT_COMMAND } from '@ludy/kernel-contract';
import { daysBetween } from './domain/payment-reminder.ts';
import { wholeOrgEntity } from './mcp-whole-org.ts';
import { databaseToday } from './period-lock.ts';
import { loadCustomers } from './payment-reminders.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_BALANCES_DEFAULT = 25;
export const MCP_BALANCES_MAX = 50;

export const zMcpOpenBalancesInput = z.strictObject({
  side: z.enum(['receivable', 'payable']).describe('receivable: customers who owe the org (aged by days past due). payable: suppliers the org owes (aged by invoice date, no due date is recorded).'),
  limit: z.number().int().min(1).max(MCP_BALANCES_MAX).default(MCP_BALANCES_DEFAULT).describe(`How many parties to return, the oldest balance first (1 to ${MCP_BALANCES_MAX}, default ${MCP_BALANCES_DEFAULT}).`),
});

export interface McpBalanceBuckets {
  // Receivables: not yet due. Payables: dated today or later.
  notYet: string;
  d1to30: string;
  d31to60: string;
  d61to90: string;
  over90: string;
}
export interface McpBalanceRow {
  partyId: string;
  name: string;
  open: string;
  buckets: McpBalanceBuckets;
  invoiceCount: number;
}
export interface McpOpenBalances {
  side: 'receivable' | 'payable';
  // due_date: the buckets count days past the due date. invoice_date: they count days since the invoice date (no due date is recorded for a received invoice).
  basis: 'due_date' | 'invoice_date';
  asOf: string;
  parties: McpBalanceRow[];
  total: number;
  truncated: boolean;
}

type Amount = ReturnType<typeof money>;
const bucketOf = (days: number): keyof McpBalanceBuckets => (days <= 0 ? 'notYet' : days <= 30 ? 'd1to30' : days <= 60 ? 'd31to60' : days <= 90 ? 'd61to90' : 'over90');
const empty = (): Record<keyof McpBalanceBuckets, Amount> => ({ notYet: new Decimal(0), d1to30: new Decimal(0), d31to60: new Decimal(0), d61to90: new Decimal(0), over90: new Decimal(0) });
const line = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

interface Accum {
  partyId: string;
  name: string;
  buckets: Record<keyof McpBalanceBuckets, Amount>;
  count: number;
  oldest: number;
}
const finish = (a: Accum): McpBalanceRow => ({
  partyId: a.partyId,
  name: a.name,
  open: Object.values(a.buckets).reduce((sum, v) => sum.plus(v), new Decimal(0)).toFixed(),
  buckets: { notYet: a.buckets.notYet.toFixed(), d1to30: a.buckets.d1to30.toFixed(), d31to60: a.buckets.d31to60.toFixed(), d61to90: a.buckets.d61to90.toFixed(), over90: a.buckets.over90.toFixed() },
  invoiceCount: a.count,
});

export const mcpOpenBalances = defineQuery({
  name: 'finance.mcp.open_balances',
  input: zMcpOpenBalancesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpOpenBalances> => {
    const entity = await wholeOrgEntity(ctx);
    const today = await databaseToday(ctx.trx);
    const list: Accum[] = [];
    if (input.side === 'receivable') {
      for (const c of await loadCustomers(ctx, entity, today)) {
        const a: Accum = { partyId: c.partyId, name: line(c.name), buckets: empty(), count: c.receivable.open.length, oldest: Number.NEGATIVE_INFINITY };
        for (const i of c.receivable.open) {
          const key = bucketOf(i.daysOverdue);
          a.buckets[key] = a.buckets[key].plus(i.amountDue);
          a.oldest = Math.max(a.oldest, i.daysOverdue);
        }
        // The part of the 131 balance no invoice covers is open money too, and as old as nothing can say: it is counted as not yet due.
        a.buckets.notYet = a.buckets.notYet.plus(c.receivable.other);
        if (a.count > 0 || c.receivable.other !== '0') list.push(a);
      }
    } else {
      const { rows } = await sql<{ party_id: string; name: string | null; invoice_date: string; total: string }>`
        SELECT coalesce(x.duplicate_of, x.id)::text AS party_id, k.name, d.invoice_date::text AS invoice_date, d.total::text AS total
          FROM crove_finance.purchase_document d
          JOIN crove_kernel.party x ON x.org_id = d.org_id AND x.id = d.party_id
          JOIN crove_kernel.party k ON k.org_id = x.org_id AND k.id = coalesce(x.duplicate_of, x.id)
         WHERE d.org_id = ${ctx.orgId}::uuid AND d.legal_entity_id = ${entity}::uuid AND d.direction = 'purchase' AND d.total > 0
           AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM crove_finance.supplier_payment sp WHERE sp.org_id = d.org_id AND sp.purchase_document_id = d.id AND sp.status IN ('approved', 'paid'))
           AND NOT EXISTS (SELECT 1 FROM crove_kernel.proposal q WHERE q.org_id = d.org_id AND q.command = ${SUPPLIER_PAYMENT_COMMAND} AND q.status = 'pending'
                             AND pg_catalog.lower(q.payload ->> 'purchaseDocumentId') = d.id::text)`.execute(ctx.trx);
      const byParty = new Map<string, Accum>();
      for (const r of rows) {
        const a = byParty.get(r.party_id) ?? { partyId: r.party_id, name: line(r.name ?? ''), buckets: empty(), count: 0, oldest: Number.NEGATIVE_INFINITY };
        const days = daysBetween(r.invoice_date, today);
        const key = bucketOf(days);
        a.buckets[key] = a.buckets[key].plus(money(r.total));
        a.count += 1;
        a.oldest = Math.max(a.oldest, days);
        byParty.set(r.party_id, a);
      }
      list.push(...byParty.values());
    }
    list.sort((p, q) => q.oldest - p.oldest || (p.partyId < q.partyId ? -1 : 1));
    const parties = list.slice(0, input.limit).map(finish);
    return { side: input.side, basis: input.side === 'receivable' ? 'due_date' : 'invoice_date', asOf: today, parties, total: list.length, truncated: list.length > parties.length };
  },
});
