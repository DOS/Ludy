// SPDX-License-Identifier: AGPL-3.0-only
// The phone pre-check of the deal form's inline contact (#3292): a number already on a contact is offered instead of a second
// contact, whichever way it is written; no match, no number or a search that failed creates; the refusal of a taken tax code
// reaches the form and nothing is created or searched again.
import { describe, expect, it, vi } from 'vitest';
import { phoneSearch, resolveNewParty, samePhone, type PhoneHit } from '../src/lib/new-party.ts';

const hit = (id: string, phone: string | null, name = `Khách ${id}`): PhoneHit => ({ id, name, kind: 'person', taxCode: null, phone });

describe('phoneSearch', () => {
  it('asks the contacts search for a typed number, and for nothing else', () => {
    expect(phoneSearch('0912 345 678')).toEqual({ v: 1, all: [{ field: 'search', op: 'contains', value: '0912 345 678' }] });
    expect(phoneSearch(' +84 912 345 678 ')?.all[0]?.value).toBe('+84 912 345 678');
    expect(phoneSearch(null)).toBeNull();
    expect(phoneSearch('123')).toBeNull();
    expect(phoneSearch('gọi anh Nam')).toBeNull();
  });
});

describe('samePhone', () => {
  it('finds the contact with the same number written any way', () => {
    const hits = [hit('a', '0912345679'), hit('b', '+84 912 345 678')];
    expect(samePhone('0912 345 678', hits)?.id).toBe('b');
    expect(samePhone('84912345678', hits)?.id).toBe('b');
  });

  it('does not take a longer number that only starts the same, nor a contact with no number', () => {
    expect(samePhone('0912 345 678', [hit('a', '0912345678901'), hit('b', null)])).toBeNull();
    expect(samePhone('abc', [hit('a', '0912345678')])).toBeNull();
  });
});

describe('resolveNewParty', () => {
  const created = { partyId: 'new' };

  it('returns the existing contact on a match and creates nothing', async () => {
    const create = vi.fn(() => Promise.resolve(created));
    const search = vi.fn(() => Promise.resolve([hit('a', '0912 345 678', 'Nguyễn Văn A')]));
    const result = await resolveNewParty({ phone: '+84 912 345 678', search, create });
    expect(result).toMatchObject({ status: 'existing', party: { id: 'a', name: 'Nguyễn Văn A' } });
    expect(search).toHaveBeenCalledWith({ v: 1, all: [{ field: 'search', op: 'contains', value: '+84 912 345 678' }] });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates when no contact has the number', async () => {
    const create = vi.fn(() => Promise.resolve(created));
    const result = await resolveNewParty({ phone: '0912 345 678', search: () => Promise.resolve([hit('a', '0987 654 321')]), create });
    expect(result).toEqual({ status: 'created', value: created });
    expect(create).toHaveBeenCalledOnce();
  });

  it('creates without searching when there is no number to check', async () => {
    const create = vi.fn(() => Promise.resolve(created));
    const search = vi.fn(() => Promise.resolve([]));
    expect(await resolveNewParty({ phone: null, search, create })).toEqual({ status: 'created', value: created });
    expect(search).not.toHaveBeenCalled();
  });

  it('creates when the search is unavailable', async () => {
    const create = vi.fn(() => Promise.resolve(created));
    const result = await resolveNewParty({ phone: '0912 345 678', search: () => Promise.reject(new Error('down')), create });
    expect(result).toEqual({ status: 'created', value: created });
  });

  it('lets the refusal of a taken tax code through, after one search and one create', async () => {
    const refusal = Object.assign(new Error('Mã số thuế 0123456780 đã thuộc về Công ty Thuế'), { code: 'PARTY_TAX_CODE_TAKEN' });
    const create = vi.fn(() => Promise.reject(refusal));
    const search = vi.fn(() => Promise.resolve([]));
    await expect(resolveNewParty({ phone: '0912 345 678', search, create })).rejects.toBe(refusal);
    expect(search).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});
