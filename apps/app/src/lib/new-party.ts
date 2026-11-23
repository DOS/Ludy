// SPDX-License-Identifier: AGPL-3.0-only
// Adding a contact in the deal form (#3292): the phone pre-check. kernel.party.create refuses a tax code that already belongs
// to a contact but not a phone number, so before it runs the form reads the contacts that match the typed number (the Contacts
// screen's own search, which matches a phone by its key, so `0912 345 678` and `+84 912 345 678` are one number) and, when one
// has the same number, offers that contact instead of creating a second. This is a pre-check over a read query on the client: it
// adds no command, and two people adding the same number at once can still make two contacts, which the existing duplicate
// hints then flag. No browser or API imports, so it is unit tested.
import { phoneKey, type Contact, type FilterAst } from '@ludy/kernel-contract';

// What the pre-check needs of a contact.
export type PhoneHit = Pick<Contact, 'id' | 'name' | 'kind' | 'taxCode' | 'phone'>;

// A typed number the contacts search reads as a phone (at least four digits, nothing but digits and phone punctuation), the same shape modules/crm/src/contacts.ts tests.
const PHONE_TYPED = /^\s*\+?[0-9 ().-]{4,30}$/;

// The contacts search for a typed number, or null when the text is not a number the search can match by key.
export function phoneSearch(typed: string | null): FilterAst | null {
  if (typed === null || !PHONE_TYPED.test(typed) || phoneKey(typed) === null) return null;
  return { v: 1, all: [{ field: 'search', op: 'contains', value: typed.trim() }] };
}

// The first contact written with the same number: the search matches by the start of a key, so the whole key is compared here.
export function samePhone(typed: string, hits: readonly PhoneHit[]): PhoneHit | null {
  const key = phoneKey(typed);
  if (key === null) return null;
  return hits.find((hit) => phoneKey(hit.phone) === key) ?? null;
}

export type NewPartyResult<T> = { status: 'existing'; party: PhoneHit } | { status: 'created'; value: T };

// Checks the number, then creates. A match returns that contact and creates nothing; no match, no number, or a search that
// failed (the hint is a courtesy and must not stop a seller) creates; a refusal of the create (a tax code that is taken) reaches the caller untouched.
export async function resolveNewParty<T>(args: { phone: string | null; search: (filters: FilterAst) => Promise<readonly PhoneHit[]>; create: () => Promise<T> }): Promise<NewPartyResult<T>> {
  const filters = phoneSearch(args.phone);
  if (filters && args.phone !== null) {
    const hits = await args.search(filters).catch(() => []);
    const party = samePhone(args.phone, hits);
    if (party) return { status: 'existing', party };
  }
  return { status: 'created', value: await args.create() };
}
