// SPDX-License-Identifier: AGPL-3.0-only
// The bank screen's clean group and the review page of matched lines (#2385): what asking for one clean line sends, the tags
// that say how a party was found, and how a batch's results read.
import { describe, expect, it } from 'vitest';
import type { BankMatchLine } from '@crove/kernel-contract';
import { matchedByTag, needsSecondApprover, reasonTag, summarizeApproval, voucherRequestOf } from '../src/lib/bank-groups.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

const line = (over: Partial<BankMatchLine> = {}): BankMatchLine => ({
  bankAccount: '1121',
  line: { id: '00000000-0000-4000-8000-000000000001', date: '2026-11-05', description: 'TT HD 123', amount: '-1980000', balance: null, reference: 'GR1', ambiguous: false, importId: '00000000-0000-4000-8000-000000000002', state: { status: 'open' } },
  voucher: { type: 'bank_debit', date: '2026-11-05', amount: '1980000', description: 'TT HD 123', counterAccount: '331' },
  suggested: { party: { id: '00000000-0000-4000-8000-000000000003', name: 'Công ty A', taxCode: '0100000000' }, reason: 'tax_code', invoice: { series: 'C26TAA', number: '123' } },
  candidates: [],
  group: 'clean',
  why: null,
  ...over,
});

describe('voucherRequestOf', () => {
  it('asks for the voucher the line makes, with the party and the invoice the matcher found', () => {
    expect(voucherRequestOf(line(), 'entity-1')).toEqual({
      type: 'bank_debit',
      date: '2026-11-05',
      cashAccount: '1121',
      partyId: '00000000-0000-4000-8000-000000000003',
      description: 'TT HD 123',
      lines: [{ account: '331', amount: '1980000' }],
      bankLineId: '00000000-0000-4000-8000-000000000001',
      matchedBy: { kind: 'vy', reason: 'tax_code', invoice: { series: 'C26TAA', number: '123' } },
      legalEntityId: 'entity-1',
    });
  });

  it('leaves the entity out when none is chosen, and the invoice out when the matcher named none', () => {
    const request = voucherRequestOf(line({ suggested: { party: { id: '00000000-0000-4000-8000-000000000003', name: 'A', taxCode: null }, reason: 'invoice' } }), undefined);
    expect(request).not.toBeNull();
    expect(request).not.toHaveProperty('legalEntityId');
    expect(request?.matchedBy).toEqual({ kind: 'vy', reason: 'invoice' });
  });

  it('asks for nothing for a line that is not clean, has no voucher or no party', () => {
    expect(voucherRequestOf(line({ group: 'look', why: 'several' }), undefined)).toBeNull();
    expect(voucherRequestOf(line({ voucher: null }), undefined)).toBeNull();
    expect(voucherRequestOf(line({ suggested: null }), undefined)).toBeNull();
  });
});

describe('reasonTag and matchedByTag', () => {
  it('says the tax code with its invoice, the tax code alone, the invoice, the name or the balance', () => {
    expect(reasonTag({ reason: 'tax_code', invoice: { number: '123' } })).toEqual({ tag: 'taxCodeInvoice', number: '123' });
    expect(reasonTag({ reason: 'tax_code' })).toEqual({ tag: 'taxCode', number: '' });
    expect(reasonTag({ reason: 'invoice', invoice: { number: '9' } })).toEqual({ tag: 'invoice', number: '9' });
    expect(reasonTag({ reason: 'name' }).tag).toBe('name');
    expect(reasonTag({ reason: 'balance' }).tag).toBe('balance');
    expect(reasonTag({}).tag).toBe('none');
  });

  it('shows the matcher with its reason, the person\'s own choice, or nothing known', () => {
    expect(matchedByTag({ kind: 'vy', reason: 'invoice', invoice: { series: 'C', number: '7' } })).toEqual({ tag: 'reason', reason: 'invoice', number: '7' });
    expect(matchedByTag({ kind: 'manual' })).toEqual({ tag: 'manual', number: '' });
    expect(matchedByTag(null)).toEqual({ tag: 'unknown', number: '' });
  });
});

describe('summarizeApproval', () => {
  it('counts what was approved and lists what the server refused, with its code', () => {
    const summary = summarizeApproval([
      { id: 'a', outcome: 'approved' },
      { id: 'b', outcome: 'refused', code: 'FOUR_EYES_REQUIRED', rule: 'P10' },
      { id: 'c', outcome: 'refused', code: 'PERIOD_LOCKED', rule: null },
    ]);
    expect(summary.approved).toBe(1);
    expect(summary.refused).toEqual([
      { id: 'b', code: 'FOUR_EYES_REQUIRED', rule: 'P10' },
      { id: 'c', code: 'PERIOD_LOCKED', rule: null },
    ]);
    expect(needsSecondApprover(summary)).toBe(true);
  });

  it('says a second approver is needed only for the refusals that mean it', () => {
    expect(needsSecondApprover(summarizeApproval([{ id: 'c', outcome: 'refused', code: 'PERIOD_LOCKED', rule: null }]))).toBe(false);
    expect(needsSecondApprover(summarizeApproval([{ id: 'a', outcome: 'approved' }]))).toBe(false);
    expect(needsSecondApprover(summarizeApproval([{ id: 'd', outcome: 'refused', code: 'NOT_ELIGIBLE', rule: 'P12' }]))).toBe(true);
  });
});

describe('the words', () => {
  it('has every reason, look-at-it and matched-by message in both languages', () => {
    for (const messages of [vi.bank.match, en.bank.match]) {
      for (const key of ['taxCodeInvoice', 'taxCode', 'invoice', 'name', 'balance', 'none'] as const) expect(messages.reason[key], key).toBeTruthy();
      for (const key of ['several', 'weak', 'no_invoice', 'duplicate'] as const) expect(messages.look[key], key).toBeTruthy();
      for (const key of ['unknown', 'manual'] as const) expect(messages.matchedBy[key], key).toBeTruthy();
    }
  });
});
