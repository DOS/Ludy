// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Slice 6d Vy depositProposal extraction grounding and signDepositMatchSentence non-PII guardrails (#4723).
import { describe, expect, it } from 'vitest';
import {
  checkSignDepositMatchSentence,
  checkSignObligationExtract,
  signDepositMatchFactsText,
  type SignObligationExtractRequest,
} from '../src/index.ts';

describe('Vy depositProposal extraction checks (#4723)', () => {
  const requestWithVndDeposit: SignObligationExtractRequest = {
    envelopeTitle: 'Hợp đồng thiết kế nội thất',
    pageCount: 2,
    pages: [
      {
        page: 1,
        text: [
          'Bên B: Công ty TNHH An Phát',
          'Điều 3. Tiền đặt cọc: Bên B đặt cọc 15.000.000 VND trong vòng 5 ngày sau khi ký hợp đồng.',
        ].join('\n'),
      },
      {
        page: 2,
        text: 'Tổng giá trị hợp đồng là 60.000.000 VND.',
      },
    ],
  };

  it('keeps a grounded VND depositProposal with verified quote and dueDays', () => {
    const res = checkSignObligationExtract(requestWithVndDeposit, {
      counterpartyName: 'Công ty TNHH An Phát',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: '60000000',
      currency: 'VND',
      citations: [
        { field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Bên B: Công ty TNHH An Phát' },
        { field: 'contractValue', pageNumber: 2, quoteExcerpt: 'Tổng giá trị hợp đồng là 60.000.000 VND.' },
      ],
      obligations: [],
      depositProposal: {
        amount: '15000000',
        dueDays: 5,
        pageNumber: 1,
        quoteExcerpt: 'Bên B đặt cọc 15.000.000 VND trong vòng 5 ngày sau khi ký hợp đồng.',
      },
    });
    expect(res.kind).toBe('proposal');
    expect(res.proposal?.depositProposal).toEqual({
      amount: '15000000',
      currency: 'VND',
      dueDays: 5,
      pageNumber: 1,
      quoteExcerpt: 'Bên B đặt cọc 15.000.000 VND trong vòng 5 ngày sau khi ký hợp đồng.',
      proposedByAi: true,
    });
  });

  it('drops ungrounded deposit amount or foreign currency deposit while preserving other valid citations', () => {
    const foreignReq: SignObligationExtractRequest = {
      envelopeTitle: 'Service Agreement',
      pageCount: 1,
      pages: [
        {
          page: 1,
          text: 'Client: Acme LLC. Retainer deposit is USD 1,000 payable in 7 days.',
        },
      ],
    };
    const res = checkSignObligationExtract(foreignReq, {
      counterpartyName: 'Acme LLC',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'USD',
      citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Client: Acme LLC' }],
      obligations: [],
      depositProposal: {
        amount: '1000',
        dueDays: 7,
        pageNumber: 1,
        quoteExcerpt: 'Retainer deposit is USD 1,000 payable in 7 days.',
      },
    });
    expect(res.kind).toBe('proposal');
    expect(res.proposal?.depositProposal).toBeUndefined();
    expect(res.droppedCount).toBe(1);
  });

  it('requires integer VND, rejects duration/percent unit collisions, and enforces local VND currency spans (#4723)', () => {
    const viDurationReq: SignObligationExtractRequest = {
      envelopeTitle: 'Hop dong dat coc',
      pageCount: 1,
      pages: [{ page: 1, text: 'Ben B: Cong ty ABC\nDat coc 5.000.000 VND trong vong 5 ngay.' }],
    };
    const viOk = checkSignObligationExtract(viDurationReq, {
      counterpartyName: 'Cong ty ABC',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'VND',
      citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Ben B: Cong ty ABC' }],
      obligations: [],
      depositProposal: {
        amount: '5000000',
        dueDays: 5,
        pageNumber: 1,
        quoteExcerpt: 'Dat coc 5.000.000 VND trong vong 5 ngay.',
      },
    });
    expect(viOk.proposal?.depositProposal?.amount).toBe('5000000');

    const enDurationReq: SignObligationExtractRequest = {
      envelopeTitle: 'Deposit agreement',
      pageCount: 1,
      pages: [{ page: 1, text: 'Party B: ABC Co\nDeposit: 5000000 VND, due in 5 days.' }],
    };
    const enOk = checkSignObligationExtract(enDurationReq, {
      counterpartyName: 'ABC Co',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'VND',
      citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Party B: ABC Co' }],
      obligations: [],
      depositProposal: {
        amount: '5000000',
        dueDays: 5,
        pageNumber: 1,
        quoteExcerpt: 'Deposit: 5000000 VND, due in 5 days.',
      },
    });
    expect(enOk.proposal?.depositProposal?.amount).toBe('5000000');

    // Duration token "5 days" or "5 ngay" must never pass as deposit amount "5"
    for (const [req, quote] of [
      [viDurationReq, 'Dat coc 5.000.000 VND trong vong 5 ngay.'],
      [enDurationReq, 'Deposit: 5000000 VND, due in 5 days.'],
    ] as const) {
      const bogusDays = checkSignObligationExtract(req, {
        counterpartyName: req === viDurationReq ? 'Cong ty ABC' : 'ABC Co',
        effectiveDate: null,
        expiryDate: null,
        renewalNoticeDays: null,
        autoRenew: false,
        contractValue: null,
        currency: 'VND',
        citations: [
          {
            field: 'counterpartyName',
            pageNumber: 1,
            quoteExcerpt: req === viDurationReq ? 'Ben B: Cong ty ABC' : 'Party B: ABC Co',
          },
        ],
        obligations: [],
        depositProposal: {
          amount: '5',
          dueDays: 5,
          pageNumber: 1,
          quoteExcerpt: quote,
        },
      });
      expect(bogusDays.proposal?.depositProposal).toBeUndefined();
    }

    // Fractional VND deposit is rejected
    const fracReq: SignObligationExtractRequest = {
      envelopeTitle: 'Hop dong le',
      pageCount: 1,
      pages: [{ page: 1, text: 'Ben B: Cong ty ABC\nDat coc 5000000.50 VND.' }],
    };
    const fracRes = checkSignObligationExtract(fracReq, {
      counterpartyName: 'Cong ty ABC',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'VND',
      citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Ben B: Cong ty ABC' }],
      obligations: [],
      depositProposal: {
        amount: '5000000.50',
        dueDays: null,
        pageNumber: 1,
        quoteExcerpt: 'Dat coc 5000000.50 VND.',
      },
    });
    expect(fracRes.proposal?.depositProposal).toBeUndefined();

    // Percentage token "5%" cannot pass as deposit amount "5"
    const pctReq: SignObligationExtractRequest = {
      envelopeTitle: 'Hop dong dat coc phan tram',
      pageCount: 1,
      pages: [{ page: 1, text: 'Ben B: Cong ty ABC\nDat coc 5% gia tri trong 5 ngay.' }],
    };
    const pctRes = checkSignObligationExtract(pctReq, {
      counterpartyName: 'Cong ty ABC',
      effectiveDate: null,
      expiryDate: null,
      renewalNoticeDays: null,
      autoRenew: false,
      contractValue: null,
      currency: 'VND',
      citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: 'Ben B: Cong ty ABC' }],
      obligations: [],
      depositProposal: {
        amount: '5',
        dueDays: 5,
        pageNumber: 1,
        quoteExcerpt: 'Dat coc 5% gia tri trong 5 ngay.',
      },
    });
    expect(pctRes.proposal?.depositProposal).toBeUndefined();
  });

  it('grounds scale-word deposit expressions (million/triệu/tr/m/k/ty) while rejecting unscaled base tokens (#4723)', () => {
    const scaleCases = [
      {
        text: 'Party B: ABC Co\nDeposit: 5 million VND.',
        counterparty: 'ABC Co',
        counterpartyQuote: 'Party B: ABC Co',
        quote: 'Deposit: 5 million VND.',
        expectedAmount: '5000000',
        rejectedUnscaled: '5',
      },
      {
        text: 'Bên B: Công ty ABC\nĐặt cọc 5 triệu VNĐ',
        counterparty: 'Công ty ABC',
        counterpartyQuote: 'Bên B: Công ty ABC',
        quote: 'Đặt cọc 5 triệu VNĐ',
        expectedAmount: '5000000',
        rejectedUnscaled: '5',
      },
      {
        text: 'Bên B: Công ty ABC\nĐặt cọc 5tr VNĐ trước bàn giao.',
        counterparty: 'Công ty ABC',
        counterpartyQuote: 'Bên B: Công ty ABC',
        quote: 'Đặt cọc 5tr VNĐ trước bàn giao.',
        expectedAmount: '5000000',
        rejectedUnscaled: '5',
      },
      {
        text: 'Party B: ABC Co\nDeposit: 5m VND.',
        counterparty: 'ABC Co',
        counterpartyQuote: 'Party B: ABC Co',
        quote: 'Deposit: 5m VND.',
        expectedAmount: '5000000',
        rejectedUnscaled: '5',
      },
      {
        text: 'Bên B: Công ty ABC\nĐặt cọc 500k VNĐ.',
        counterparty: 'Công ty ABC',
        counterpartyQuote: 'Bên B: Công ty ABC',
        quote: 'Đặt cọc 500k VNĐ.',
        expectedAmount: '500000',
        rejectedUnscaled: '500',
      },
      {
        text: 'Bên B: Công ty ABC\nĐặt cọc 2 ty VND.',
        counterparty: 'Công ty ABC',
        counterpartyQuote: 'Bên B: Công ty ABC',
        quote: 'Đặt cọc 2 ty VND.',
        expectedAmount: '2000000000',
        rejectedUnscaled: '2',
      },
    ] as const;

    for (const item of scaleCases) {
      const req: SignObligationExtractRequest = {
        envelopeTitle: 'Scale deposit test',
        pageCount: 1,
        pages: [{ page: 1, text: item.text }],
      };
      const ok = checkSignObligationExtract(req, {
        counterpartyName: item.counterparty,
        effectiveDate: null,
        expiryDate: null,
        renewalNoticeDays: null,
        autoRenew: false,
        contractValue: null,
        currency: 'VND',
        citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: item.counterpartyQuote }],
        obligations: [],
        depositProposal: {
          amount: item.expectedAmount,
          dueDays: null,
          pageNumber: 1,
          quoteExcerpt: item.quote,
        },
      });
      expect(ok.proposal?.depositProposal?.amount, item.quote).toBe(item.expectedAmount);

      const unscaled = checkSignObligationExtract(req, {
        counterpartyName: item.counterparty,
        effectiveDate: null,
        expiryDate: null,
        renewalNoticeDays: null,
        autoRenew: false,
        contractValue: null,
        currency: 'VND',
        citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: item.counterpartyQuote }],
        obligations: [],
        depositProposal: {
          amount: item.rejectedUnscaled,
          dueDays: null,
          pageNumber: 1,
          quoteExcerpt: item.quote,
        },
      });
      expect(unscaled.proposal?.depositProposal, item.quote).toBeUndefined();
    }
  });

  it('enforces numeric boundaries on deposit quote matching so substring digits (5000000 inside 15000000 or 000.000 inside 15.000.000) fail (#4723)', () => {
    const boundaryCases = [
      {
        name: 'rejects substring digits 5000000 inside 15000000',
        text: 'Party B: ABC Co\nDeposit: 15000000 VND.',
        quote: '5000000 VND.',
        amount: '5000000',
        expectedAccepted: false,
      },
      {
        name: 'rejects grouping-prefix truncation 000.000 inside 15.000.000',
        text: 'Ben B: ABC Co\nDat coc 15.000.000 VND.',
        quote: '000.000 VND.',
        amount: '000',
        expectedAccepted: false,
      },
      {
        name: 'accepts exact boundary 5000000 VND',
        text: 'Party B: ABC Co\nDeposit: 5000000 VND.',
        quote: '5000000 VND',
        amount: '5000000',
        expectedAccepted: true,
      },
      {
        name: 'accepts exact boundary occurrence later on page containing 15000000 VND',
        text: 'Party B: ABC Co\nTotal: 15000000 VND.\nDeposit: 5000000 VND.',
        quote: '5000000 VND',
        amount: '5000000',
        expectedAccepted: true,
      },
    ] as const;

    for (const tc of boundaryCases) {
      const req: SignObligationExtractRequest = {
        envelopeTitle: tc.name,
        pageCount: 1,
        pages: [{ page: 1, text: tc.text }],
      };
      const res = checkSignObligationExtract(req, {
        counterpartyName: 'ABC Co',
        effectiveDate: null,
        expiryDate: null,
        renewalNoticeDays: null,
        autoRenew: false,
        contractValue: null,
        currency: 'VND',
        citations: [{ field: 'counterpartyName', pageNumber: 1, quoteExcerpt: tc.text.split('\n')[0]! }],
        obligations: [],
        depositProposal: {
          amount: tc.amount,
          dueDays: null,
          pageNumber: 1,
          quoteExcerpt: tc.quote,
        },
      });
      if (tc.expectedAccepted) {
        expect(res.proposal?.depositProposal?.amount, tc.name).toBe(tc.amount);
      } else {
        expect(res.proposal?.depositProposal, tc.name).toBeUndefined();
      }
    }
  });
});

describe('checkSignDepositMatchSentence (#4723)', () => {
  const facts = {
    date: '2026-11-24',
    amount: '5000000',
    memoToken: 'CK-A7B9C2',
    hasSignerNotice: true,
    language: 'vi' as const,
  };

  it('exposes strictly non-PII facts text (no person or company fields)', () => {
    const text = signDepositMatchFactsText(facts);
    expect(text).toContain('2026-11-24');
    expect(text).toContain('CK-A7B9C2');
    expect(text).toContain('5.000.000');
  });

  it('accepts one grounded Vietnamese sentence naming exact amount and CK token without claiming completion', () => {
    const res = checkSignDepositMatchSentence(facts, {
      sentence:
        'Khoản thu ngày 2026-11-24 số tiền 5.000.000 đồng mang mã CK-A7B9C2, có thông báo chuyển khoản từ người ký.',
    });
    expect(res).toEqual({
      kind: 'sentence',
      text: 'Khoản thu ngày 2026-11-24 số tiền 5.000.000 đồng mang mã CK-A7B9C2, có thông báo chuyển khoản từ người ký.',
    });
  });

  it('refuses sentences that claim already posted/paid, omit memoToken, exceed one sentence, or invent numbers', () => {
    expect(
      checkSignDepositMatchSentence(facts, {
        sentence: 'Khoản cọc CK-A7B9C2 ngày 2026-11-24 số tiền 5.000.000 đồng đã hạch toán xong.',
      }).kind,
    ).toBe('none');

    expect(
      checkSignDepositMatchSentence(facts, {
        sentence: 'Khoản thu 5.000.000 đồng có thể khớp.',
      }).kind,
    ).toBe('none');

    expect(
      checkSignDepositMatchSentence(facts, {
        sentence: 'Câu một CK-A7B9C2 5.000.000 đồng. Câu hai thừa.',
      }).kind,
    ).toBe('none');

    expect(
      checkSignDepositMatchSentence(facts, {
        sentence: 'Khoản thu CK-A7B9C2 số tiền 9.999.000 đồng ngày 2026-11-24.',
      }).kind,
    ).toBe('none');
  });
});
