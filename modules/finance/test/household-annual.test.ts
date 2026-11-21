// SPDX-License-Identifier: AGPL-3.0-only
// The yearly rule of the household tax (#3710 slice 3): nothing up to the threshold; above it VAT on all the revenue and PIT only on the part above; the VAT cut by the caller's say-so and the PIT cut up to its
// ceiling; the household's pick of the trade that takes the deduction, never defaulted; a period is the difference of two year-to-date figures.
import { describe, expect, it } from 'vitest';
import type { HouseholdTrade } from '@ludy/kernel-contract';
import { annualTax, periodTax, type AnnualInput } from '../src/domain/household-annual.ts';

const RATES = new Map([
  ['goods', { vatPercent: '1', pitPercent: '0.5' }],
  ['services', { vatPercent: '5', pitPercent: '2' }],
] as Array<[HouseholdTrade, { vatPercent: string; pitPercent: string }]>);
const input = (revenue: Array<[HouseholdTrade, string]>, over: Partial<AnnualInput> = {}): AnnualInput => ({
  revenue: new Map(revenue),
  rates: RATES,
  threshold: '1000000000',
  vatCutPercent: '0',
  pitCut: null,
  deductionTrade: null,
  pitApplies: true,
  ...over,
});
const PIT_CUT = { percent: '30', ceiling: '10000000000' };

describe('annualTax', () => {
  it('owes nothing up to the threshold, whatever the cuts', () => {
    const t = annualTax(input([['goods', '1000000000']], { vatCutPercent: '20', pitCut: PIT_CUT }));
    expect(t).toMatchObject({ crossed: false, vat: '0', pit: '0', held: null });
  });

  it('the acceptance example: goods 1.2 billion in 2026 owes VAT on all of it less 20%, and PIT on the 0.2 billion above less 30%', () => {
    const t = annualTax(input([['goods', '1200000000']], { vatCutPercent: '20', pitCut: PIT_CUT }));
    // VAT 1.2bn x 1% = 12 000 000, less 20% = 2 400 000 cut, 9 600 000 to pay.
    expect(t).toMatchObject({ crossed: true, vatBefore: '12000000', vatCut: '2400000', vat: '9600000' });
    // PIT (1.2bn - 1bn) x 0.5% = 1 000 000, less 30% = 300 000 cut, 700 000 to pay.
    expect(t).toMatchObject({ pitBefore: '1000000', pitCut: '300000', pit: '700000', held: null });
  });

  it('applies no VAT cut when the caller says none, and no PIT cut above the ceiling or with no cut row', () => {
    expect(annualTax(input([['goods', '1200000000']], { pitCut: PIT_CUT }))).toMatchObject({ vatCut: '0', vat: '12000000', pitCut: '300000' });
    expect(annualTax(input([['goods', '10000000001']], { pitCut: PIT_CUT }))).toMatchObject({ pitCut: '0' });
    expect(annualTax(input([['goods', '10000000000']], { pitCut: PIT_CUT })).pitCut).not.toBe('0');
    expect(annualTax(input([['goods', '1200000000']], { pitCut: null }))).toMatchObject({ pitCut: '0', pit: '1000000' });
    // No ceiling: the cut holds at any revenue.
    expect(annualTax(input([['goods', '20000000000']], { pitCut: { percent: '30', ceiling: null } })).pitCut).not.toBe('0');
  });

  it('works VAT per trade on all the revenue and takes the deduction from the picked trade only', () => {
    const rev: Array<[HouseholdTrade, string]> = [['goods', '800000000'], ['services', '1200000000']];
    // VAT: goods 8 000 000 and services 60 000 000.
    const t = annualTax(input(rev, { deductionTrade: 'services' }));
    expect(t).toMatchObject({ vatBefore: '68000000', held: null });
    // PIT: goods 800 000 000 x 0.5% = 4 000 000; services (1.2bn - 1bn) x 2% = 4 000 000.
    expect(t.pitBefore).toBe('8000000');
    // Picking goods instead (800 million, less than the threshold) is not a usable pick: the PIT is held back.
    expect(annualTax(input(rev, { deductionTrade: 'goods' }))).toMatchObject({ held: 'deduction', pit: '0', vatBefore: '68000000' });
  });

  it('holds the PIT back as short, not asked, when no single trade reaches the threshold: the research gives no rule for the rest of the deduction', () => {
    const rev: Array<[HouseholdTrade, string]> = [['goods', '600000000'], ['services', '700000000']];
    expect(annualTax(input(rev))).toMatchObject({ crossed: true, held: 'short', pit: '0', vatBefore: '41000000' });
    // A pick changes nothing: no trade can take the whole deduction.
    expect(annualTax(input(rev, { deductionTrade: 'services' }))).toMatchObject({ held: 'short', pit: '0' });
  });

  it('asks for the pick when there are several trades, and never defaults it', () => {
    const t = annualTax(input([['goods', '800000000'], ['services', '1200000000']]));
    expect(t).toMatchObject({ crossed: true, held: 'deduction', pit: '0' });
    // The VAT does not wait for the pick.
    expect(t.vat).toBe('68000000');
  });

  it('works no PIT and asks for no pick where the book carries none (the income method)', () => {
    const t = annualTax(input([['goods', '800000000'], ['services', '1200000000']], { pitApplies: false, pitCut: PIT_CUT }));
    expect(t).toMatchObject({ crossed: true, held: null, vatBefore: '68000000', pit: '0', pitCut: '0' });
  });

  it('a trade with no revenue does not count as a second trade', () => {
    const t = annualTax(input([['goods', '1200000000'], ['services', '0']]));
    expect(t).toMatchObject({ held: null, pitBefore: '1000000' });
  });

  it('returns lower the revenue and so the tax; a negative trade carries no tax of its own', () => {
    const t = annualTax(input([['goods', '1500000000'], ['services', '-100000000']], { deductionTrade: 'goods' }));
    expect(t.revenue).toBe('1400000000');
    expect(t.vatBefore).toBe('15000000');
  });
});

describe('periodTax', () => {
  it('is the year-to-date tax at the end less the year-to-date tax before the period', () => {
    const before = annualTax(input([['goods', '900000000']]));
    const end = annualTax(input([['goods', '1200000000']], { vatCutPercent: '20', pitCut: PIT_CUT }));
    // Before the threshold nothing was owed, so this period carries the catch-up of the whole year.
    expect(periodTax(end, before)).toEqual({ vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '1000000', pitCut: '300000', pit: '700000' });
  });

  it('adds up: the periods of a year equal the year', () => {
    const q1 = annualTax(input([['goods', '600000000']]));
    const q2 = annualTax(input([['goods', '1100000000']]));
    const q3 = annualTax(input([['goods', '1300000000']]));
    const none = annualTax(input([]));
    const p1 = periodTax(q1, none)!;
    const p2 = periodTax(q2, q1)!;
    const p3 = periodTax(q3, q2)!;
    expect(p1.vat).toBe('0');
    expect(Number(p1.vat) + Number(p2.vat) + Number(p3.vat)).toBe(Number(q3.vat));
    expect(Number(p1.pit) + Number(p2.pit) + Number(p3.pit)).toBe(Number(q3.pit));
  });

  it('is null while either side holds the PIT back', () => {
    const held = annualTax(input([['goods', '800000000'], ['services', '1200000000']]));
    expect(periodTax(held, annualTax(input([])))).toBeNull();
    expect(periodTax(annualTax(input([])), held)).toBeNull();
  });
});
