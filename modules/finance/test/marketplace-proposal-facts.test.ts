// SPDX-License-Identifier: AGPL-3.0-only
// The facts behind the coworker's note on a marketplace proposal (#4389): every figure in whole dong from the stored payload, the classified kinds, the accounts of the entry, and the Uncertain (#2520)
// points chosen by code from a closed table. Each point names rows of the posting map: a test pins them so a renamed row fails the build, and a proposal shows only the points of the rows it uses.
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_PAYOUT_COMMAND, MARKETPLACE_SETTLEMENT_COMMAND } from '@ludy/kernel-contract';
import { MARKETPLACE_UNCERTAIN, marketplaceProposalFacts } from '../src/marketplace-proposal-facts.ts';
import { MARKETPLACE_POSTING_MAPS } from '../src/marketplace-posting-map.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (account: string, debit: string, credit: string) => ({ account, party: null, debit, credit });
const SETTLEMENT = {
  date: '2026-10-15',
  description: 'Đối soát',
  lines: [line('131', '335000', '0'), line('5111', '0', '335000')],
  total: '335000',
  settlementId: ID(1),
  months: [{ month: '2026-10', date: '2026-10-15', total: '335000' }],
  platform: 'shopee',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-15',
  sales: '350000',
  sellerDiscount: '15000',
  refund: '0',
};
const PAYOUT = {
  date: '2026-10-20',
  description: 'Sàn trả',
  lines: [line('1121', '304000', '0'), line('331', '28000', '0'), line('3331', '2000', '0'), line('3335', '1000', '0'), line('131', '0', '335000')],
  total: '335000',
  settlementId: ID(1),
  bankLineId: ID(2),
  platform: 'shopee',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-15',
  received: '304000',
  fees: '28000',
  taxWithheld: '3000',
  adjustments: [] as unknown[],
};

describe('the closed table of Uncertain (#2520) points', () => {
  it('names only rows that exist in every posting map, so a renamed row fails the build', () => {
    expect(MARKETPLACE_UNCERTAIN.length).toBeGreaterThan(5);
    for (const [regime, map] of Object.entries(MARKETPLACE_POSTING_MAPS)) {
      for (const point of MARKETPLACE_UNCERTAIN) for (const row of point.rows) expect(Object.hasOwn(map, row), `${regime}.${row} (${point.key})`).toBe(true);
    }
    expect(new Set(MARKETPLACE_UNCERTAIN.map((p) => p.key)).size).toBe(MARKETPLACE_UNCERTAIN.length);
    for (const point of MARKETPLACE_UNCERTAIN) {
      expect(point.vi.length).toBeGreaterThan(20);
      expect(point.en.length).toBeGreaterThan(20);
    }
  });
});

describe('the facts of a stored proposal', () => {
  it('read a settlement in whole dong, with the accounts of its lines and the points of the rows it uses', () => {
    const facts = marketplaceProposalFacts(MARKETPLACE_SETTLEMENT_COMMAND, SETTLEMENT);
    expect(facts).toMatchObject({ kind: 'settlement', figures: { sales: '350000', sellerDiscount: '15000' }, lineKinds: [], accounts: ['131', '5111'] });
    expect(facts?.figures.refund).toBeUndefined();
    // A seller discount brings the voucher point; no refund, no withheld tax and no VAT line bring none of those.
    expect(facts?.uncertain.map((p) => p.key)).toEqual(['receivable', 'revenue_voucher']);
  });

  it('shows the refund point only with a refund, and the VAT point only with a 33311 line', () => {
    const facts = marketplaceProposalFacts(MARKETPLACE_SETTLEMENT_COMMAND, { ...SETTLEMENT, refund: '10000', lines: [...SETTLEMENT.lines, line('33311', '0', '1000')] });
    expect(facts?.uncertain.map((p) => p.key)).toEqual(['receivable', 'revenue_voucher', 'sales_return', 'output_vat']);
  });

  it('read a payout with no classified line: no incentive, compensation or tax-in-error point', () => {
    const facts = marketplaceProposalFacts(MARKETPLACE_PAYOUT_COMMAND, PAYOUT);
    expect(facts).toMatchObject({ kind: 'payout', figures: { received: '304000', fees: '28000', taxWithheld: '3000' }, lineKinds: [], accounts: ['1121', '331', '3331', '3335', '131'] });
    expect(facts?.uncertain.map((p) => p.key)).toEqual(['receivable', 'household_tax', 'fee_netting']);
    const text = JSON.stringify(facts?.uncertain);
    expect(text).not.toContain('thưởng');
    expect(text).not.toContain('incentive');
  });

  it('read the classified lines of a payout: their kinds, their sums and the points of the rows they use', () => {
    const adjustments = [
      { kind: 'incentive', lineId: ID(11), amount: '6000' },
      { kind: 'incentive', lineId: ID(12), amount: '2000' },
      { kind: 'carrier_compensation', lineId: ID(13), amount: '3000', costAmount: '1500' },
      { kind: 'withheld_in_error', lineId: ID(14), amount: '2000' },
    ];
    const facts = marketplaceProposalFacts(MARKETPLACE_PAYOUT_COMMAND, { ...PAYOUT, adjustments });
    expect(facts).toMatchObject({ lineKinds: ['incentive', 'carrier_compensation', 'withheld_in_error'], figures: { incentive: '8000', compensation: '3000', compensationCost: '1500', taxInError: '2000' } });
    expect(facts?.uncertain.map((p) => p.key)).toEqual(['receivable', 'household_tax', 'fee_netting', 'other_income', 'compensation_cost', 'tax_in_error']);
  });

  it('shows no other-income point for a compensation that stays below its stated cost', () => {
    const facts = marketplaceProposalFacts(MARKETPLACE_PAYOUT_COMMAND, { ...PAYOUT, adjustments: [{ kind: 'carrier_compensation', lineId: ID(13), amount: '3000', costAmount: '9000' }] });
    expect(facts?.uncertain.map((p) => p.key)).toEqual(['receivable', 'household_tax', 'fee_netting', 'compensation_cost']);
  });

  it('is null for any other command, and for a payload that no longer fits its shape', () => {
    expect(marketplaceProposalFacts('finance.journal_voucher.record', PAYOUT)).toBeNull();
    expect(marketplaceProposalFacts(MARKETPLACE_PAYOUT_COMMAND, { ...PAYOUT, received: 'abc' })).toBeNull();
    expect(marketplaceProposalFacts(MARKETPLACE_SETTLEMENT_COMMAND, null)).toBeNull();
  });
});
