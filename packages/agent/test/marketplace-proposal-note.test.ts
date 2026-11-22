// SPDX-License-Identifier: AGPL-3.0-only
// The note on a pending marketplace settlement or payout proposal (#4389): the facts the model is told (whole dong, closed kinds, no platform or id), the template shown with no model, and the checks that
// refuse a text as a whole: a number that is not given, a number in words, a link, a platform's name, the future tense, a promise, a claim that something was done, advice on an account, too many sentences.
import { describe, expect, it } from 'vitest';
import {
  checkMarketplaceProposalNote,
  marketplaceProposalNoteFactsText,
  marketplaceProposalNoteHasNews,
  marketplaceProposalNoteInstructions,
  marketplaceProposalNoteTemplate,
  type MarketplaceProposalNoteFacts,
} from '../src/index.ts';

const PAYOUT: MarketplaceProposalNoteFacts = {
  language: 'vi',
  kind: 'payout',
  figures: { received: '304000', fees: '28000', taxWithheld: '3000', incentive: '6000' },
  lineKinds: ['incentive'],
  accounts: ['1121', '331', '3331', '3335', '131', '711'],
};
const SETTLEMENT: MarketplaceProposalNoteFacts = { language: 'en', kind: 'settlement', figures: { sales: '350000', refund: '10000', sellerDiscount: '15000' }, lineKinds: [], accounts: ['131', '5111'] };
const note = (facts: MarketplaceProposalNoteFacts, text: string) => checkMarketplaceProposalNote(facts, { note: text });

describe('the facts of the proposal note', () => {
  it('tell only figures above zero, whole dong with the language grouping, the classified kinds and the accounts of the entry', () => {
    const text = marketplaceProposalNoteFactsText(PAYOUT);
    expect(text).toContain('fees the platform kept (account 331): 28.000 đồng');
    expect(text).toContain('amount from the platform: 304.000 đồng');
    expect(text).not.toContain('received');
    expect(text).toContain('Lines a person classified: incentive (other income)');
    expect(text).toContain('Accounts of the entry: 1121, 331, 3331, 3335, 131, 711');
    expect(text).not.toContain('carrier compensation classified');
    expect(marketplaceProposalNoteFactsText(SETTLEMENT)).toContain('sales of the settlement: 350,000 dong');
    expect(marketplaceProposalNoteFactsText(SETTLEMENT)).toContain('Lines a person classified: none');
  });

  it('ignore an account that is not 3 to 5 digits, and say nothing to a proposal with no figure', () => {
    expect(marketplaceProposalNoteFactsText({ ...PAYOUT, accounts: ['331', 'Shopee', '12'] })).toContain('Accounts of the entry: 331');
    expect(marketplaceProposalNoteHasNews({ figures: {} })).toBe(false);
    expect(marketplaceProposalNoteHasNews(PAYOUT)).toBe(true);
  });

  it('tell the model not to pick an account, and to use no platform name', () => {
    const rules = marketplaceProposalNoteInstructions('vi');
    expect(rules).toContain('Never tell the approver which account to use');
    expect(rules).toContain('Write no name of any platform');
  });
});

describe('the template shown with no model', () => {
  it('holds the same figures in fixed Vietnamese and English wording, and nothing a model could change', () => {
    expect(marketplaceProposalNoteTemplate(PAYOUT)).toBe(
      'Sàn đã trả: 304.000 đồng; phí sàn giữ lại (331): 28.000 đồng; thuế sàn đã giữ lại: 3.000 đồng; khoản thưởng đã phân loại: 6.000 đồng. Bút toán ghi tiền nhận về và bù trừ khoản phải thu từ sàn.',
    );
    expect(marketplaceProposalNoteTemplate(SETTLEMENT)).toBe('Sales of the settlement: 350,000 dong; refunds to buyers: 10,000 dong; the seller\'s own discounts: 15,000 dong. The entry records the sales and the amount receivable from the platform.');
  });
});

describe('the checks on the text the model gives', () => {
  it('keeps a short plain text that states only the given figures and account codes', () => {
    const text = 'Sàn giữ lại phí 28.000 đồng (331) và thuế 3.000 đồng, khoản thưởng 6.000 đồng thuộc loại thu nhập khác. Bút toán ghi nhận 304.000 đồng tiền nhận về.';
    expect(note(PAYOUT, text)).toEqual({ kind: 'note', text });
  });

  it('refuses an empty answer with its own code, and every unsafe text with REFUSED', () => {
    expect(checkMarketplaceProposalNote(PAYOUT, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(note(PAYOUT, '   ')).toEqual({ kind: 'none', code: 'EMPTY' });
    const refused = [
      'Sàn giữ lại phí 29.000 đồng.', // a figure that is not given
      'Sàn giữ lại phí 28 nghìn đồng.', // scaled
      'Sàn giữ lại hai mươi tám nghìn đồng phí.', // in words
      'Sàn giữ lại phí 28.000 đồng, xem https://example.com.', // a link
      'Sàn giữ lại phí 28.000 đồng. Tiền nhận 304.000 đồng. Thuế 3.000 đồng. Thưởng 6.000 đồng.', // four sentences
      'Shopee giữ lại phí 28.000 đồng.', // a platform's name
      'Bút toán sẽ ghi phí 28.000 đồng.', // future
      'Fees of 28.000 will be posted.', // future, English
      'Phí 28.000 đồng chắc chắn đúng.', // a promise
      'Đã ghi sổ phí 28.000 đồng.', // done
      'The fees of 28.000 dong were posted.', // done, English
      'Nên chuyển phí 28.000 đồng sang tài khoản 6421.', // advice on an account
      'You should use account 711 for 6.000 dong.', // advice, English
      'Đề xuất này an toàn để duyệt, phí 28.000 đồng.', // a verdict
      'Phí 28.000 đồng 😀.', // a pictograph
      'Phí 28.000 đồng ①.', // a numeric symbol
      'Sàn giữ lại phí 304.000 đồng và thuế 28.000 đồng.', // right figures, swapped labels
      'Khoản thưởng 6.000 đồng ghi vào 632.', // an account of another kind
      'Hãy xem lại phí 28.000 đồng.', // an order to the approver
      'Please review the fees of 28,000 dong.', // an order, English
      'Bạn có thể duyệt, phí 28.000 đồng.', // bare approve
      'Approve it: fees of 28.000 dong.', // bare approve, English
      'Phí 28.000 đồng хорошо.', // another script
      `Phí 28.000 đồng ${'x'.repeat(500)}.`, // too long
    ];
    for (const text of refused) expect(note(PAYOUT, text), text).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it('does not refuse a text only because it holds "đối soát" or "nền tảng"', () => {
    const text = 'Đối soát của nền tảng: sàn giữ lại phí 28.000 đồng (331).';
    expect(note(PAYOUT, text)).toEqual({ kind: 'note', text });
  });

  it('keeps a text whose amounts and accounts stand beside their own words, and refuses one whose do not', () => {
    const ok = 'Sàn trả 304.000 đồng (1121), giữ lại phí 28.000 đồng (331) và thuế 3.000 đồng (3331).';
    expect(note(PAYOUT, ok)).toEqual({ kind: 'note', text: ok });
    expect(note(PAYOUT, 'Sàn giữ lại phí 28.000 đồng (131).')).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(note(PAYOUT, 'Thuế 3.000 đồng nằm ở 331.')).toEqual({ kind: 'none', code: 'REFUSED' });
  });

  it('refuses an account code that the entry does not hold, and a figure of the other kind', () => {
    expect(note(PAYOUT, 'Phí 28.000 đồng nằm ở tài khoản 6421.')).toEqual({ kind: 'none', code: 'REFUSED' });
    expect(note(PAYOUT, 'Doanh thu 350.000 đồng.')).toEqual({ kind: 'none', code: 'REFUSED' });
  });
});
