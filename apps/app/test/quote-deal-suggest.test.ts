// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker offers on a deal once its quote was sent or accepted (#3420): the stage by folded name, the won stage by kind, and the amount by an exact decimal compare.
import { describe, expect, it } from 'vitest';
import type { Deal, PipelineStage, QuoteSummary } from '@ludy/kernel-contract';
import { sameAmount, suggestDealOffers } from '../src/lib/quote-deal-suggest.ts';

const stage = (n: number, name: string, kind: PipelineStage['kind']): PipelineStage => ({ id: `00000000-0000-4000-8000-0000000002${n}0`, name, kind, position: n });
const DEFAULT = [stage(1, 'Mới', 'open'), stage(2, 'Đã liên hệ', 'open'), stage(3, 'Báo giá', 'open'), stage(4, 'Thương lượng', 'open'), stage(5, 'Thắng', 'won'), stage(6, 'Thua', 'lost')];
const deal = (over: Partial<Deal> = {}): Deal => ({ id: 'deal-1', stageId: DEFAULT[0]!.id, stageKind: 'open', amount: '1500000', ...over }) as Deal;
const quote = (over: Partial<QuoteSummary> = {}): QuoteSummary =>
  ({ id: 'quote-1', dealId: 'deal-1', number: 'BG-2026-0001', revision: 1, status: 'sent', expired: false, total: '1650000', updatedAt: '2026-11-15T02:00:00.000Z', ...over }) as QuoteSummary;

describe('the offers after a quote is sent (#3420)', () => {
  it('offers "Báo giá" to an open deal that sits before it, and the quote total when it differs', () => {
    const offers = suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [quote()] });
    expect(offers.move).toMatchObject({ to: 'quoted', quoteId: 'quote-1' });
    expect(offers.move?.stage.name).toBe('Báo giá');
    expect(offers.amount).toEqual({ quoteId: 'quote-1', total: '1650000' });
  });

  it('finds the stage by its name folded like the search: marks, case and spacing do not matter', () => {
    const renamed = DEFAULT.map((s) => (s.name === 'Báo giá' ? { ...s, name: '  BAO  GIA ' } : s));
    expect(suggestDealOffers({ deal: deal(), stages: renamed, quotes: [quote()] }).move?.stage.id).toBe(DEFAULT[2]!.id);
  });

  it('offers no move to a deal already at or past "Báo giá"', () => {
    for (const at of [DEFAULT[2]!, DEFAULT[3]!]) expect(suggestDealOffers({ deal: deal({ stageId: at.id }), stages: DEFAULT, quotes: [quote()] }).move).toBeNull();
  });

  it('offers no move to an org that renamed or removed the stage, nor to a closed deal', () => {
    const renamed = DEFAULT.map((s) => (s.name === 'Báo giá' ? { ...s, name: 'Đề xuất' } : s));
    expect(suggestDealOffers({ deal: deal(), stages: renamed, quotes: [quote()] }).move).toBeNull();
    expect(suggestDealOffers({ deal: deal(), stages: DEFAULT.filter((s) => s.name !== 'Báo giá'), quotes: [quote()] }).move).toBeNull();
    expect(suggestDealOffers({ deal: deal({ stageId: DEFAULT[5]!.id, stageKind: 'lost' }), stages: DEFAULT, quotes: [quote()] })).toEqual({ move: null, amount: null });
  });

  it('ignores a draft, a declined, a superseded and a lapsed sent quote, and the quotes of other deals', () => {
    for (const q of [quote({ status: 'draft' }), quote({ status: 'declined' }), quote({ status: 'superseded' }), quote({ expired: true }), quote({ dealId: 'deal-2' })]) {
      expect(suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [q] })).toEqual({ move: null, amount: null });
    }
  });

  it('offers no amount when the deal already holds the total, however it is written', () => {
    expect(suggestDealOffers({ deal: deal({ amount: '1650000.00' }), stages: DEFAULT, quotes: [quote()] }).amount).toBeNull();
    expect(suggestDealOffers({ deal: deal({ amount: '1650000' }), stages: DEFAULT, quotes: [quote({ total: '1650000.0000' })] }).amount).toBeNull();
  });

  it('does not offer a total the deal cannot hold (more than two decimals)', () => {
    expect(suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [quote({ total: '1650000.1234' })] }).amount).toBeNull();
  });

  it('takes the newest sent quote of the deal', () => {
    const older = quote({ id: 'quote-old', total: '100', updatedAt: '2026-11-10T02:00:00.000Z' });
    expect(suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [older, quote()] }).amount?.quoteId).toBe('quote-1');
  });
});

describe('the offers after a quote is accepted (#3420)', () => {
  const accepted = quote({ status: 'accepted' });

  it('offers the won stage, found by kind, whatever the org calls it', () => {
    const named = DEFAULT.map((s) => (s.kind === 'won' ? { ...s, name: 'Chốt đơn' } : s));
    const offers = suggestDealOffers({ deal: deal({ stageId: DEFAULT[2]!.id }), stages: named, quotes: [accepted] });
    expect(offers.move).toMatchObject({ to: 'won' });
    expect(offers.move?.stage.name).toBe('Chốt đơn');
  });

  it('speaks before a sent quote, and offers the amount too', () => {
    const offers = suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [quote({ id: 'quote-sent', total: '9' }), accepted] });
    expect(offers.move?.quoteId).toBe('quote-1');
    expect(offers.amount?.total).toBe('1650000');
  });

  it('offers nothing to a won or lost deal, and no move where the org has no won stage', () => {
    expect(suggestDealOffers({ deal: deal({ stageKind: 'won' }), stages: DEFAULT, quotes: [accepted] })).toEqual({ move: null, amount: null });
    const none = suggestDealOffers({ deal: deal(), stages: DEFAULT.filter((s) => s.kind !== 'won'), quotes: [accepted] });
    expect(none.move).toBeNull();
    expect(none.amount).not.toBeNull();
  });

  it('still offers after the quote lapsed: the customer said yes', () => {
    expect(suggestDealOffers({ deal: deal(), stages: DEFAULT, quotes: [quote({ status: 'accepted', expired: true })] }).move).toMatchObject({ to: 'won' });
  });
});

describe('the amount compare', () => {
  it('is exact on decimal strings and never throws', () => {
    expect(sameAmount('0.1', '0.10')).toBe(true);
    expect(sameAmount('1650000', '1650000.01')).toBe(false);
    expect(sameAmount('abc', '1')).toBe(false);
  });
});
