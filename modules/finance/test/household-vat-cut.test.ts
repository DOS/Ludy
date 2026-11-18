// SPDX-License-Identifier: AGPL-3.0-only
// The Decree 174 VAT cut of the household books (#3710 slice 2): applied only on the household's answer yes, never on no, and on no answer the books compute without it and show the VAT if eligible.
// The cut of a line is the cut percentage of that line's rounded VAT, to a whole dong; nothing is ever negative, and a part with no trade holds the totals back.
import { describe, expect, it } from 'vitest';
import { vatCutBlock, vatCutUnconfirmed, type VatCutRow } from '../src/household-vat-cut.ts';

const CUT: VatCutRow = { percent: '20.0000', effectiveFrom: '2026-01-01', status: 'confirmed' };
const LINES = [
  { trade: 'goods' as const, vat: '12000000' },
  { trade: 'services' as const, vat: '1001' },
];

describe('vatCutBlock', () => {
  it('applies the cut by line when the answer is yes, rounding the cut of each line to a whole dong', () => {
    const b = vatCutBlock({ answer: 'yes', cut: CUT, lines: LINES, complete: true });
    expect(b.applied).toBe(true);
    // 20% of 12 000 000 is 2 400 000; 20% of 1 001 is 200.2, which rounds to 200.
    expect(b.lines).toEqual([
      { trade: 'goods', cut: '2400000', vatPayable: '9600000' },
      { trade: 'services', cut: '200', vatPayable: '801' },
    ]);
    expect(b.total).toEqual({ cut: '2400200', vatPayable: '9600801' });
    expect(b.ifEligible).toBeNull();
  });

  it('applies no cut when the answer is no, and shows no "if eligible" figure', () => {
    const b = vatCutBlock({ answer: 'no', cut: CUT, lines: LINES, complete: true });
    expect(b.applied).toBe(false);
    expect(b.lines.map((l) => l.cut)).toEqual(['0', '0']);
    expect(b.total).toEqual({ cut: '0', vatPayable: '12001001' });
    expect(b.ifEligible).toBeNull();
  });

  it('computes without the cut when there is no answer, and shows what the VAT would be if eligible', () => {
    const b = vatCutBlock({ answer: null, cut: CUT, lines: LINES, complete: true });
    expect(b.applied).toBe(false);
    expect(b.total).toEqual({ cut: '0', vatPayable: '12001001' });
    expect(b.ifEligible).toEqual({ cut: '2400200', vatPayable: '9600801' });
  });

  it('cuts nothing and says nothing of eligibility when no cut is in force (after the row of 0, or with no row at all)', () => {
    const ended = vatCutBlock({ answer: null, cut: { percent: '0.0000', effectiveFrom: '2027-01-01', status: 'confirmed' }, lines: LINES, complete: true });
    expect(ended.percent).toBe('0.0000');
    expect(ended.ifEligible).toBeNull();
    expect(vatCutBlock({ answer: 'yes', cut: { percent: '0.0000', effectiveFrom: '2027-01-01', status: 'confirmed' }, lines: LINES, complete: true }).applied).toBe(false);
    const none = vatCutBlock({ answer: 'yes', cut: null, lines: LINES, complete: true });
    expect(none.applied).toBe(false);
    expect(none.total).toEqual({ cut: '0', vatPayable: '12001001' });
  });

  it('holds the total and the "if eligible" figure back while a part has no trade', () => {
    const yes = vatCutBlock({ answer: 'yes', cut: CUT, lines: LINES, complete: false });
    expect(yes.total).toBeNull();
    expect(yes.lines).toHaveLength(2);
    expect(vatCutBlock({ answer: null, cut: CUT, lines: LINES, complete: false }).ifEligible).toBeNull();
  });

  it('never goes negative: a line with no VAT has no cut', () => {
    const b = vatCutBlock({ answer: 'yes', cut: CUT, lines: [{ trade: 'goods', vat: '0' }], complete: true });
    expect(b.lines).toEqual([{ trade: 'goods', cut: '0', vatPayable: '0' }]);
  });
});

describe('vatCutUnconfirmed', () => {
  it('makes the book provisional only when it relies on an unconfirmed cut', () => {
    const open: VatCutRow = { ...CUT, status: 'commentary' };
    expect(vatCutUnconfirmed('yes', open)).toEqual({ kind: 'reduction', key: 'vat', effectiveFrom: '2026-01-01' });
    expect(vatCutUnconfirmed(null, open)).toEqual({ kind: 'reduction', key: 'vat', effectiveFrom: '2026-01-01' });
    expect(vatCutUnconfirmed('no', open)).toBeNull();
    expect(vatCutUnconfirmed('yes', CUT)).toBeNull();
    expect(vatCutUnconfirmed('yes', null)).toBeNull();
    expect(vatCutUnconfirmed('yes', { ...open, percent: '0.0000' })).toBeNull();
  });
});
