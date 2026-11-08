// SPDX-License-Identifier: AGPL-3.0-only
// Comparing the filter and sort of a screen with the ones a saved view stores (CRM K3 and K4, #2227, #2228). No browser or
// API imports, so it is unit tested.
import type { FilterAst, FilterCondition, SavedViewSort } from '@crove/kernel-contract';

// Two filters mean the same conditions, whatever their order.
export function sameFilter(a: FilterAst, b: FilterAst): boolean {
  const key = (c: FilterCondition) => JSON.stringify([c.field, c.op, c.value ?? null]);
  const x = a.all.map(key).sort();
  const y = b.all.map(key).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

export const sameSort = (a: SavedViewSort | null | undefined, b: SavedViewSort | null | undefined) => (a?.field ?? null) === (b?.field ?? null) && (a?.dir ?? null) === (b?.dir ?? null);
