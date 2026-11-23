// SPDX-License-Identifier: AGPL-3.0-only
// The matching of a connection's vouchers against the firm's own MISA catalogue (#4112, S3a of #4103), pure: no database, no network. A party is looked up by its tax code ONLY (never by name), an item by its
// exact code; one active catalogue entry is `matched`, none is `unknown`, several are `ambiguous` and nothing picks one. The catalogue's names, addresses and tax codes are read here and go no further: what a
// caller keeps is the matched entry's code and id. The check itself (request, record, results) is misa-amis-match.ts.
import { MISA_AMIS_CANDIDATE_NAME_MAX, type MisaAmisMatchResult } from '@ludy/kernel-contract';

/** A party's tax code as the catalogue and the vouchers compare it: digits only, 10 (a business) or 13 (a branch) of them; anything else cannot be matched. */
export function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 ? digits : null;
}

/** A party with no tax code at all: none, or one that is blank. Only such a party is looked at by name; a tax code that is present but cannot be used (not 10 or 13 digits) stays a blocker for a person to fix. */
export function hasNoTaxCode(raw: string | null | undefined): boolean {
  return raw === null || raw === undefined || raw.trim() === '';
}

export interface CatalogueParty {
  code: string;
  id: string | null;
  taxCode: string | null;
  // The entry's name, held in the worker's memory for a name match (S3b, #4124) and kept only on a proposal row.
  name: string | null;
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
const nameOf = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

/** The catalogue's party rows (get_dictionary data_type 1) as the matcher reads them; a row without a code cannot be matched to. */
export function catalogueParties(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueParty[] {
  return rows.flatMap((row) => {
    const code = codeOf(row.account_object_code);
    return code === null ? [] : [{ code, id: idOf(row.account_object_id), taxCode: normalizeTaxCode(typeof row.company_tax_code === 'string' ? row.company_tax_code : null), name: nameOf(row.account_object_name), active: activeOf(row.inactive) }];
  });
}
/** The catalogue's item rows (get_dictionary data_type 2). */
export function catalogueItems(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueItem[] {
  return rows.flatMap((row) => {
    const code = codeOf(row.inventory_item_code);
    return code === null ? [] : [{ code, id: idOf(row.inventory_item_id), active: activeOf(row.inactive) }];
  });
}

const result = (kind: 'party' | 'item' | 'stock', ref: string, found: ReadonlyArray<{ code: string; id: string | null }>): MisaAmisMatchResult => {
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
  return matchByCode('item', wanted, catalogue, false);
}

/** `needId`: the entry's id is written on a line (a stock), so a single entry without a usable id is not a match; it still counts toward `ambiguous`. */
function matchByCode(kind: 'item' | 'stock', wanted: Iterable<string>, catalogue: readonly CatalogueItem[], needId: boolean): MisaAmisMatchResult[] {
  const byCode = new Map<string, CatalogueItem[]>();
  for (const entry of catalogue) {
    if (!entry.active) continue;
    byCode.set(entry.code, [...(byCode.get(entry.code) ?? []), entry]);
  }
  return [...new Set(wanted)].sort().map((code) => {
    const found = byCode.get(code) ?? [];
    return result(kind, code, needId && found.length === 1 && found[0]?.id === null ? [] : found);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Units and stocks (#4125, MISA ASP only): a line names its unit and its stock by id, so Ludy's unit names (catalogue 4) and stock codes (catalogue 3) are looked up. A unit has no code, it is found by its name the way
// a person reads it the same (Unicode composed, lower case, one space between words); nothing looser: none or two are not a match and a person picks.

/** A unit name as the comparison reads it (NFC, lower case, single spaces, trimmed); null when empty or over 64 characters (the key's limit). */
export function normalizeUnitName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 64 ? name : null;
}

export interface CatalogueUnit {
  /** The catalogue's own unit name (kept as MISA has it, up to 100 characters). */
  name: string;
  id: string | null;
  active: boolean;
}

/** The catalogue's unit rows (get_dictionary data_type 4); a row without a name cannot be matched to. */
export function catalogueUnits(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueUnit[] {
  return rows.flatMap((row) => {
    const name = codeOf(row.unit_name);
    return name === null ? [] : [{ name, id: idOf(row.unit_id), active: activeOf(row.inactive) }];
  });
}

/** The catalogue's stock rows (get_dictionary data_type 3), by stock code; the stock's name is read again by the push and never kept. */
export function catalogueStocks(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): CatalogueItem[] {
  return rows.flatMap((row) => {
    const code = codeOf(row.stock_code);
    return code === null ? [] : [{ code, id: idOf(row.stock_id), active: activeOf(row.inactive) }];
  });
}

/** Each wanted unit name (as Ludy writes it) against the active catalogue units of the same name; the result is keyed by the normalized name. */
export function matchUnits(wanted: Iterable<string>, catalogue: readonly CatalogueUnit[], aliases: Readonly<Record<string, string>> = {}): MisaAmisMatchResult[] {
  const byName = new Map<string, CatalogueUnit[]>();
  for (const entry of catalogue) {
    const key = entry.active ? normalizeUnitName(entry.name) : null;
    if (key !== null) byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  const keys = new Set<string>();
  for (const raw of wanted) {
    const key = normalizeUnitName(raw);
    if (key !== null) keys.add(key);
  }
  return [...keys].sort().map((key) => {
    // A name a person typed for the unit is looked up instead of the unit's own name (exactly, as every name is); the result stays under the unit of Ludy.
    // A typed name that does not fold to a name is no name at all: the unit stays unmatched, never silently looked up under its own name.
    const typed = Object.hasOwn(aliases, key) ? normalizeUnitName(aliases[key]) : undefined;
    const found = typed === null ? [] : (byName.get(typed ?? key) ?? []);
    const [only] = found;
    // A unit whose id is not a usable id cannot be written on a line: it is as good as not there.
    if (found.length === 1 && only && only.id !== null) return { kind: 'unit' as const, ref: key, state: 'matched' as const, code: only.name, entryId: only.id };
    return { kind: 'unit' as const, ref: key, state: found.length > 1 ? ('ambiguous' as const) : ('unknown' as const), code: null, entryId: null };
  });
}

/** Each wanted stock code against the active catalogue stocks with exactly that code. */
export function matchStocks(wanted: Iterable<string>, catalogue: readonly CatalogueItem[]): MisaAmisMatchResult[] {
  return matchByCode('stock', wanted, catalogue, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Names (S3b, #4124). A party WITHOUT a tax code cannot be looked up by it, so it is looked up by name and the answer is a proposal a person confirms: never matched on its own. The comparison is of names the way a
// person reads them the same (Unicode composed, lower case, one space between words); nothing looser: "Công ty A" and "Cong ty A" are two names, and a person decides.

/** A name as the comparison reads it; null for a name too short to say anything (under three characters). */
export function normalizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return name.length >= 3 ? name : null;
}

/** A party of Ludy with no tax code at all (its id and its name as Ludy has it) and what a check asks of the catalogue about it. */
export interface WantedName {
  partyId: string;
  name: string;
}

/**
 * Each wanted party against the ACTIVE catalogue entries of the same name: one is a `name_proposal` (the entry's code, id and name, kept on that row only), several are `ambiguous`, none says nothing (no row:
 * the party stays blocked as one the catalogue does not have). A party a person already confirmed is never asked here (it is checked by `confirmedStillHold`).
 */
export function matchNames(wanted: readonly WantedName[], catalogue: readonly CatalogueParty[]): MisaAmisMatchResult[] {
  const byName = new Map<string, CatalogueParty[]>();
  for (const entry of catalogue) {
    const key = entry.active ? normalizeName(entry.name) : null;
    if (key !== null) byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  const results: MisaAmisMatchResult[] = [];
  const seen = new Set<string>();
  for (const { partyId, name } of [...wanted].sort((a, b) => a.partyId.localeCompare(b.partyId))) {
    if (seen.has(partyId)) continue;
    seen.add(partyId);
    const key = normalizeName(name);
    const found = key === null ? [] : (byName.get(key) ?? []);
    const [only] = found;
    if (found.length === 1 && only && only.name !== null) results.push({ kind: 'party_name', ref: partyId, state: 'name_proposal', code: only.code, entryId: only.id, candidateName: only.name.slice(0, MISA_AMIS_CANDIDATE_NAME_MAX) });
    else if (found.length > 1) results.push({ kind: 'party_name', ref: partyId, state: 'ambiguous', code: null, entryId: null });
  }
  return results;
}

/** A name a person confirmed keeps standing only while its code is in the catalogue and active: `confirmed` (keep the row) or `unknown` (the row goes and the party is blocked again). */
export function confirmedStillHold(confirmed: ReadonlyArray<{ partyId: string; code: string }>, catalogue: readonly CatalogueParty[]): MisaAmisMatchResult[] {
  const active = new Set(catalogue.filter((e) => e.active).map((e) => e.code));
  return [...confirmed]
    .sort((a, b) => a.partyId.localeCompare(b.partyId))
    .map(({ partyId, code }) => (active.has(code) ? { kind: 'party_name' as const, ref: partyId, state: 'confirmed' as const, code, entryId: null } : { kind: 'party_name' as const, ref: partyId, state: 'unknown' as const, code: null, entryId: null }));
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
  /** A party's id to the code a person confirmed for it by name (S3b); absent or null when none. */
  partyNameCodes?: ReadonlyMap<string, string> | null;
  /** MISA ASP (#4125): the connection's product, and the ids of the matched items, units (by normalized name) and stocks (by code); the push relies on them and reads them again. */
  product?: 'amis' | 'asp';
  itemIds?: ReadonlyMap<string, string> | null;
  unitIds?: ReadonlyMap<string, { name: string; id: string }> | null;
  stockIds?: ReadonlyMap<string, string> | null;
}

/** The stored matches a send relies on, to be re-read: the tax codes and item codes of the batch that a check matched. A reference that did not match is a blocker and is never sent, so it is not looked at. */
export function relied(
  stored: StoredMatches,
  wanted: { taxCodes: readonly string[]; itemCodes: readonly string[]; names?: readonly WantedName[]; unitNames?: readonly string[]; stockCodes?: readonly string[] },
): { taxCodes: string[]; itemCodes: string[]; confirmed: Array<{ partyId: string; code: string }>; unitNames: string[]; stockCodes: string[] } {
  const confirmed: Array<{ partyId: string; code: string }> = [];
  for (const { partyId } of wanted.names ?? []) {
    const code = stored.partyNameCodes?.get(partyId);
    if (code !== undefined) confirmed.push({ partyId, code });
  }
  return {
    taxCodes: wanted.taxCodes.filter((taxCode) => stored.partyCodes?.has(taxCode) === true),
    itemCodes: wanted.itemCodes.filter((code) => stored.itemCodes?.has(code) === true),
    confirmed,
    // Units and stocks are relied on for ASP only (an AMIS check stores none).
    unitNames: stored.product === 'asp' ? (wanted.unitNames ?? []).filter((name) => stored.unitIds?.has(normalizeUnitName(name) ?? '') === true) : [],
    stockCodes: stored.product === 'asp' ? (wanted.stockCodes ?? []).filter((code) => stored.stockIds?.has(code) === true) : [],
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
  // ASP (#4125): the ids a line is written with must be the ones the catalogue has now (an entry deactivated, deleted or replaced by another id in MISA since the check).
  if (stored.product === 'asp') {
    for (const [key, unit] of stored.unitIds ?? []) {
      const found = now.get(`unit:${key}`);
      if (found !== undefined && !(found.state === 'matched' && found.entryId === unit.id)) return true;
    }
    for (const [code, id] of stored.stockIds ?? []) {
      const found = now.get(`stock:${code}`);
      if (found !== undefined && !(found.state === 'matched' && found.entryId === id)) return true;
    }
    for (const [code, id] of stored.itemIds ?? []) {
      const found = now.get(`item:${code}`);
      if (found !== undefined && !(found.state === 'matched' && found.entryId === id)) return true;
    }
  }
  // A name a person confirmed holds while its code is still in the catalogue and active.
  for (const [partyId, code] of stored.partyNameCodes ?? []) {
    const found = now.get(`party_name:${partyId}`);
    if (found !== undefined && !(found.state === 'confirmed' && found.code === code)) return true;
  }
  return false;
}
