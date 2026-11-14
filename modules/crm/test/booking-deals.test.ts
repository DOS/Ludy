// SPDX-License-Identifier: AGPL-3.0-only
// Dy's suggestion of a deal for a booking (#3103): a fixed rule on the guest's contact, email and phone, never a model. The strongest reason comes first, then the most recently
// changed deal, then the id; at most three are offered; an address differs by case only and a number by its form only ("+84 901 234 567" is "0901234567"); a guest with no email and
// no phone (an erased one) and a deal of nobody they know give nothing.
import { describe, expect, it } from 'vitest';
import { BOOKING_DEAL_SUGGESTIONS_MAX } from '@crove/kernel-contract';
import { suggestDeals, type MatchBooking, type MatchDeal } from '../src/booking-deals.ts';

const deal = (id: string, over: Partial<MatchDeal> = {}): MatchDeal => ({
  id,
  title: `Cơ hội ${id}`,
  stage: 'Mới',
  partyId: `party-${id}`,
  partyEmail: null,
  partyPhone: null,
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const guest: MatchBooking = { partyId: 'party-guest', email: 'Khach@Example.test', phone: '+84 901 234 567' };
const reasons = (booking: MatchBooking, deals: MatchDeal[]) => suggestDeals(booking, deals).map((s) => [s.id, s.match]);

describe('the deals Dy suggests for a booking (#3103)', () => {
  it('matches the guest\'s contact, email (any case, any spaces around) and phone (+84 and 0 are one number)', () => {
    expect(reasons(guest, [deal('a', { partyId: 'party-guest' })])).toEqual([['a', 'contact']]);
    expect(reasons(guest, [deal('b', { partyEmail: '  KHACH@example.TEST ' })])).toEqual([['b', 'email']]);
    expect(reasons(guest, [deal('c', { partyPhone: '0901.234.567' })])).toEqual([['c', 'phone']]);
    expect(reasons(guest, [deal('d', { partyPhone: '0084 901 234 567' })])).toEqual([['d', 'phone']]);
    expect(reasons({ partyId: null, email: null, phone: '0901234567' }, [deal('e', { partyPhone: '+84901234567' })])).toEqual([['e', 'phone']]);
  });

  it('offers nothing for another person, an erased guest, or a number that only looks alike', () => {
    expect(reasons(guest, [deal('f', { partyEmail: 'khac@example.test', partyPhone: '0912345678' })])).toEqual([]);
    expect(reasons({ partyId: null, email: null, phone: null }, [deal('g', { partyEmail: 'khach@example.test', partyPhone: '0901234567' })])).toEqual([]);
    // Two people with no email of their own are not the same: an empty address and a missing number match nothing.
    expect(reasons({ partyId: null, email: '', phone: '' }, [deal('h', { partyEmail: '', partyPhone: '' })])).toEqual([]);
    expect(reasons(guest, [deal('i', { partyPhone: '0901234568' })])).toEqual([]);
  });

  it('puts the strongest reason first, then the most recently changed deal, then the id', () => {
    const deals = [
      deal('phone-new', { partyPhone: '0901234567', updatedAt: '2026-11-10T00:00:00.000Z' }),
      deal('email-old', { partyEmail: 'khach@example.test', updatedAt: '2026-10-01T00:00:00.000Z' }),
      deal('email-new', { partyEmail: 'khach@example.test', updatedAt: '2026-11-05T00:00:00.000Z' }),
      deal('contact', { partyId: 'party-guest', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(reasons(guest, deals).map(([id]) => id).slice(0, 3)).toEqual(['contact', 'email-new', 'email-old']);
    const tied = [deal('b', { partyEmail: 'khach@example.test' }), deal('a', { partyEmail: 'khach@example.test' })];
    expect(reasons(guest, tied).map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('offers at most three, and the order does not depend on the order the database answered in', () => {
    const deals = ['a', 'b', 'c', 'd', 'e'].map((id, i) => deal(id, { partyEmail: 'khach@example.test', updatedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
    const forward = suggestDeals(guest, deals).map((s) => s.id);
    expect(forward).toHaveLength(BOOKING_DEAL_SUGGESTIONS_MAX);
    expect(forward).toEqual(['e', 'd', 'c']);
    expect(suggestDeals(guest, [...deals].reverse()).map((s) => s.id)).toEqual(forward);
  });

  it('carries only what the screen shows: the id, the title, the stage and the reason', () => {
    const [s] = suggestDeals(guest, [deal('a', { partyEmail: 'khach@example.test', stage: 'Báo giá' })]);
    expect(s).toEqual({ id: 'a', title: 'Cơ hội a', stage: 'Báo giá', match: 'email' });
  });
});
