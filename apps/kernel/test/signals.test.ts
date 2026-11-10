// SPDX-License-Identifier: AGPL-3.0-only
// The first cross-app rule (Vy plan C4, slice V4, issue #2967), unit part: a deal won with no sales invoice after 7 days. The lines' own reads
// (`crm.signals.won_deals`, `finance.signals.sales`) are stubs here; that each scopes to the member is that line's own test. This file checks the join,
// the day rule and its near misses, the fail-closed paths, and that nothing but ids, dates and amounts crosses.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CRM_OPEN_DEALS_SIGNALS_READ,
  CRM_WON_DEALS_SIGNALS_READ,
  FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ,
  FINANCE_SALES_SIGNALS_READ,
  FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ,
  FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ,
  OVERDUE_RECEIVABLE_MIN_DAYS,
  SUPPLIER_BANK_CHANGE_DAYS,
  WON_DEAL_NO_INVOICE_DAYS, sortTodayItems, zCrmWonDealSignal, zCrmWonDealSignals, zFinanceSalesSignal, zTodayItems } from '@crove/kernel-contract';
import { DomainError, type Lookup, type QueryContext } from '@crove/kernel-runtime';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SIGNAL_ITEMS_MAX, SUPPLIER_BANK_CHANGED_READ, dealWithoutInvoiceQuery, receivableWithOpenDealQuery, supplierBankChangedQuery } from '@crove/kernel';

// 00:30 on 2026-11-20 in Vietnam, still 2026-11-19 in UTC: the days are counted on the Vietnam calendar.
const NOW = new Date('2026-11-19T17:30:00Z');
const party = randomUUID();
const other = randomUUID();
const deal = (over: Record<string, unknown> = {}) => ({ dealId: randomUUID(), partyId: party, wonOn: '2026-11-12', amount: '1500000', ...over });
const sale = (over: Record<string, unknown> = {}) => ({ partyId: party, lastSaleOn: '2026-11-01', count: 2, ...over });

type Reads = Record<string, unknown | (() => never)>;

// A context whose query() answers from `reads`: a function throws, a missing name is QUERY_NOT_FOUND, an `absent` module is not_installed.
function contextOf(reads: Reads, absent: readonly string[] = [], asked: string[] = [], inputs: Record<string, unknown> = {}): QueryContext {
  return {
    query: async (name: string, input?: unknown): Promise<Lookup<unknown>> => {
      asked.push(name);
      inputs[name] = input;
      const module = name.split('.')[0] as string;
      if (absent.includes(module)) return { status: 'not_installed', module };
      if (!(name in reads)) throw new DomainError('QUERY_NOT_FOUND', 404, `no query ${name}`);
      const answer = reads[name];
      if (typeof answer === 'function') (answer as () => never)();
      return { status: 'ok', value: answer };
    },
  } as unknown as QueryContext;
}

const run = (reads: Reads, options: { absent?: readonly string[]; asked?: string[]; inputs?: Record<string, unknown> } = {}) =>
  dealWithoutInvoiceQuery({ now: () => NOW }).handler(contextOf(reads, options.absent, options.asked, options.inputs), {});

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
        dueAt: '2026-11-19T00:00:00+07:00',
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

  it('reads an empty finance answer as "no invoice exists" and a refusal as "cannot see": the contract makes finance refuse when the member cannot see every invoice of the parties (no finance role, or a legal-entity scope narrower than the org)', async () => {
    const crm = { [CRM_WON_DEALS_SIGNALS_READ]: [deal()] };
    // A member who sees all the invoices and finds none: the flag.
    expect(await run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: [] })).toHaveLength(1);
    // A stub finance read that refuses a member with a narrower scope, with each refusal a line can give: no flag, never a false "no invoice".
    for (const code of ['FORBIDDEN', 'ENTITY_SCOPE_NARROWER', 'NOT_A_MEMBER']) {
      const refusing = () => {
        throw new DomainError(code, 403, 'refused');
      };
      expect(await run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: refusing }), code).toEqual([]);
    }
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

  it('asks finance only about the parties of the won deals, by id, once each, so a row cap on its side cannot hide an invoiced customer', async () => {
    const inputs: Record<string, unknown> = {};
    const a = deal();
    const b = deal({ partyId: other });
    const c = deal({ partyId: other });
    await run({ [CRM_WON_DEALS_SIGNALS_READ]: [a, b, c], [FINANCE_SALES_SIGNALS_READ]: [] }, { inputs });
    expect(inputs[FINANCE_SALES_SIGNALS_READ]).toEqual({ partyIds: [party, other] });
  });

  it('keeps the latest invoice date of a party that comes in several rows, whatever their order', async () => {
    const reads = (rows: unknown[]) => ({ [CRM_WON_DEALS_SIGNALS_READ]: [deal()], [FINANCE_SALES_SIGNALS_READ]: rows });
    expect(await run(reads([sale({ lastSaleOn: '2026-11-18' }), sale({ lastSaleOn: '2026-11-01' })]))).toHaveLength(0);
    expect(await run(reads([sale({ lastSaleOn: '2026-11-01' }), sale({ lastSaleOn: '2026-11-18' })]))).toHaveLength(0);
  });

  it('counts the days on the Vietnam calendar (half past midnight there is still the day before in UTC)', async () => {
    // NOW is 2026-11-19 17:30Z, which is 2026-11-20 in Vietnam: won on 11-13 is 7 days, won on 11-14 is 6.
    const on = (wonOn: string) => run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal({ wonOn })], [FINANCE_SALES_SIGNALS_READ]: [] });
    expect(await on('2026-11-13')).toHaveLength(1);
    expect(await on('2026-11-14')).toHaveLength(0);
  });

  it('refuses a date that is not on the calendar and a negative amount, which void the read', async () => {
    expect(zCrmWonDealSignals.safeParse([deal({ wonOn: '2026-02-30' })]).success).toBe(false);
    expect(zCrmWonDealSignals.safeParse([deal({ amount: '-5' })]).success).toBe(false);
    expect(zCrmWonDealSignals.safeParse([deal()]).success).toBe(true);
    expect(await run({ [CRM_WON_DEALS_SIGNALS_READ]: [deal({ wonOn: '2026-02-30' })], [FINANCE_SALES_SIGNALS_READ]: [] })).toEqual([]);
  });

  it('keeps the most overdue deal first on Home, with the grouped item last', async () => {
    const deals = Array.from({ length: 23 }, (_, i) => deal({ wonOn: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}`, partyId: randomUUID() }));
    const items = await run({ [CRM_WON_DEALS_SIGNALS_READ]: deals, [FINANCE_SALES_SIGNALS_READ]: [] });
    const home = sortTodayItems(items);
    expect(home.at(-1)?.id).toBe('signal:won-deal-no-invoice:more');
    const days = home.slice(0, SIGNAL_ITEMS_MAX).map((i) => (i.title.params as { days: number }).days);
    expect(days).toEqual([...days].sort((x, y) => y - x));
  });

  it('lets a database error through, since the transaction may be unusable', async () => {
    const crm = { [CRM_WON_DEALS_SIGNALS_READ]: [deal()] };
    await expect(run({ ...crm, [FINANCE_SALES_SIGNALS_READ]: () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
  });
});

// ---- V5: the second and third rules ------------------------------------------------------------------------------------------------------------------

const openDeal = (over: Record<string, unknown> = {}) => ({ dealId: randomUUID(), partyId: party, ...over });
const overdue = (over: Record<string, unknown> = {}) => ({ partyId: party, oldestDueOn: '2026-11-10', amount: '2500000', count: 1, ...over });

const runReceivable = (reads: Reads, options: { absent?: readonly string[]; asked?: string[]; inputs?: Record<string, unknown> } = {}) =>
  receivableWithOpenDealQuery({ now: () => NOW }).handler(contextOf(reads, options.absent, options.asked, options.inputs), {});

describe('the overdue receivable with an open deal rule (Vy C4, V5)', () => {
  it('is a registered kernel read, and an overdue receivable is one that is a day past its due date', () => {
    expect(receivableWithOpenDealQuery().name).toBe(RECEIVABLE_WITH_OPEN_DEAL_READ);
    expect(OVERDUE_RECEIVABLE_MIN_DAYS).toBe(1);
  });

  it('flags a party with a receivable 10 days overdue and an open deal, once however many deals it has, with days, total and a link only', async () => {
    const inputs: Record<string, unknown> = {};
    const items = await runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal(), openDeal()], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue()] }, { inputs });
    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'crm',
        id: `signal:overdue-receivable-open-deal:${party}`,
        title: { key: 'signals.overdueReceivableOpenDeal', params: { days: 10 } },
        amount: '2500000',
        currency: 'VND',
        severity: 'warn',
        dueAt: '2026-11-10T00:00:00+07:00',
        href: '/deals',
      },
    ]);
    expect(zTodayItems.safeParse(items).success).toBe(true);
    // Finance is asked about the parties of the open deals only, each once.
    expect(inputs[FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]).toEqual({ partyIds: [party] });
  });

  it('does not fire on its near misses: due today, no open deal for the party, an overdue party that is not in an open deal', async () => {
    const deals = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await runReceivable({ ...deals, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ oldestDueOn: '2026-11-20' })] })).toHaveLength(0); // due today
    expect(await runReceivable({ ...deals, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ oldestDueOn: '2026-11-19' })] })).toHaveLength(1); // a day over
    expect(await runReceivable({ ...deals, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [] })).toHaveLength(0); // nothing overdue
    expect(await runReceivable({ ...deals, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ partyId: other })] })).toHaveLength(0); // another party
    expect(await runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue()] })).toHaveLength(0); // no open deal
  });

  it('fails closed: no item when the CRM or the finance side is unregistered, off, refusing or outside the contract, and no text crosses', async () => {
    const crm = { [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()] };
    expect(await runReceivable(crm)).toEqual([]);
    expect(await runReceivable(crm, { absent: ['finance'] })).toEqual([]);
    expect(await runReceivable({ ...crm, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: () => { throw new DomainError('FORBIDDEN', 403, 'no'); } })).toEqual([]);
    expect(await runReceivable({ ...crm, [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ partyName: 'Công ty A' })] })).toEqual([]);
    expect(await runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal({ title: 'Hợp đồng' })], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue()] })).toEqual([]);
    expect(await runReceivable({}, { absent: ['crm'] })).toEqual([]);
  });

  it('keeps the oldest due date of a party that comes in several rows, orders the longest overdue first, and caps at 20 with one grouped item', async () => {
    const twice = await runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ oldestDueOn: '2026-11-15' }), overdue({ oldestDueOn: '2026-11-05' })] });
    expect(twice[0]?.title).toEqual({ key: 'signals.overdueReceivableOpenDeal', params: { days: 15 } });
    const parties = Array.from({ length: 23 }, () => randomUUID());
    const items = await runReceivable({
      [CRM_OPEN_DEALS_SIGNALS_READ]: parties.map((partyId) => openDeal({ partyId })),
      [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: parties.map((partyId, i) => overdue({ partyId, oldestDueOn: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}` })),
    });
    expect(items).toHaveLength(SIGNAL_ITEMS_MAX + 1);
    expect(items[SIGNAL_ITEMS_MAX]).toMatchObject({ id: 'signal:overdue-receivable-open-deal:more', count: 3 });
    const home = sortTodayItems(items);
    expect(home.at(-1)?.id).toBe('signal:overdue-receivable-open-deal:more');
    const days = home.slice(0, SIGNAL_ITEMS_MAX).map((i) => (i.title.params as { days: number }).days);
    expect(days).toEqual([...days].sort((x, y) => y - x));
  });

  it('counts the days on the Vietnam calendar and lets a database error through', async () => {
    // NOW is 2026-11-20 in Vietnam: due 11-19 is one day over, whatever the UTC date says.
    const items = await runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: [overdue({ oldestDueOn: '2026-11-19' })] });
    expect(items[0]?.title.params).toEqual({ days: 1 });
    await expect(runReceivable({ [CRM_OPEN_DEALS_SIGNALS_READ]: [openDeal()], [FINANCE_OVERDUE_RECEIVABLES_SIGNALS_READ]: () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
  });
});

const change = (over: Record<string, unknown> = {}) => ({ partyId: party, changedOn: '2026-11-17', ...over });
const waiting = (over: Record<string, unknown> = {}) => ({ partyId: party, count: 2, amount: '30000000', ...over });
const refuse = () => {
  throw new DomainError('FORBIDDEN', 403, 'a partial view');
};

const runBank = (reads: Reads, options: { absent?: readonly string[]; asked?: string[]; inputs?: Record<string, unknown>; errors?: string[] } = {}) =>
  supplierBankChangedQuery({ now: () => NOW, log: { error: (m: string) => void options.errors?.push(m) } }).handler(contextOf(reads, options.absent, options.asked, options.inputs), {});

describe('the supplier bank account changed with a payment waiting rule (Vy C4, V5)', () => {
  it('is a registered kernel read, and a change counts for 30 days', () => {
    expect(supplierBankChangedQuery().name).toBe(SUPPLIER_BANK_CHANGED_READ);
    expect(SUPPLIER_BANK_CHANGE_DAYS).toBe(30);
  });

  it('gives a block item for a supplier that changed its account 3 days ago and has payments waiting, with the count, the total and a link', async () => {
    const inputs: Record<string, unknown> = {};
    const items = await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change()], [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: [waiting()] }, { inputs });
    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'finance',
        id: `signal:supplier-bank-changed:${party}`,
        title: { key: 'signals.supplierBankChanged', params: { days: 3, count: 2 } },
        count: 2,
        amount: '30000000',
        currency: 'VND',
        severity: 'block',
        href: '/inbox',
      },
    ]);
    expect(zTodayItems.safeParse(items).success).toBe(true);
    expect(inputs[FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]).toEqual({ partyIds: [party] });
  });

  it('does not fire on its near misses: no payment waiting, a payment of another supplier, a change older than 30 days or in the future, no change at all', async () => {
    const payments = (rows: unknown[]) => ({ [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: rows });
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change()], ...payments([]) })).toEqual([]);
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change()], ...payments([waiting({ partyId: other })]) })).toEqual([]);
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change({ changedOn: '2026-10-20' })], ...payments([waiting()]) })).toEqual([]); // 31 days
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change({ changedOn: '2026-10-21' })], ...payments([waiting()]) })).toHaveLength(1); // 30 days
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change({ changedOn: '2026-11-25' })], ...payments([waiting()]) })).toEqual([]);
    const asked: string[] = [];
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [], ...payments([waiting()]) }, { asked })).toEqual([]);
    expect(asked).toEqual([FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]); // no change, so payments are not even asked
  });

  it('gives nothing to a member who cannot see the bank changes (refused, unregistered or finance off): they cannot see the change either', async () => {
    const payments = { [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: [waiting()] };
    expect(await runBank(payments)).toEqual([]);
    expect(await runBank(payments, { absent: ['finance'] })).toEqual([]);
    expect(await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: refuse, ...payments })).toEqual([]);
  });

  it('never drops it silently: a changed account with payments the member cannot fully see (refusal, partial view, unregistered read) is one visible warn item, not an empty list', async () => {
    const changes = { [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change(), change({ partyId: other })] };
    for (const reads of [{ ...changes, [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: refuse }, changes]) {
      const items = await runBank(reads);
      expect(items).toEqual([
        {
          kind: 'flag',
          app: 'finance',
          id: 'signal:supplier-bank-changed:unchecked',
          title: { key: 'signals.supplierBankChangedUnchecked', params: { count: 2 } },
          count: 2,
          severity: 'warn',
          href: '/inbox',
        },
      ]);
      expect(zTodayItems.safeParse(items).success).toBe(true);
    }
    expect(await runBank(changes, { absent: ['finance'] })).toEqual([]); // the module off: there is nothing to pay from
  });

  it('never reads a broken answer as "all clear": either read answering outside its contract is logged and fails the read, which Home counts as failed', async () => {
    const errors: string[] = [];
    const good = { [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change()], [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: [waiting()] };
    await expect(runBank({ ...good, [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change({ supplierName: 'Công ty A' })] }, { errors })).rejects.toMatchObject({ code: 'SIGNAL_CONTRACT_BROKEN' });
    await expect(runBank({ ...good, [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: 'x' }, { errors })).rejects.toMatchObject({ code: 'SIGNAL_CONTRACT_BROKEN' });
    await expect(runBank({ ...good, [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: [waiting({ amount: '-1' })] }, { errors })).rejects.toBeInstanceOf(DomainError);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.startsWith('[signals]') && !/Công ty/.test(e))).toBe(true);
  });

  it('keeps the latest change per supplier, lists the most recent change first, caps at 20 with one grouped block item, and counts days on the Vietnam calendar', async () => {
    const twice = await runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: [change({ changedOn: '2026-11-02' }), change({ changedOn: '2026-11-18' })], [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: [waiting()] });
    expect(twice[0]?.title.params).toEqual({ days: 2, count: 2 });
    const parties = Array.from({ length: 23 }, () => randomUUID());
    const items = await runBank({
      [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: parties.map((partyId, i) => change({ partyId, changedOn: `2026-11-${String(1 + (i % 9)).padStart(2, '0')}` })),
      [FINANCE_SUPPLIER_PAYMENTS_WAITING_SIGNALS_READ]: parties.map((partyId) => waiting({ partyId })),
    });
    expect(items).toHaveLength(SIGNAL_ITEMS_MAX + 1);
    expect(items[SIGNAL_ITEMS_MAX]).toMatchObject({ id: 'signal:supplier-bank-changed:more', severity: 'block', count: 3 });
    expect(items.every((i) => i.severity === 'block')).toBe(true);
  });

  it('lets a database error through', async () => {
    await expect(runBank({ [FINANCE_SUPPLIER_BANK_CHANGES_SIGNALS_READ]: () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
  });
});
