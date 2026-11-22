// SPDX-License-Identifier: AGPL-3.0-only
// The note on a pending marketplace settlement or payout proposal (#4389): the model is told WHICH things the proposal has and never an amount or an account code; the card shows the figures in a fixed
// text built in code; and any digit in the model's text refuses it, so a figure cannot be swapped or put beside the wrong account. The other refusals hold too: a number in words, a link, a platform's
// name, the future tense, a promise, a claim that something was done, advice on an account, a verdict, an order. Plain correct words are not refused.
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
};
const SETTLEMENT: MarketplaceProposalNoteFacts = { language: 'en', kind: 'settlement', figures: { sales: '350000', refund: '10000', sellerDiscount: '15000' }, lineKinds: [] };
const note = (facts: MarketplaceProposalNoteFacts, text: string) => checkMarketplaceProposalNote(facts, { note: text });
const REFUSED = { kind: 'none', code: 'REFUSED' };

describe('what the model is told', () => {
  it('names the things the proposal has and the classified kinds, with no amount, no account code and no digit at all', () => {
    const text = marketplaceProposalNoteFactsText(PAYOUT);
    expect(text).toContain('fees the platform kept');
    expect(text).toContain('tax the platform withheld for the seller');
    expect(text).toContain('Lines a person classified: incentive (other income)');
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('received');
    expect(marketplaceProposalNoteFactsText(SETTLEMENT)).toContain('sales of the settlement; the seller\'s own discounts; refunds to buyers');
    expect(marketplaceProposalNoteFactsText(SETTLEMENT)).toContain('Lines a person classified: none');
    expect(marketplaceProposalNoteFactsText(SETTLEMENT)).not.toMatch(/\d/);
  });

  it('is the same for two proposals that differ only in their amounts, so one note serves both', () => {
    expect(marketplaceProposalNoteFactsText({ ...PAYOUT, figures: { ...PAYOUT.figures, fees: '29000' } })).toBe(marketplaceProposalNoteFactsText(PAYOUT));
  });

  it('says nothing to a proposal with no figure above zero', () => {
    expect(marketplaceProposalNoteHasNews({ figures: {} })).toBe(false);
    expect(marketplaceProposalNoteHasNews(PAYOUT)).toBe(true);
  });

  it('tells the model to write no digit, to refer to the figures on the screen, and not to pick an account', () => {
    const rules = marketplaceProposalNoteInstructions('vi');
    expect(rules).toContain('Write NO digit at all');
    expect(rules).toContain('Never tell the approver which account to use');
    expect(rules).toContain('Write no name of any platform');
  });
});

describe('the figures text shown with the note', () => {
  it('holds every figure in fixed Vietnamese and English wording, built in code', () => {
    expect(marketplaceProposalNoteTemplate(PAYOUT)).toBe(
      'Sàn đã trả: 304.000 đồng; phí sàn giữ lại (331): 28.000 đồng; thuế sàn đã giữ lại: 3.000 đồng; khoản thưởng đã phân loại: 6.000 đồng. Bút toán ghi tiền nhận về và bù trừ khoản phải thu từ sàn.',
    );
    expect(marketplaceProposalNoteTemplate(SETTLEMENT)).toBe('Sales of the settlement: 350,000 dong; refunds to buyers: 10,000 dong; the seller\'s own discounts: 15,000 dong. The entry records the sales and the amount receivable from the platform.');
  });
});

describe('the checks on the text the model gives', () => {
  it('keeps a short plain text with no digit', () => {
    const text = 'Sàn giữ lại phí và thuế trước khi chuyển tiền, và khoản thưởng được phân loại là thu nhập khác. Xem các con số và dòng bút toán bên cạnh.';
    expect(note(PAYOUT, text)).toEqual({ kind: 'note', text });
  });

  it('refuses an empty answer with its own code', () => {
    expect(checkMarketplaceProposalNote(PAYOUT, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(note(PAYOUT, '   ')).toEqual({ kind: 'none', code: 'EMPTY' });
  });

  it('refuses any digit, whatever it says: the amounts and account codes are on the screen, not in the note', () => {
    const refused = [
      'Sàn giữ lại phí 28.000 đồng.', // an amount that is given
      'Sàn giữ lại phí 29.000 đồng.', // an amount that is not
      'Khoản thưởng 6.000 đồng ghi giảm giá vốn (632).', // the wrong account named as a kind
      'Phí 28.000 đồng ghi vào thuế (3331).',
      'Thuế 3.000 đồng ghi vào phí sàn (331).',
      'Tax of 3,000 dong is a fee (331).',
      'Fees of 28,000 dong, booked as tax (3331).',
      'Phí được ghi vào tài khoản 331.', // an account code alone
      'Bút toán ghi 1 khoản phí.', // a bare digit
      'Phí sàn giữ lại ٢٨ nghìn.', // an Arabic-Indic digit
      'Phí sàn giữ lại २८ nghìn.', // a Devanagari digit
      'Phí sàn giữ lại ２８ nghìn.', // full-width digits
    ];
    for (const text of refused) expect(note(PAYOUT, text), text).toEqual(REFUSED);
  });

  it('refuses every other unsafe text as a whole', () => {
    const refused = [
      'Sàn giữ lại hai mươi tám nghìn đồng phí.', // a number in words
      'Sàn giữ lại 28 nghìn đồng phí.', // scaled
      'Hai khoản phí do sàn giữ lại.', // a count in words
      'Sàn giữ lại phí, xem https://example.com.', // a link
      'Sàn giữ lại phí. Thuế đã giữ. Thưởng đã phân loại. Tiền đã về.', // four sentences
      'Shopee giữ lại phí.', // a platform's name
      'Bút toán sẽ ghi phí sàn giữ lại.', // future
      'The fees will be posted.', // future, English
      'Phí sàn giữ lại chắc chắn đúng.', // a promise
      'Đã ghi sổ phí sàn giữ lại.', // done
      'The fees were posted.', // done, English
      'Nên chuyển phí sang tài khoản khác.', // advice on an account
      'You should use another account for the fees.', // advice, English
      'Đề xuất này an toàn để duyệt.', // a verdict
      'Bạn có thể duyệt đề xuất này.', // bare approve
      'Approve it: the fees are fine.', // bare approve, English
      'Hãy xem lại phí sàn giữ lại.', // an order
      'Please review the fees the platform kept.', // an order, English
      'Phí sàn giữ lại 😀.', // a pictograph
      'Phí sàn giữ lại ①.', // a numeric symbol
      'Phí sàn giữ lại хорошо.', // another script
      `Phí sàn giữ lại ${'x'.repeat(500)}.`, // too long
    ];
    for (const text of refused) expect(note(PAYOUT, text), text).toEqual(REFUSED);
  });

  it('keeps correct plain texts that older word lists refused by mistake', () => {
    const kept = [
      'Đối soát của nền tảng: sàn giữ lại phí và thuế.', // "đối soát", "nền tảng"
      'Bồi thường vận chuyển được phân loại riêng, xem dòng bút toán bên cạnh.', // "bồi thường" is not "thưởng"
      'Phần bồi thường vượt giá vốn được ghi là thu nhập khác.', // "vượt giá vốn"
      'Đề xuất đang chờ duyệt, so sánh phí với các dòng bút toán.', // awaiting approval
      'Khoản phí sàn giữ lại hay thuế đều nằm trong bút toán, đây là lựa chọn của kế toán.', // "hay" (or), "lựa chọn"
      'The proposal is awaiting approval and records the fees the platform kept.',
      'The entry records the sales and the amount receivable from the platform.',
    ];
    for (const text of kept) expect(note(PAYOUT, text), text).toEqual({ kind: 'note', text });
  });
});
