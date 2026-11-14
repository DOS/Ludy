// SPDX-License-Identifier: AGPL-3.0-only
// Dy's suggestion of a deal for a booking (#3103, docs/plan/calendar.md "Deal links"). The rule is fixed and runs here, with no model: a booking that has no deal yet is
// offered the guest's open deals, found by the guest's contact (the booking's contact is the deal's contact), by email (the same address, compared without case) or by phone
// (the same number by phoneKey, so +84 and 0 are one number). Only deals in an open stage are offered; a person decides, and the suggestion changes nothing by itself.
import { BOOKING_DEAL_SUGGESTIONS_MAX, phoneKey, type BookingDealMatch, type BookingDealSuggestion } from '@crove/kernel-contract';
import { sql } from 'kysely';
import type { QueryContext } from '@crove/kernel-runtime';

// What of a booking the rule reads: its contact and the guest's own email and phone (null once an erasure cleared them).
export interface MatchBooking {
  partyId: string | null;
  email: string | null;
  phone: string | null;
}

// An open deal and its contact's email and phone.
export interface MatchDeal {
  id: string;
  title: string;
  stage: string;
  partyId: string;
  partyEmail: string | null;
  partyPhone: string | null;
  updatedAt: Date | string;
}

const emailKey = (email: string | null): string | null => {
  const key = email?.trim().toLowerCase() ?? '';
  return key === '' ? null : key;
};

// Why the deal fits the booking, the strongest reason first, or null.
export function matchOf(booking: MatchBooking, deal: MatchDeal): BookingDealMatch | null {
  if (booking.partyId !== null && booking.partyId === deal.partyId) return 'contact';
  const email = emailKey(booking.email);
  if (email !== null && email === emailKey(deal.partyEmail)) return 'email';
  const phone = phoneKey(booking.phone);
  if (phone !== null && phone === phoneKey(deal.partyPhone)) return 'phone';
  return null;
}

const RANK: Record<BookingDealMatch, number> = { contact: 0, email: 1, phone: 2 };

// The deals to offer for a booking: the fitting ones, strongest reason first, then the most recently changed, then by id (so the order never depends on the database's).
export function suggestDeals(booking: MatchBooking, deals: readonly MatchDeal[]): BookingDealSuggestion[] {
  const fitting = deals.flatMap((deal) => {
    const match = matchOf(booking, deal);
    return match === null ? [] : [{ deal, match }];
  });
  fitting.sort(
    (a, b) => RANK[a.match] - RANK[b.match] || new Date(b.deal.updatedAt).getTime() - new Date(a.deal.updatedAt).getTime() || (a.deal.id < b.deal.id ? -1 : a.deal.id > b.deal.id ? 1 : 0),
  );
  return fitting.slice(0, BOOKING_DEAL_SUGGESTIONS_MAX).map(({ deal, match }) => ({ id: deal.id, title: deal.title, stage: deal.stage, match }));
}

// The most open deals read for one page of bookings (the most recently changed first, so a page that names more than this loses the oldest); the rule keeps the best of them
// for each booking.
const CANDIDATES_MAX = 500;

// The open deals of the org that might fit any of these bookings, read once for the whole page: a deal whose contact is one of the bookings' contacts, or whose contact has
// one of their emails or phone keys.
export async function openDealsFor(ctx: Pick<QueryContext, 'trx' | 'orgId'>, bookings: readonly MatchBooking[]): Promise<MatchDeal[]> {
  const parties = [...new Set(bookings.flatMap((b) => (b.partyId === null ? [] : [b.partyId])))];
  const emails = [...new Set(bookings.flatMap((b) => emailKey(b.email) ?? []))];
  const phones = [...new Set(bookings.flatMap((b) => phoneKey(b.phone) ?? []))];
  if (parties.length === 0 && emails.length === 0 && phones.length === 0) return [];
  const rows = await ctx.trx
    .selectFrom('crove_crm.deal as d')
    .innerJoin('crove_kernel.party as p', (j) => j.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .innerJoin('crove_crm.pipeline_stage as s', (j) => j.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.stage_id'))
    .select(['d.id', 'd.title', 'd.party_id', 'd.updated_at', 's.name as stage', 'p.email as party_email', 'p.phone as party_phone'])
    .where('d.org_id', '=', ctx.orgId)
    .where('s.kind', '=', 'open')
    .where((eb) =>
      eb.or([
        ...(parties.length > 0 ? [eb('d.party_id', 'in', parties)] : []),
        // Trimmed as emailKey() trims, so a stored address with a stray space still fits.
        ...(emails.length > 0 ? [sql<boolean>`pg_catalog.lower(pg_catalog.btrim(p.email)) IN (${sql.join(emails)})`] : []),
        ...(phones.length > 0 ? [sql<boolean>`crove_kernel.phone_key(p.phone) IN (${sql.join(phones)})`] : []),
      ]),
    )
    .orderBy('d.updated_at', 'desc')
    .orderBy('d.id')
    .limit(CANDIDATES_MAX)
    .execute();
  return rows.map((r) => ({ id: r.id, title: r.title, stage: r.stage, partyId: r.party_id, partyEmail: r.party_email, partyPhone: r.party_phone, updatedAt: r.updated_at }));
}
