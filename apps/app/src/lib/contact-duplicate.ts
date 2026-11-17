// SPDX-License-Identifier: AGPL-3.0-only
// The duplicate check of the add panel (docs/plan/crm.md, K4): while a person types an email, or a tax code for a company, the contacts
// search (the same read the list calls) is asked for it, and the contact that already carries exactly that email or tax code is shown
// under the field. The search is loose (a part of a word matches), so the answer is checked here against the whole value, the way
// the server compares: an email without regard to case, a tax code by its digits (`normalizeTaxCode`).
import { normalizeTaxCode, type Contact, type FilterAst } from '@crove/kernel-contract';

// What the check reads of a contact.
export type DuplicateHit = Pick<Contact, 'id' | 'kind' | 'name' | 'email' | 'taxCode'>;

export type DuplicateKey = { field: 'email'; value: string } | { field: 'taxCode'; value: string };

// The contacts search takes a value of at most this many characters (the filter's own limit); a longer one is not looked up.
export const SEARCH_VALUE_MAX = 100;

// The value to look up, or null when what is typed is not yet a whole email or tax code (no search goes out for a half-typed one).
export function duplicateKey(field: 'email' | 'taxCode', typed: string, isEmail: (value: string) => boolean): DuplicateKey | null {
  const value = typed.trim();
  if (value === '' || value.length > SEARCH_VALUE_MAX) return null;
  if (field === 'email') return isEmail(value) ? { field, value: value.toLowerCase() } : null;
  const tax = normalizeTaxCode(value);
  return tax ? { field, value: tax } : null;
}

// The contacts search for the key, over every kind: an email can sit on a company too, and the person is told so.
export function duplicateSearch(key: DuplicateKey): FilterAst {
  return { v: 1, all: [{ field: 'search', op: 'contains', value: key.value }] };
}

// The first contact among the search results that has exactly this email or tax code, or null.
export function findDuplicate(key: DuplicateKey, hits: readonly DuplicateHit[]): DuplicateHit | null {
  return (
    hits.find((hit) => {
      if (key.field === 'email') return hit.email?.trim().toLowerCase() === key.value;
      return hit.taxCode !== null && normalizeTaxCode(hit.taxCode) === key.value;
    }) ?? null
  );
}
