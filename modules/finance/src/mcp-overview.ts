// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.overview` (#3849, tool 1): the Tổng quan figures an AI app the owner connected may read, the same cash, profit, receivables and payables the
// overview screen shows, plus the ledger's output VAT not yet offset (outputVatUnsettled, not the VAT return's net tax), for one period against the one before. Privacy review: money figures and dates only, no names, no text anyone typed, no account lines.
// The legal entity is not chosen by the caller; the answer exists only when the grant sees the whole org (a partial view is refused with SIGNAL_PARTIAL_VIEW,
// as the signals are), because a total of part of the books would read as the total of all. The screen's figures are those of ONE legal entity, so an org with more than
// one entity is refused the same way: one entity's cash must never read as the org's. Read only; money stays a decimal string in VND.
import type { MemberRole } from '@ludy/db';
import { zOverviewRange, type FinanceOverview, type OverviewFigure } from '@ludy/kernel-contract';
import { sql } from 'kysely';
import { z } from 'zod';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { money } from '@ludy/l10n-vn';
import { overviewFigure } from './domain/overview.ts';
import { wholeOrgEntity } from './mcp-whole-org.ts';
import { financeOverview } from './overview.ts';
import { balances } from './statements.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

export const zMcpOverviewInput = z.strictObject({
  range: zOverviewRange.default('last_30_days').describe('The period: last_30_days (default), this_month, last_month, this_quarter or this_year (calendar year).'),
});

export interface McpOverview {
  range: FinanceOverview['range'];
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  empty: boolean;
  cash: OverviewFigure;
  profit: OverviewFigure;
  receivables: OverviewFigure;
  payables: OverviewFigure;
  // The output VAT not yet offset or settled (#3912): the credit balance of account 3331 at the period's last day against the earlier period's, the ledger's own figure (a debit balance
  // reads negative). It is NOT the net tax of the VAT return: input VAT (1331) is offset only when a settlement is posted, and the return's deductions are the accountant's.
  outputVatUnsettled: OverviewFigure;
  // The profit may be incomplete when this is above 0 (balances no statement line reads).
  unmapped: number;
}

// The net credit balance of account 3331 (output VAT) up to `to` and up to `previousTo`, read in ONE statement so both see the same entries. The overview screen
// has no VAT card and the VAT screen counts invoices, not the ledger, so this is the ledger's own balance (the closing entries are kept: a settlement moves it). Not the return's net tax.
async function outputVatUnsettled(ctx: QueryContext, entity: string, to: string, previousTo: string): Promise<OverviewFigure> {
  const at = (date: string, part: string) =>
    balances(ctx, entity, null, date, false)
      .where('l.account_code', 'like', '3331%')
      .select(sql.lit(part).as('part'));
  const rows = await at(to, 'now').unionAll(at(previousTo, 'before')).execute();
  const net = (part: string) => rows.filter((r) => r.part === part).reduce((sum, r) => sum.plus(money(r.credit ?? '0')).minus(money(r.debit ?? '0')), money(0));
  return overviewFigure(net('now').toFixed(), net('before').toFixed());
}

export const mcpOverview = defineQuery({
  name: 'finance.mcp.overview',
  input: zMcpOverviewInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpOverview> => {
    const entity = await wholeOrgEntity(ctx);
    const o = await financeOverview(ctx, { range: input.range, legalEntityId: entity });
    const vat = await outputVatUnsettled(ctx, entity, o.to, o.previousTo);
    // Projected: the monthly series and the expense mix stay on the screen.
    return { range: o.range, from: o.from, to: o.to, previousFrom: o.previousFrom, previousTo: o.previousTo, empty: o.empty, cash: o.cash, profit: o.profit, receivables: o.receivables, payables: o.payables, outputVatUnsettled: vat, unmapped: o.unmapped };
  },
});
