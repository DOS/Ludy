// SPDX-License-Identifier: AGPL-3.0-only
// The deal form keeps what was typed when the deal under it gets a newer version (#5015): the sheet used to remount the form
// on every version, which reset the inputs when the fresh read landed after the card's copy and let a save send the stale title.
import { describe, expect, it } from 'vitest';
import type { Deal, PartyChoice } from '@ludy/kernel-contract';
import { dealFormValues, newerDeal } from '../src/components/deal-form.tsx';

const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    version: 1,
    title: 'Tư vấn thuế',
    partyId: '00000000-0000-4000-8000-000000000010',
    partyName: 'Công ty ABC',
    amount: '1500000.00',
    expectedClose: '2026-12-01',
    ownerUserId: null,
    ...over,
  }) as unknown as Deal;

describe('dealFormValues', () => {
  it('shows the deal when nothing was typed, and follows a newer version', () => {
    expect(dealFormValues(deal(), null, {})).toMatchObject({ title: 'Tư vấn thuế', amount: '1500000', expectedClose: '2026-12-01', ownerUserId: '' });
    const newer = deal({ version: 2, title: 'Tư vấn thuế quý', amount: '2000000.00' });
    expect(dealFormValues(newer, null, {})).toMatchObject({ title: 'Tư vấn thuế quý', amount: '2000000' });
  });

  it('keeps a typed field when the version changes and lets the untouched fields move', () => {
    const edits = { title: 'Tư vấn thuế (đang sửa)' };
    const before = dealFormValues(deal(), null, edits);
    const after = dealFormValues(deal({ version: 2, title: 'Tên do người khác đổi', amount: '2000000.00' }), null, edits);
    expect(before.title).toBe('Tư vấn thuế (đang sửa)');
    expect(after.title).toBe('Tư vấn thuế (đang sửa)');
    expect(after.amount).toBe('2000000');
  });

  it('keeps an emptied field and a customer let go (null is an edit, not a missing one)', () => {
    const values = dealFormValues(deal(), null, { expectedClose: '', party: null });
    expect(values.expectedClose).toBe('');
    expect(values.party).toBeNull();
  });

  it('starts a new deal from the preset customer and the owner "me", and a typed pick wins over the preset', () => {
    const preset: PartyChoice = { id: '00000000-0000-4000-8000-000000000020', name: 'Preset', kind: 'organization', taxCode: null };
    const picked: PartyChoice = { ...preset, id: '00000000-0000-4000-8000-000000000021', name: 'Picked' };
    expect(dealFormValues(null, preset, {})).toMatchObject({ title: '', amount: '', ownerUserId: 'me', party: preset });
    expect(dealFormValues(null, preset, { party: picked }).party).toBe(picked);
  });
});

describe('newerDeal', () => {
  it('prefers the read when it is as new as the card, and the card when a cached read is older', () => {
    const card = deal({ version: 2, title: 'Mới' });
    expect(newerDeal(card, undefined)).toBe(card);
    expect(newerDeal(card, deal({ version: 1, title: 'Cũ' }))).toBe(card);
    const same = deal({ version: 2, title: 'Mới', amount: '2000000.00' });
    expect(newerDeal(card, same)).toBe(same);
    const later = deal({ version: 3 });
    expect(newerDeal(card, later)).toBe(later);
  });
});
