// SPDX-License-Identifier: AGPL-3.0-only
// Copying the previous invoice into the draft form by code (#2721): the lines follow a person's own, the cap holds and counts only what went in, the buyer is filled only while empty or still
// the buyer of the invoice copied before, and a rate the date no longer allows is reset to the default.
import { describe, expect, it } from 'vitest';
import { applyPrevious } from '../src/lib/invoice-copy.ts';

type Invoice = Parameters<typeof applyPrevious>[1];
const invoice = (n: number, patch: Partial<Invoice['lines'][number]> = {}, partyId = 'p1'): Invoice => ({
  draftId: 'd1',
  date: '2026-10-01',
  number: '12',
  buyer: { kind: 'business', partyId, taxCode: '0101234567', name: 'Công ty A', address: null, email: null, identity: null },
  lines: Array.from({ length: n }, (_, i) => ({ description: `Hàng ${i + 1}`, unit: null, quantity: '1', unitPrice: '1000', vatRate: '8%', vatAllowed: true, ...patch })),
});
const form = (lines: number, buyerPartyId: string | null = null) => ({
  draftId: null,
  buyerAi: false,
  date: '2026-11-01',
  seriesId: '',
  buyer: { kind: 'business' as const, partyId: buyerPartyId, taxCode: '', name: buyerPartyId ? 'Khách' : '', address: '', email: '', identityKind: '' as const, identity: '' },
  lines: Array.from({ length: lines }, (_, i) => ({ description: `Của tôi ${i + 1}`, unit: 'cái', quantity: '1', unitPrice: '5', vatRate: '10%', ai: null })),
});

describe('applyPrevious', () => {
  it('copies a buyer without the identity an individual gave on the invoice, and leaves the form with both identity fields as strings (#3678)', () => {
    const individual: Invoice = { ...invoice(1), buyer: { kind: 'individual', partyId: 'p1', taxCode: null, name: 'Nguyễn Văn A', address: null, email: null, identity: { kind: 'cccd', value: '012345678901' } } };
    const done = applyPrevious({ ...form(0), buyer: { ...form(0).buyer, kind: 'individual' as const } }, individual, null);
    expect(done.state.buyer).toMatchObject({ kind: 'individual', name: 'Nguyễn Văn A', identityKind: '', identity: '' });
    expect(JSON.stringify(done.state)).not.toContain('012345678901');
  });
  it('fills an empty buyer and replaces the blank line', () => {
    const done = applyPrevious(form(0), invoice(2), null);
    expect(done.state.lines.map((l) => l.description)).toEqual(['Hàng 1', 'Hàng 2']);
    expect(done.state.buyer.partyId).toBe('p1');
    expect(done).toMatchObject({ added: 2, rateChanged: 0 });
  });

  it('keeps a buyer the person chose, but replaces the one the last copy brought', () => {
    expect(applyPrevious(form(1, 'mine'), invoice(1, {}, 'p2'), 'p1').state.buyer.partyId).toBe('mine');
    expect(applyPrevious(form(1, 'p1'), invoice(1, {}, 'p2'), 'p1').state.buyer.partyId).toBe('p2');
  });

  it('counts only the lines that fit under the cap and only the reset rates among them', () => {
    const done = applyPrevious(form(199), invoice(5, { vatAllowed: false }), null);
    expect(done.state.lines).toHaveLength(200);
    expect(done).toMatchObject({ added: 1, rateChanged: 1 });
    expect(done.state.lines[199]?.vatRate).toBe('10%');
  });
});
