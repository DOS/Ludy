// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.overview` (#3849, tool 1): the Tổng quan figures an AI app the owner connected may read, the same cash, profit, receivables and payables the
// overview screen shows, for one period against the one before. Privacy review: money figures and dates only, no names, no text anyone typed, no account lines.
// The legal entity is not chosen by the caller; the answer exists only when the grant sees the whole org (a partial view is refused with SIGNAL_PARTIAL_VIEW,
// as the signals are), because a total of part of the books would read as the total of all. The screen's figures are those of ONE legal entity, so an org with more than
// one entity is refused the same way: one entity's cash must never read as the org's. Read only; money stays a decimal string in VND.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { SIGNAL_PARTIAL_VIEW_CODE, zOverviewRange, type FinanceOverview, type OverviewFigure } from '@crove/kernel-contract';
import { z } from 'zod';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { financeOverview } from './overview.ts';

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
  // The profit may be incomplete when this is above 0 (balances no statement line reads).
  unmapped: number;
}

export const mcpOverview = defineQuery({
  name: 'finance.mcp.overview',
  input: zMcpOverviewInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpOverview> => {
    if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
    const { rows: scope } = await sql<{ whole: boolean }>`SELECT coalesce('*' = ANY (crove_kernel.ctx_le_scope()::text[]), false) AS whole`.execute(ctx.trx);
    if (scope[0]?.whole !== true) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Bạn chỉ xem được một phần sổ sách nên chưa đọc được tổng quan tài chính');
    // One entity's books are the whole org's only when the org has no other: a second entity (a branch) makes the figures a part, so nothing is answered.
    const { rows: entities } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM crove_kernel.legal_entity WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
    if (Number(entities[0]?.n ?? 0) > 1) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Tổ chức có nhiều pháp nhân nên tổng quan của một pháp nhân không phải của cả tổ chức');
    const o = await financeOverview(ctx, { range: input.range });
    // Projected: the monthly series and the expense mix stay on the screen.
    return { range: o.range, from: o.from, to: o.to, previousFrom: o.previousFrom, previousTo: o.previousTo, empty: o.empty, cash: o.cash, profit: o.profit, receivables: o.receivables, payables: o.payables, unmapped: o.unmapped };
  },
});
