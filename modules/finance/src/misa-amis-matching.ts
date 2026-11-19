// SPDX-License-Identifier: AGPL-3.0-only
// The matching of a connection's vouchers against the firm's own MISA catalogue (#4112, S3a of #4103), pure: no database, no network. A party is looked up by its tax code ONLY (never by name), an item by its
// exact code; one active catalogue entry is `matched`, none is `unknown`, several are `ambiguous` and nothing picks one. The catalogue's names, addresses and tax codes are read here and go no further: what a
// caller keeps is the matched entry's code and id. The check itself (request, record, results) is misa-amis-match.ts.
import type { MisaAmisMatchResult } from '@crove/kernel-contract';

/** A party's tax code as the catalogue and the vouchers compare it: digits only, 10 (a business) or 13 (a branch) of them; anything else cannot be matched. */
export function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 ? digits : null;
}

export interface CatalogueParty {
  code: string;
  id: string | null;
  taxCode: string | null;
  active: boolean;
}
export interface CatalogueItem {
  code: string;
  id: string | null;
  active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);
const codeOf = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100 ? value.trim() : null);
// MISA's `inactive` is "stopped being followed"; an entry that does not say it is inactive is active.
const activeOf = (value: unknown): boolean => value !== true;

/** The catalogue's party rows (get_dictionary data_type 1) as the matcher reads them; a row without a code cannot be matched to. */
export function catalogueParties(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueParty[] {
  return rows.flatMap((row) => {
    const code = codeOf(row.account_object_code);
    return code === null ? [] : [{ code, id: idOf(row.account_object_id), taxCode: normalizeTaxCode(typeof row.company_tax_code === 'string' ? row.company_tax_code : null), active: activeOf(row.inactive) }];
  });
}
/** The catalogue's item rows (get_dictionary data_type 2). */
export function catalogueItems(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueItem[] {
  return rows.flatMap((row) => {
    const code = codeOf(row.inventory_item_code);
    return code === null ? [] : [{ code, id: idOf(row.inventory_item_id), active: activeOf(row.inactive) }];
  });
}

const result = (kind: 'party' | 'item', ref: string, found: ReadonlyArray<{ code: string; id: string | null }>): MisaAmisMatchResult => {
  const [only] = found;
  return found.length === 1 && only ? { kind, ref, state: 'matched', code: only.code, entryId: only.id } : { kind, ref, state: found.length === 0 ? 'unknown' : 'ambiguous', code: null, entryId: null };
};

/** Each wanted tax code against the active catalogue entries that carry exactly that tax code. Never by name: a party with a tax code that is not in the catalogue is `unknown`, whatever its name says. */
export function matchParties(wanted: Iterable<string>, catalogue: readonly CatalogueParty[]): MisaAmisMatchResult[] {
  const byTax = new Map<string, CatalogueParty[]>();
  for (const entry of catalogue) {
    if (!entry.active || entry.taxCode === null) continue;
    byTax.set(entry.taxCode, [...(byTax.get(entry.taxCode) ?? []), entry]);
  }
  return [...new Set(wanted)].sort().map((taxCode) => result('party', taxCode, byTax.get(taxCode) ?? []));
}

/** Each wanted item code against the active catalogue entries with exactly that code (case and spelling as MISA has it). */
export function matchItems(wanted: Iterable<string>, catalogue: readonly CatalogueItem[]): MisaAmisMatchResult[] {
  const byCode = new Map<string, CatalogueItem[]>();
  for (const entry of catalogue) {
    if (!entry.active) continue;
    byCode.set(entry.code, [...(byCode.get(entry.code) ?? []), entry]);
  }
  return [...new Set(wanted)].sort().map((code) => result('item', code, byCode.get(code) ?? []));
}

// ---------------------------------------------------------------------------------------------------------------
// Sent only fresh (#4124, S3b of #4103; the Accounting PO's M2 on #4128). A stored match is a view of the catalogue at the time of a check: before a person confirms a push the check must be this young, and
// before the worker sends it reads the entries it relies on once more and refuses what changed in MISA since.

/** How old the last check of a connection may be when a person confirms a push (15 minutes). */
export const MISA_AMIS_CHECK_MAX_AGE_MS = 15 * 60 * 1000;

/** Whether a check finished at `checkedAt` (an ISO time, null when none ever finished) is young enough for a confirmation made at `now`. A time in the future is not fresh. */
export function checkIsFresh(checkedAt: string | null, now: Date): boolean {
  if (checkedAt === null) return false;
  const age = now.getTime() - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 && age <= MISA_AMIS_CHECK_MAX_AGE_MS;
}

/** What a send relies on, and the catalogue entries it relies on, as the worker holds them. */
export interface StoredMatches {
  /** Tax code to the matched party's code, as stored by the last check; null when no check has been made. */
  partyCodes: ReadonlyMap<string, string> | null;
  /** The item codes that matched; null when no check has been made. */
  itemCodes: ReadonlySet<string> | null;
}

/** The stored matches a send relies on, to be re-read: the tax codes and item codes of the batch that a check matched. A reference that did not match is a blocker and is never sent, so it is not looked at. */
export function relied(stored: StoredMatches, wanted: { taxCodes: readonly string[]; itemCodes: readonly string[] }): { taxCodes: string[]; itemCodes: string[] } {
  return {
    taxCodes: wanted.taxCodes.filter((taxCode) => stored.partyCodes?.has(taxCode) === true),
    itemCodes: wanted.itemCodes.filter((code) => stored.itemCodes?.has(code) === true),
  };
}

/** True when a catalogue read now disagrees with a stored match the send relies on: the entry is gone, inactive, several now carry the tax code, or the matched code is not the one stored. */
export function staleMatches(stored: StoredMatches, fresh: readonly MisaAmisMatchResult[]): boolean {
  const now = new Map(fresh.map((r) => [`${r.kind}:${r.ref}`, r]));
  for (const [taxCode, code] of stored.partyCodes ?? []) {
    const found = now.get(`party:${taxCode}`);
    if (found !== undefined && !(found.state === 'matched' && found.code === code)) return true;
  }
  for (const code of stored.itemCodes ?? []) {
    const found = now.get(`item:${code}`);
    if (found !== undefined && found.state !== 'matched') return true;
  }
  return false;
}
