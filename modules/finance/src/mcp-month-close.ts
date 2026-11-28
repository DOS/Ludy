// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.month_close` (#5346): the month-close checklist of the Kế toán screen for one calendar month, as an AI app the owner connected may read it. It is the screen's own read
// (financeMonthClose), cut down. Privacy review: per item its fixed key, how many things are open (0 means done) and, for the two items that read a VAT period, that period; counts only, never an
// amount, a name, an id or any free text, and not the legal entity id or the screen's link hint. `month` is required (no default), so a client never guesses which month it asks about. The figures
// are the whole org's or nothing (wholeOrgEntity). Read only, no model call (the coworker's note on the screen is not part of this).
import type { MemberRole } from '@ludy/db';
import { zCloseMonth, type MonthCloseItem } from '@ludy/kernel-contract';
import { z } from 'zod';
import { defineQuery } from '@ludy/kernel-runtime';
import { financeMonthClose } from './month-close.ts';
import { wholeOrgEntity } from './mcp-whole-org.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

export const zMcpMonthCloseInput = z.strictObject({
  month: zCloseMonth.describe('The calendar month to check, "YYYY-MM" (for example "2026-10"), from 2000-01 to 2100-12. Required: say which month you mean.'),
});

export interface McpMonthClose {
  month: string;
  // The items that apply to this month, in the screen's fixed order: the tax-portal check only when a list was imported, the stock close only when there are stock moves and the month is over, the VAT mark only for the last month of the filing period.
  items: Array<Pick<MonthCloseItem, 'key' | 'count' | 'period'>>;
}

export const mcpMonthClose = defineQuery({
  name: 'finance.mcp.month_close',
  input: zMcpMonthCloseInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpMonthClose> => {
    const entity = await wholeOrgEntity(ctx);
    const close = await financeMonthClose(ctx, { month: input.month, legalEntityId: entity });
    return { month: close.month, items: close.items.map((i) => ({ key: i.key, count: i.count, period: i.period })) };
  },
});
