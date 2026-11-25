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
