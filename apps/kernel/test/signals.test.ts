// SPDX-License-Identifier: AGPL-3.0-only
// The first cross-app rule (Vy plan C4, slice V4, issue #2967), unit part: a deal won with no sales invoice after 7 days. The lines' own reads
// (`crm.signals.won_deals`, `finance.signals.sales`) are stubs here; that each scopes to the member is that line's own test. This file checks the join,
// the day rule and its near misses, the fail-closed paths, and that nothing but ids, dates and amounts crosses.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CRM_WON_DEALS_SIGNALS_READ, FINANCE_SALES_SIGNALS_READ, WON_DEAL_NO_INVOICE_DAYS, zCrmWonDealSignal, zFinanceSalesSignal, zTodayItems } from '@crove/kernel-contract';
import { DomainError, type Lookup, type QueryContext } from '@crove/kernel-runtime';
import { DEAL_WITHOUT_INVOICE_READ, SIGNAL_ITEMS_MAX, dealWithoutInvoiceQuery } from '@crove/kernel';

const NOW = new Date('2026-11-20T03:00:00Z'); // 10:00 in Vietnam, 2026-11-20
const party = randomUUID();
const other = randomUUID();
const deal = (over: Record<string, unknown> = {}) => ({ dealId: randomUUID(), partyId: party, wonOn: '2026-11-12', amount: '1500000', ...over });
const sale = (over: Record<string, unknown> = {}) => ({ partyId: party, lastSaleOn: '2026-11-01', count: 2, ...over });

type Reads = Record<string, unknown | (() => never)>;

// A context whose query() answers from `reads`: a function throws, a missing name is QUERY_NOT_FOUND, an `absent` module is not_installed.
function contextOf(reads: Reads, absent: readonly string[] = [], asked: string[] = []): QueryContext {
  return {
    query: async (name: string): Promise<Lookup<unknown>> => {
      asked.push(name);
      const module = name.split('.')[0] as string;
      if (absent.includes(module)) return { status: 'not_installed', module };
      if (!(name in reads)) throw new DomainError('QUERY_NOT_FOUND', 404, `no query ${name}`);
      const answer = reads[name];
      if (typeof answer === 'function') (answer as () => never)();
      return { status: 'ok', value: answer };
    },
  } as unknown as QueryContext;
}

const run = (reads: Reads, options: { absent?: readonly string[]; asked?: string[] } = {}) =>
  dealWithoutInvoiceQuery({ now: () => NOW }).handler(contextOf(reads, options.absent, options.asked), {});

describe('the won deal with no sales invoice rule (Vy C4)', () => {
  it('is a registered kernel read with the constant of the plan: 7 days, a constant and not a setting', () => {
    expect(dealWithoutInvoiceQuery().name).toBe(DEAL_WITHOUT_INVOICE_READ);
    expect(WON_DEAL_NO_INVOICE_DAYS).toBe(7);
  });

  it('flags a deal won 8 days ago whose party has no sales invoice, with days, amount and a link only', async () => {
    const d = deal();
    const items = await run({ [CRM_WON_DEALS_SIGNALS_READ]: [d], [FINANCE_SALES_SIGNALS_READ]: [] });
    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'crm',
        id: `signal:won-deal-no-invoice:${d.dealId}`,
        title: { key: 'signals.wonDealNoInvoice', params: { days: 8 } },
        amount: '1500000',
        currency: 'VND',
        severity: 'warn',
        href: '/deals',
      },
    ]);
    // The item is a valid Home item.
    expect(zTodayItems.safeParse(items).success).toBe(true);
  });

  it('fires from the seventh day on, and not before (the near miss: won 6 days ago)', async () => {
    const on = (wonOn: string) => run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal({ wonOn })], [FINANCE_SALES_SIGNALS_READ]: [] });
    expect(await on('2026-11-13')).toHaveLength(1); // 7 days
    expect(await on('2026-11-14')).toHaveLength(0); // 6 days
    expect(await on('2026-11-20')).toHaveLength(0); // today
    expect(await on('2026-11-25')).toHaveLength(0); // a date in the future never fires
  });

  it('stays quiet when the party has a sales invoice dated on or after the win, and fires when the only invoice is older or of another party', async () => {
    const reads = (invoice: unknown[]) => ({ [CRM_WON_DEALS_SIGNALS_READ]: [deal()], [FINANCE_SALES_SIGNALS_READ]: invoice });
    expect(await run(reads([sale({ lastSaleOn: '2026-11-12' })]))).toHaveLength(0); // the day of the win
    expect(await run(reads([sale({ lastSaleOn: '2026-11-18' })]))).toHaveLength(0); // after it
    expect(await run(reads([sale({ lastSaleOn: '2026-11-11' })]))).toHaveLength(1); // an earlier sale is another sale
    expect(await run(reads([sale({ partyId: other, lastSaleOn: '2026-11-18' })]))).toHaveLength(1); // another party's invoice
  });

  it('gives no item when the member cannot read finance, however the line says no', async () => {
    const crm = { [CRM_WON_DEALS_SIGNALS_READ]: [deal()] };
    // Not registered yet, module off, a refusal for the role, a not-ok answer.
    expect(await run(crm)).toEqual([]);
    expect(await run(crm, { absent: ['finance'] })).toEqual([]);
    expect(await run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: () => { throw new DomainError('FORBIDDEN', 403, 'no'); } })).toEqual([]);
    // An answer that is not the contract (an array of text) is not "no invoices".
    expect(await run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: 'x' })).toEqual([]);
  });

  it('gives no item for a deal the member cannot open (the CRM read does not list it), and asks finance nothing then', async () => {
    const asked: string[] = [];
    expect(await run({ [CRM_WON_DEALS_SIGNALS_READ]: [], [FINANCE_SALES_SIGNALS_READ]: [] }, { asked })).toEqual([]);
    expect(asked).toEqual([CRM_WON_DEALS_SIGNALS_READ]);
    expect(await run({ [FINANCE_SALES_SIGNALS_READ]: [] })).toEqual([]);
    expect(await run({}, { absent: ['crm'] })).toEqual([]);
  });

  it('lets no text cross: a signal with a field outside the contract voids the whole read, never a partial result', async () => {
    const finance = { [FINANCE_SALES_SIGNALS_READ]: [] };
    expect(await run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal({ title: 'Hợp đồng anh Nam' })], ...finance })).toEqual([]);
    expect(await run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal()], [FINANCE_SALES_SIGNALS_READ]: [sale({ partyName: 'Công ty A' })] })).toEqual([]);
    // The contract's own shapes are strict and carry ids, dates and amounts only.
    expect(Object.keys(zCrmWonDealSignal.shape).sort()).toEqual(['amount', 'dealId', 'partyId', 'wonOn']);
    expect(Object.keys(zFinanceSalesSignal.shape).sort()).toEqual(['count', 'lastSaleOn', 'partyId']);
    // And what the rule returns has no free text: every string in an item is a key, an id, an enum, a path or a number.
    const out = JSON.stringify(await run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal()], ...finance }));
    expect(out).not.toMatch(/Nam|Công ty|Hợp đồng/);
  });

  it('lists the most overdue first, at most 20, with the rest as one grouped item', async () => {
    const deals = Array.from({ length: 23 }, (_, i) => deal({ wonOn: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}`, partyId: randomUUID() }));
    const items = await run({ [CRM_WON_DEALS_SIGNALS_READ]: deals, [FINANCE_SALES_SIGNALS_READ]: [] });
    expect(items).toHaveLength(SIGNAL_ITEMS_MAX + 1);
    const last = items[SIGNAL_ITEMS_MAX];
    expect(last).toMatchObject({ id: 'signal:won-deal-no-invoice:more', count: 3, title: { key: 'signals.wonDealNoInvoiceMore', params: { count: 3 } } });
    const days = items.slice(0, SIGNAL_ITEMS_MAX).map((i) => (i.title.params as { days: number }).days);
    expect(days).toEqual([...days].sort((a, b) => b - a));
  });

  it('lets a database error through, since the transaction may be unusable', async () => {
    const crm = { [CRM_WON_DEALS_SIGNALS_READ]: [deal()] };
    await expect(run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
  });
});
