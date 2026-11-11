// SPDX-License-Identifier: AGPL-3.0-only
// The finance read an MCP grant may run (ADR-0051 decision 2, slice 1b of #2975): `ludy_invoices_list`, the recorded purchase and sales invoices, newest first.
//
// The projection below is this tool's privacy review, as the owner decided it (2026-11-11): an AI app the owner connected sees the invoice details the consenting owner
// or admin sees on the documents screen. Per invoice: its number (series and number), its date, the direction (a sale to a customer or a purchase from a supplier), the
// three amounts and the currency, the party's name and tax code, the description of each line (at most MCP_LINES_PER_INVOICE lines, each one plain line of at most 200
// characters, with the line count so a client sees when lines were left out), whether it was voided and the reason it was. Never returned: the party's address, email
// or phone, the lines' amounts, quantities and accounts, the file the invoice came from, the journal entry and the exchange-rate details; bank account numbers, payroll
// or salary data, member-private data; nothing from a query that is `sensitive`. Every text value is one plain line (see plainLine): a party's name, a line's
// description and a void reason are text a person, a supplier's XML or an import wrote, and they reach the client as data, never as an instruction. The legal entity is
// not chosen here: the row policy of the caller's scope decides which entities' invoices are visible, as it does on the documents screen. Money stays a decimal string.
import { z } from 'zod';
import { plainLine, zLocalDate } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_INVOICES_DEFAULT = 25;
export const MCP_INVOICES_MAX = 50;
export const MCP_LINES_PER_INVOICE = 20;

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
  partyTaxCode: string | null;
  subtotal: string;
  vatAmount: string;
  total: string;
  currency: string;
  // The descriptions of the first MCP_LINES_PER_INVOICE lines, in line order; `lineCount` is how many the invoice has.
  lines: Array<{ lineNo: number; description: string }>;
  lineCount: number;
  voided: boolean;
  voidReason: string | null;
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
      .select([
        'd.id',
        'd.direction',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
        'd.subtotal',
        'd.vat_amount',
        'd.total',
        'd.currency',
        'p.name as party_name',
        'p.tax_code as party_tax_code',
        'v.document_id as voided_id',
        'v.reason as void_reason',
      ])
      .orderBy('d.invoice_date', 'desc')
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await filtered().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
    const total = Number(counted?.n ?? 0);
    // The lines of exactly the invoices read above (already inside the caller's legal-entity scope): their descriptions, the first MCP_LINES_PER_INVOICE of each, and how many each has.
    const ids = rows.map((r) => r.id);
    const lines = new Map<string, Array<{ lineNo: number; description: string }>>();
    const lineCounts = new Map<string, number>();
    if (ids.length > 0) {
      const described = await ctx.trx
        .selectFrom('crove_finance.purchase_line as l')
        .select(['l.document_id', 'l.line_no', 'l.description'])
        .where('l.org_id', '=', ctx.orgId)
        .where('l.document_id', 'in', ids)
        .where('l.line_no', '<=', MCP_LINES_PER_INVOICE)
        .orderBy('l.document_id')
        .orderBy('l.line_no')
        .execute();
      for (const l of described) {
        const list = lines.get(l.document_id) ?? [];
        list.push({ lineNo: l.line_no, description: plainLine(l.description, 200) });
        lines.set(l.document_id, list);
      }
      const counts = await ctx.trx
        .selectFrom('crove_finance.purchase_line as l')
        .select(['l.document_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('l.org_id', '=', ctx.orgId)
        .where('l.document_id', 'in', ids)
        .groupBy('l.document_id')
        .execute();
      for (const c of counts) lineCounts.set(c.document_id, Number(c.n));
    }
    const invoices = rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      series: plainLine(r.invoice_series, 20),
      number: plainLine(r.invoice_number, 40),
      issueDate: r.invoice_date,
      partyName: plainLine(r.party_name, 300),
      partyTaxCode: r.party_tax_code === null || plainLine(r.party_tax_code, 30) === '' ? null : plainLine(r.party_tax_code, 30),
      subtotal: r.subtotal,
      vatAmount: r.vat_amount,
      total: r.total,
      currency: plainLine(r.currency, 10),
      lines: lines.get(r.id) ?? [],
      lineCount: lineCounts.get(r.id) ?? 0,
      voided: r.voided_id !== null,
      voidReason: r.voided_id !== null && r.void_reason !== null && plainLine(r.void_reason, 500) !== '' ? plainLine(r.void_reason, 500) : null,
    }));
    return { invoices, total, truncated: total > invoices.length };
  },
});

export const mcpFinanceQueries = [mcpInvoices];
