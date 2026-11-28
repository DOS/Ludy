// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.cash_forecast` (#5346): the 90-day cash forecast of the Kế toán screen, as an AI app the owner connected may read it. It is the screen's own read (financeCashForecast), cut down.
// Privacy review: dates and money (decimal strings, book currency), and a few fixed words (the kind of a top item, what the forecast leaves out, a tax obligation and its period); never a party name,
// an invoice or document id, the legal entity id, the 91-day series, the coworker's note (a model text, the client writes its own), and NEVER the label or the category of an item the owner entered
// (the owner's own words, often a person's name): only how many such items there are (`enteredItems.count`) and, through the figures and `notIncluded`, what they do to the forecast. The day 0 is the
// database's today: no input, so the as-of bound of the screen is not reachable from outside. The figures are the whole org's or nothing (wholeOrgEntity). Read only, no model call.
import type { MemberRole } from '@ludy/db';
import type { CashForecast, CashForecastCheckpoint, CashForecastDay, CashForecastItem, CashForecastNotIncluded, CashForecastTaxMarker } from '@ludy/kernel-contract';
import { z } from 'zod';
import { defineQuery } from '@ludy/kernel-runtime';
import { financeCashForecast } from './cash-forecast.ts';
import { wholeOrgEntity } from './mcp-whole-org.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];

// No input: day 0 is the database's today and the entity is the org's only one.
export const zMcpCashForecastInput = z.strictObject({});

export interface McpCashForecast {
  asOf: string;
  openingCash: string;
  // The lowest balance of the 90 days and its day (the earliest on a tie).
  low: CashForecastDay;
  // The balance at the end of day 30, 60 and 90 and what came in and went out up to it.
  checkpoints: CashForecastCheckpoint[];
  // The largest items on or before the low day, largest first: kind, date and amount only (no names).
  topItems: Array<Pick<CashForecastItem, 'kind' | 'date' | 'amount' | 'estimated'>>;
  // Sales invoices already past due and the part of 131 no invoice covers: neither is in the figures.
  overdueReceiptsNotCounted: string;
  unlinkedReceivablesNotCounted: string;
  // True when a counted payable fell back to invoice date + 30 days.
  estimatedPayables: boolean;
  // What the forecast still leaves out: the money these would move is not in the figures.
  notIncluded: CashForecastNotIncluded[];
  // Tax due dates of the next 30 days, with no amount.
  taxMarkers: CashForecastTaxMarker[];
  // How many items the owner entered (their labels and categories never leave); their effect is in the figures.
  enteredItems: { count: number };
  // True when the entity has more customers, suppliers, invoices or payments than one forecast reads: the figures are then partial.
  truncated: boolean;
}

// The projection, field by field: a field the forecast gains later is NOT returned until it is added here and in the invariant that pins this list.
export function projectCashForecast(forecast: CashForecast, enteredCount: number): McpCashForecast {
  return {
    asOf: forecast.asOf,
    openingCash: forecast.openingCash,
    low: { date: forecast.low.date, balance: forecast.low.balance },
    checkpoints: forecast.checkpoints.map((c) => ({ days: c.days, date: c.date, balance: c.balance, receipts: c.receipts, payments: c.payments })),
    topItems: forecast.topItems.map((i) => (i.estimated === undefined ? { kind: i.kind, date: i.date, amount: i.amount } : { kind: i.kind, date: i.date, amount: i.amount, estimated: i.estimated })),
    overdueReceiptsNotCounted: forecast.overdueReceiptsNotCounted,
    unlinkedReceivablesNotCounted: forecast.unlinkedReceivablesNotCounted,
    estimatedPayables: forecast.estimatedPayables === true,
    notIncluded: [...forecast.notIncluded],
    taxMarkers: forecast.taxMarkers.map((m) => ({ obligation: m.obligation, period: m.period, dueDate: m.dueDate })),
    enteredItems: { count: enteredCount },
    truncated: forecast.truncated,
  };
}

export const mcpCashForecast = defineQuery({
  name: 'finance.mcp.cash_forecast',
  input: zMcpCashForecastInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<McpCashForecast> => {
    const entity = await wholeOrgEntity(ctx);
    const forecast = await financeCashForecast(ctx, { legalEntityId: entity });
    // Only the number of entered items, by the entity index (the table is capped); the rows themselves are never read here.
    const counted = await ctx.trx
      .selectFrom('ludy_finance.cash_forecast_item')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entity)
      .executeTakeFirst();
    return projectCashForecast(forecast, Number(counted?.n ?? 0));
  },
});
