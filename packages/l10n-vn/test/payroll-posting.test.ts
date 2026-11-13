// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PAYROLL_POSTING_MAPS, PAY_FUNCTIONS, PostingRefusedError, buildBankFile, buildPosting, isCashOverLimit, type PostingLine } from '../src/index.ts';

// Hand-worked from the rates of docs/plan/payroll.md section 5 for an invented person: gross 20,000,000; employee insurance 8% + 1.5% + 1% = 2,100,000; employer 14% + 3% + 0.5% + 3% + 1% = 4,300,000;
// union fee 2% = 400,000; PIT 500,000; an advance of 1,000,000 recovered; net 20,000,000 - 2,100,000 - 500,000 - 1,000,000 = 16,400,000.
const person = (over: Partial<PostingLine> = {}): PostingLine => ({
  payFunction: 'admin',
  gross: '20000000',
  funds: [
    { fund: 'retirement_death', employee: '1600000', employer: '2800000' },
    { fund: 'sickness_maternity', employee: '0', employer: '600000' },
    { fund: 'work_accident', employee: '0', employer: '100000' },
    { fund: 'health', employee: '300000', employer: '600000' },
    { fund: 'unemployment', employee: '200000', employer: '200000' },
  ],
  unionFee: '400000',
  pit: '500000',
  advance: '1000000',
  otherDeductions: '0',
  net: '16400000',
  ...over,
});
const by = (lines: { account: string; debit: string; credit: string }[]) => Object.fromEntries(lines.map((l) => [l.account, l.debit !== '0' ? `Dr ${l.debit}` : `Cr ${l.credit}`]));

describe('payroll posting (#2532)', () => {
  it('posts one line per account under TT99, unemployment insurance on 3386', () => {
    const r = buildPosting('tt99', [person()]);
    expect(by(r.lines)).toEqual({ '6421': 'Dr 24700000', '334': 'Cr 16400000', '3383': 'Cr 5100000', '3384': 'Cr 900000', '3386': 'Cr 400000', '3382': 'Cr 400000', '3335': 'Cr 500000', '141': 'Cr 1000000' });
    expect(new Set(r.lines.map((l) => l.account)).size).toBe(r.lines.length);
    expect(r.lines.some((l) => l.account === '3385')).toBe(false);
    expect(r.totals.employerCost).toBe('24700000');
  });

  it('posts under TT133 on 3385 and never on 3386', () => {
    const r = buildPosting('tt133', [person()]);
    expect(by(r.lines)['3385']).toBe('Cr 400000');
    expect(r.lines.some((l) => l.account === '3386')).toBe(false);
    expect(by(r.lines)['6422']).toBe('Dr 24700000');
  });

  it('balances and equals the totals of the run, for every function under both charts', () => {
    for (const regime of ['tt133', 'tt99'] as const) {
      for (const payFunction of PAY_FUNCTIONS) {
        const r = buildPosting(regime, [person({ payFunction }), person({ payFunction: 'sales' })]);
        const dr = r.lines.reduce((a, l) => a + BigInt(l.debit), 0n);
        const cr = r.lines.reduce((a, l) => a + BigInt(l.credit), 0n);
        expect(dr).toBe(cr);
        expect(dr).toBe(BigInt(r.totals.employerCost));
        expect(r.totals.net).toBe('32800000');
      }
    }
  });

  it('splits gross by function to the expense account of the chart', () => {
    const r = buildPosting('tt99', [person({ payFunction: 'production' }), person({ payFunction: 'sales' }), person({ payFunction: 'overhead' }), person({ payFunction: 'construction' })]);
    expect(by(r.lines)).toMatchObject({ '622': 'Dr 24700000', '6411': 'Dr 24700000', '6271': 'Dr 24700000', '241': 'Dr 24700000' });
  });

  it('refuses a line that is not its gross less its deductions, and an empty run', () => {
    expect(() => buildPosting('tt99', [person({ net: '16400001' })])).toThrow(PostingRefusedError);
    expect(() => buildPosting('tt99', [])).toThrow(PostingRefusedError);
  });

  it('lists what settles the run: net pay, insurance, union fee, tax', () => {
    const r = buildPosting('tt99', [person(), person()]);
    expect(r.obligations.map((o) => [o.kind, o.amount])).toEqual([['net_pay', '32800000'], ['insurance', '12800000'], ['union', '800000'], ['tax', '1000000']]);
    expect(r.obligations[1]?.debits).toEqual([{ account: '3383', amount: '10200000' }, { account: '3384', amount: '1800000' }, { account: '3386', amount: '800000' }]);
  });

  it('keeps every row of the map unconfirmed until the accountant reads it', () => {
    expect(Object.values(PAYROLL_POSTING_MAPS).map((m) => m.status)).toEqual(['commentary', 'commentary']);
    expect(PAYROLL_POSTING_MAPS.tt99.unemployment).toBe('3386');
    expect(PAYROLL_POSTING_MAPS.tt133.unemployment).toBe('3385');
    // How a correction of an earlier month is booked (the period and the sign) is a rule of its own, and waits for the accountant too.
    expect(Object.values(PAYROLL_POSTING_MAPS).map((m) => m.adjustments.status)).toEqual(['commentary', 'commentary']);
  });

  it('adds a correction line with signed amounts', () => {
    const r = buildPosting('tt99', [person(), person({ gross: '-1000000', funds: [], unionFee: '0', pit: '0', advance: '0', net: '-1000000' })]);
    expect(by(r.lines)['6421']).toBe('Dr 23700000');
  });
});

describe('payroll cash flag and bank file (#2532)', () => {
  it('flags cash of 5 million or more only', () => {
    expect(isCashOverLimit('cash', '5000000')).toBe(true);
    expect(isCashOverLimit('cash', '4999999')).toBe(false);
    expect(isCashOverLimit('bank', '90000000')).toBe(false);
  });

  it('writes one row per person with the net pay in the layout order', () => {
    const t = buildBankFile(
      [
        { name: 'Nguyen Van A', account: '0000000001', bank: 'ABC', net: '16400000' },
        { name: 'Tran Thi B', account: '0000000002', bank: 'ABC', net: '0' },
        { name: 'Le Van C', account: '0000000003', bank: 'XYZ', net: '9000000' },
      ],
      '2026-12',
      { columns: [{ key: 'name', header: 'Name' }, { key: 'amount', header: 'Amount' }, { key: 'sequence', header: 'No' }, { key: 'content', header: 'Memo' }], content: 'Pay {month}' },
    );
    expect(t.header).toEqual(['Name', 'Amount', 'No', 'Memo']);
    expect(t.rows).toEqual([['Nguyen Van A', '16400000', '1', 'Pay 12/2026'], ['Le Van C', '9000000', '2', 'Pay 12/2026']]);
    expect(t.total).toBe('25400000');
  });
});
