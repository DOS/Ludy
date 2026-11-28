// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist's rules (finance.year_end) as pure functions: when a year is over, the due date of each return from the tax calendar's rules (and the household's fourth quarter), the asset
// months not depreciated, and the checklist built from what the reads found, for a company (TT133 and TT99 read the same way: the books differ in account names, not in what is read; the DB test runs both), a company with a fiscal
// year that is not the calendar year and a household. The reads themselves are checked in apps/kernel/test/finance-year-end.db.test.ts.
import { describe, expect, it } from 'vitest';
import { YEAR_END_ITEMS, type YearEndItem, type YearEndKey } from '@ludy/kernel-contract';
import { buildYearEnd, householdFourthQuarterDue, openAssetMonths, readyKeys, returnDue, yearOver, type YearEndReads } from '../src/domain/year-end.ts';

const ENTITY = 'le-1';
const ALL_RETURNS = ['financial_statements', 'cit_finalization', 'pit_finalization'] as const;

// A company with nothing found: no balance, no asset, no stock, nothing closed or locked, every company return on its calendar and none marked, no e-invoice connection.
const base = (over: Partial<YearEndReads> = {}): YearEndReads => ({
  household: false,
  balances: 0,
  assetMonthsOpen: null,
  stockKept: false,
  stockCounted: false,
  closed: false,
  lockedThrough: null,
  tax: { obligations: ALL_RETURNS, fiscalYearEndMonth: 12, marked: new Set() },
  householdReturn: { required: false, prepared: false },
  einvoice: { connected: false, nextYearSeries: false },
  ...over,
});
const stateOf = (items: readonly YearEndItem[], key: YearEndKey) => items.find((i) => i.key === key);

describe('yearOver', () => {
  it('is true from the first day of the next year on', () => {
    expect(yearOver(2026, '2026-12-31')).toBe(false);
    expect(yearOver(2026, '2027-01-01')).toBe(true);
    expect(yearOver(2026, '2026-11-28')).toBe(false);
  });
});

describe('returnDue', () => {
  it('gives the due date and the period end from the tax calendar rules, after the day-off rule', () => {
    // Decree 252/2026/NĐ-CP Art. 10(5)(a) and Law 88/2015/QH13 Art. 29(3): 31 March 2027 is a Wednesday.
    expect(returnDue('cit_finalization', 2026, 12)).toEqual({ due: '2027-03-31', periodEnd: '2026-12-31' });
    expect(returnDue('pit_finalization', 2026, 12)).toEqual({ due: '2027-03-31', periodEnd: '2026-12-31' });
    expect(returnDue('financial_statements', 2026, 12)).toEqual({ due: '2027-03-31', periodEnd: '2026-12-31' });
  });

  it('names a fiscal year by the calendar year it ends in', () => {
    // The fiscal year that ends on 31 March 2026: the finalization on the last day of June, the statements 90 days after.
    expect(returnDue('cit_finalization', 2026, 3)).toEqual({ due: '2026-06-30', periodEnd: '2026-03-31' });
    expect(returnDue('financial_statements', 2026, 3)).toEqual({ due: '2026-06-29', periodEnd: '2026-03-31' });
    // The employer's PIT finalization stays on the calendar year.
    expect(returnDue('pit_finalization', 2026, 3)).toEqual({ due: '2027-03-31', periodEnd: '2026-12-31' });
  });
});

describe('householdFourthQuarterDue', () => {
  it('is the last day of January after the year, moved to the next working day', () => {
    // 31 January 2027 is a Sunday (Decree 68/2026/NĐ-CP Art. 8(3)(a); the day-off rule, Decree 252/2026/NĐ-CP Art. 3(7)).
    expect(householdFourthQuarterDue(2026)).toBe('2027-02-01');
    // 31 January 2028 is a Monday, and the compensatory day of the Saturday 29 January, the fifth day of Tết (Labor Code Art. 111(3)): Tuesday 1 February.
    expect(householdFourthQuarterDue(2027)).toBe('2028-02-01');
  });
});

describe('openAssetMonths', () => {
  const asset = (over: Record<string, unknown> = {}) => ({ id: 'a1', cost: '1200000', startMonth: '2026-01-01', months: 12, endedMonth: null, ...over });
  const posted = (id: string, months: number[]) => new Set(months.map((m) => `${id}|2026-${String(m).padStart(2, '0')}-01`));

  it('counts the months that have ended with no depreciation line, and not the month still running', () => {
    // On 28 November 2026 January to October have ended.
    expect(openAssetMonths([asset()], new Set(), 2026, '2026-11-28')).toBe(10);
    expect(openAssetMonths([asset()], posted('a1', [1, 2, 3]), 2026, '2026-11-28')).toBe(7);
    expect(openAssetMonths([asset()], posted('a1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 2026, '2026-11-28')).toBe(0);
    // The last day of the month is not the end of it: the month ends on the first day of the next.
    expect(openAssetMonths([asset()], new Set(), 2026, '2026-10-31')).toBe(9);
  });

  it('counts December once the year is over, and every month for an asset still running', () => {
    expect(openAssetMonths([asset()], posted('a1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 2026, '2027-01-05')).toBe(1);
  });

  it('follows the schedule: not before the start month, not after the month it was ended, and not a month with nothing to post', () => {
    expect(openAssetMonths([asset({ startMonth: '2026-11-01' })], new Set(), 2026, '2027-01-05')).toBe(2);
    expect(openAssetMonths([asset({ endedMonth: '2026-03-01' })], new Set(), 2026, '2027-01-05')).toBe(3);
    // A cost of 5 over 12 months is 0 a month except the last, which takes the rest: only December has an amount.
    expect(openAssetMonths([asset({ cost: '5' })], new Set(), 2026, '2027-01-05')).toBe(1);
  });

  it('sums over assets, each with its own lines', () => {
    expect(openAssetMonths([asset(), asset({ id: 'a2' })], posted('a2', [1, 2]), 2026, '2026-11-28')).toBe(18);
  });
});

describe('buildYearEnd: a company before the year ends', () => {
  const today = '2026-11-28';
  const checklist = buildYearEnd(ENTITY, 2026, today, base({ assetMonthsOpen: 0, lockedThrough: '2026-09-30' }));

  it('lists every item once, in the fixed order', () => {
    expect(checklist.items.map((i) => i.key)).toEqual([...YEAR_END_ITEMS]);
    expect(checklist).toMatchObject({ year: 2026, legalEntityId: ENTITY, over: false });
  });

  it('shows what cannot be done yet as open and waiting, and what is not asked as done or not applicable', () => {
    expect(stateOf(checklist.items, 'balances')).toEqual({ key: 'balances', state: 'done', waiting: false, count: 0, due: null });
    // Every month that has ended is posted, December is still to come.
    expect(stateOf(checklist.items, 'depreciation')).toEqual({ key: 'depreciation', state: 'open', waiting: true, count: 0, due: null });
    expect(stateOf(checklist.items, 'stock_count')?.state).toBe('na');
    expect(stateOf(checklist.items, 'closing_entry')).toMatchObject({ state: 'open', waiting: true, count: 1 });
    expect(stateOf(checklist.items, 'months_locked')).toMatchObject({ state: 'open', waiting: true });
    for (const key of ['statements', 'cit', 'pit'] as const) expect(stateOf(checklist.items, key), key).toEqual({ key, state: 'open', waiting: true, count: 1, due: '2027-03-31' });
    expect(stateOf(checklist.items, 'household_return')?.state).toBe('na');
    expect(stateOf(checklist.items, 'einvoice_series')?.state).toBe('na');
  });

  it('has nothing the coworker is asked about while every open item waits', () => {
    expect(readyKeys(checklist)).toEqual([]);
  });
});

describe('buildYearEnd: the open items that can be done now', () => {
  it('counts the balances to look at and the asset months not posted, and keeps them ready', () => {
    const checklist = buildYearEnd(ENTITY, 2026, '2026-11-28', base({ balances: 3, assetMonthsOpen: 2, stockKept: true, einvoice: { connected: true, nextYearSeries: false } }));
    expect(stateOf(checklist.items, 'balances')).toEqual({ key: 'balances', state: 'open', waiting: false, count: 3, due: null });
    expect(stateOf(checklist.items, 'depreciation')).toEqual({ key: 'depreciation', state: 'open', waiting: false, count: 2, due: null });
    expect(stateOf(checklist.items, 'stock_count')).toMatchObject({ state: 'open', waiting: true });
    // The e-invoice series of the new year can be added before the year ends.
    expect(stateOf(checklist.items, 'einvoice_series')).toEqual({ key: 'einvoice_series', state: 'open', waiting: false, count: 1, due: null });
    expect(readyKeys(checklist)).toEqual(['balances', 'depreciation', 'einvoice_series']);
  });

  it('opens the returns for filing once the period has ended', () => {
    const checklist = buildYearEnd(ENTITY, 2026, '2027-01-10', base({ closed: true, lockedThrough: '2026-12-31' }));
    expect(checklist.over).toBe(true);
    expect(stateOf(checklist.items, 'closing_entry')?.state).toBe('done');
    expect(stateOf(checklist.items, 'months_locked')?.state).toBe('done');
    for (const key of ['statements', 'cit', 'pit'] as const) expect(stateOf(checklist.items, key), key).toMatchObject({ state: 'open', waiting: false, due: '2027-03-31' });
    expect(readyKeys(checklist)).toEqual(['statements', 'cit', 'pit']);
  });

  it('is done when every item is done, with the marks of the returns', () => {
    const checklist = buildYearEnd(
      ENTITY,
      2026,
      '2027-02-10',
      base({
        assetMonthsOpen: 0,
        stockKept: true,
        stockCounted: true,
        closed: true,
        lockedThrough: '2026-12-31',
        tax: { obligations: ALL_RETURNS, fiscalYearEndMonth: 12, marked: new Set(ALL_RETURNS) },
        einvoice: { connected: true, nextYearSeries: true },
      }),
    );
    expect(checklist.items.filter((i) => i.state === 'open')).toEqual([]);
    expect(stateOf(checklist.items, 'depreciation')?.state).toBe('done');
    expect(readyKeys(checklist)).toEqual([]);
  });

  it('is not applicable for a return the org did not turn on', () => {
    const checklist = buildYearEnd(ENTITY, 2026, '2027-01-10', base({ tax: { obligations: ['cit_finalization'], fiscalYearEndMonth: 12, marked: new Set() } }));
    expect(stateOf(checklist.items, 'statements')?.state).toBe('na');
    expect(stateOf(checklist.items, 'pit')?.state).toBe('na');
    expect(stateOf(checklist.items, 'cit')?.state).toBe('open');
  });
});

describe('buildYearEnd: a fiscal year that is not the calendar year', () => {
  it('opens a return whose fiscal year has ended while the calendar year still runs, with its own due date', () => {
    const checklist = buildYearEnd(ENTITY, 2026, '2026-11-28', base({ tax: { obligations: ALL_RETURNS, fiscalYearEndMonth: 3, marked: new Set() } }));
    expect(stateOf(checklist.items, 'statements')).toEqual({ key: 'statements', state: 'open', waiting: false, count: 1, due: '2026-06-29' });
    expect(stateOf(checklist.items, 'cit')).toEqual({ key: 'cit', state: 'open', waiting: false, count: 1, due: '2026-06-30' });
    // The employer's PIT finalization is by calendar year, which has not ended.
    expect(stateOf(checklist.items, 'pit')).toEqual({ key: 'pit', state: 'open', waiting: true, count: 1, due: '2027-03-31' });
  });
});

describe('buildYearEnd: a household', () => {
  const household = (over: Partial<YearEndReads> = {}) => base({ household: true, ...over });

  it('has no closing entry and no company return, whatever its tax calendar holds', () => {
    const checklist = buildYearEnd(ENTITY, 2026, '2027-01-10', household());
    for (const key of ['closing_entry', 'statements', 'cit', 'pit', 'household_return'] as const) expect(stateOf(checklist.items, key)?.state, key).toBe('na');
    expect(stateOf(checklist.items, 'months_locked')?.state).toBe('open');
  });

  it('asks for the fourth quarter worksheet of a household that files by percentage, with its due date', () => {
    const open = buildYearEnd(ENTITY, 2026, '2027-01-10', household({ householdReturn: { required: true, prepared: false } }));
    expect(stateOf(open.items, 'household_return')).toEqual({ key: 'household_return', state: 'open', waiting: false, count: 1, due: '2027-02-01' });
    const waiting = buildYearEnd(ENTITY, 2026, '2026-11-28', household({ householdReturn: { required: true, prepared: false } }));
    expect(stateOf(waiting.items, 'household_return')).toMatchObject({ state: 'open', waiting: true });
    const done = buildYearEnd(ENTITY, 2026, '2027-01-10', household({ householdReturn: { required: true, prepared: true } }));
    expect(stateOf(done.items, 'household_return')?.state).toBe('done');
  });
});
