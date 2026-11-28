// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the Settings learned account-rules card and add dialog (#1453): vendor filter choices from the
// listed rules, filtering the rules by vendor, and folding Vietnamese accents to search org parties by name or tax code.
import { fold } from './palette.ts';

export const ACCOUNT_RULE_EVERY_VENDOR = '__every__';
export const VENDOR_PICK_LIMIT = 50;

export interface RuleVendorOption {
  partyId: string;
  name: string;
}

export interface SearchableParty {
  id: string;
  name: string;
  taxCode: string | null;
  duplicates?: ReadonlyArray<{ name: string; taxCode: string | null }>;
}

/** Distinct vendor choices present in the rules list, plus whether any rule applies to every vendor. */
export function ruleVendorOptions(rules: ReadonlyArray<{ vendor: { partyId: string; name: string } | null }>): {
  hasEveryVendor: boolean;
  vendors: RuleVendorOption[];
} {
  let hasEveryVendor = false;
  const byId = new Map<string, string>();
  for (const rule of rules) {
    if (rule.vendor === null) {
      hasEveryVendor = true;
      continue;
    }
    if (!byId.has(rule.vendor.partyId)) byId.set(rule.vendor.partyId, rule.vendor.name);
  }
  const vendors = [...byId.entries()]
    .map(([partyId, name]) => ({ partyId, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi') || a.partyId.localeCompare(b.partyId));
  return { hasEveryVendor, vendors };
}

/** Filters learned rules by vendor choice: '' for all rules, ACCOUNT_RULE_EVERY_VENDOR for shared rules, or a partyId. */
export function filterRulesByVendor<T extends { vendor: { partyId: string } | null }>(rules: readonly T[], vendorFilter: string): T[] {
  if (vendorFilter === '') return [...rules];
  if (vendorFilter === ACCOUNT_RULE_EVERY_VENDOR) return rules.filter((r) => r.vendor === null);
  return rules.filter((r) => r.vendor?.partyId === vendorFilter);
}

/** Matches org parties by name, tax code, or merged duplicate names/tax codes, ignoring case and Vietnamese accents. */
export function filterPartyChoices<T extends SearchableParty>(parties: readonly T[], query: string, limit = VENDOR_PICK_LIMIT): { items: T[]; total: number } {
  const q = fold(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { items: parties.slice(0, limit), total: parties.length };
  }
  const ranked: Array<{ party: T; score: number; index: number }> = [];
  for (const [index, party] of parties.entries()) {
    const duplicateText = (party.duplicates ?? []).flatMap((d) => [d.name, d.taxCode ?? '']);
    const haystack = fold([party.name, party.taxCode ?? '', ...duplicateText].join(' '));
    if (!words.every((w) => haystack.includes(w))) continue;
    const name = fold(party.name);
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
    ranked.push({ party, score, index });
  }
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  return { items: ranked.slice(0, limit).map((entry) => entry.party), total: ranked.length };
}
