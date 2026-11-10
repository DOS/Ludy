// SPDX-License-Identifier: AGPL-3.0-only
// The finance read an MCP grant may run (ADR-0051 decision 2, slice 1b of #2975): `ludy_invoices_list`, the recorded purchase and sales invoices, newest first.
//
// The projection below is this tool's privacy review. Per invoice: its number (series and number), its date, the direction (a sale to a customer or a purchase from a
// supplier), the three amounts and the currency, whether it was voided, and the name of the party. Not returned: the party's tax code, address, email or phone (a
// household business's tax code is its owner's own), the lines and what they describe (free text from the supplier's XML or the clerk), the reason a document was
// voided (free text), the file the invoice came from, the journal entry and the exchange-rate details. A party's name is the text a person or an import wrote: it
// reaches the client as data, one plain line, and the tool says so. The legal entity is not chosen here: the row policy of the caller's scope decides which entities'
// invoices are visible, as it does on the documents screen. Money stays a decimal string.
import { z } from 'zod';
import { plainLine, zLocalDate } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_INVOICES_DEFAULT = 25;
export const MCP_INVOICES_MAX = 50;

export const zMcpInvoicesInput = z.strictObject({
  direction: z.enum(['sale', 'purchase']).optional().describe('Only invoices Ludy issued to customers (sale) or received from suppliers (purchase). Leave out for both.'),
  since: zLocalDate.optional().describe('Only invoices dated on or after this day (YYYY-MM-DD).'),
  limit: z.number().int().min(1).max(MCP_INVOICES_MAX).default(MCP_INVOICES_DEFAULT).describe(`How many invoices to return, newest first (1 to ${MCP_INVOICES_MAX}, default ${MCP_INVOICES_DEFAULT}).`),
});

export interface McpInvoiceRow {
  id: string;
  direction: 'sale' | 'purchase';
  series: string;
  number: string;
  issueDate: string;
  partyName: string;
  subtotal: string;
  vatAmount: string;
  total: string;
  currency: string;
  voided: boolean;
}
export interface McpInvoices {
  invoices: McpInvoiceRow[];
  total: number;
  truncated: boolean;
}

export const mcpInvoices = defineQuery({
  name: 'finance.mcp.invoices',
  input: zMcpInvoicesInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpInvoices> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const filtered = () => {
      let query = ctx.trx.selectFrom('crove_finance.purchase_document as d').where('d.org_id', '=', ctx.orgId);
      if (input.direction) query = query.where('d.direction', '=', input.direction);
      if (input.since) query = query.where('d.invoice_date', '>=', input.since);
      return query;
    };
    const rows = await filtered()
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
      .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
      .select(['d.id', 'd.direction', 'd.invoice_series', 'd.invoice_number', 'd.invoice_date', 'd.subtotal', 'd.vat_amount', 'd.total', 'd.currency', 'p.name as party_name', 'v.document_id as voided_id'])
      .orderBy('d.invoice_date', 'desc')
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await filtered().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
    const total = Number(counted?.n ?? 0);
    const invoices = rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      series: plainLine(r.invoice_series, 20),
      number: plainLine(r.invoice_number, 40),
      issueDate: r.invoice_date,
      partyName: plainLine(r.party_name, 300),
      subtotal: r.subtotal,
      vatAmount: r.vat_amount,
      total: r.total,
      currency: plainLine(r.currency, 10),
      voided: r.voided_id !== null,
    }));
    return { invoices, total, truncated: total > invoices.length };
  },
});

export const mcpFinanceQueries = [mcpInvoices];
