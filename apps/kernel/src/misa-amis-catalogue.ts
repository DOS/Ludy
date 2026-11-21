// SPDX-License-Identifier: AGPL-3.0-only
// Reading the firm's MISA catalogue in the worker's memory (#4112, S3a, and #4124, S3b, of #4103), shared by the check job (misa-amis-match-job.ts) and the push job's re-read (misa-amis-push-job.ts). The pages live in
// the caller's variables and nowhere else: nothing here logs, stores or returns a catalogue name, address or tax code beyond the rows themselves, which the caller matches and drops. A catalogue of 20 000 entries or
// more of a kind is not read in part (a party past the cut would read as unknown): `TooLarge` says so and the caller gives a fixed reason.
import { AMIS_DICTIONARIES, type AmisClient, type AmisConnection } from '@ludy/misa-amis';
import { catalogueItems, catalogueParties, catalogueStocks, catalogueUnits, confirmedStillHold, matchItems, matchNames, matchParties, matchStocks, matchUnits, type WantedName } from '@ludy/mod-finance';
import type { MisaAmisMatchResult } from '@ludy/kernel-contract';

const PAGE = 1000;
const MAX_PAGES = 20;

export class TooLarge extends Error {}

export type CatalogueRows = Array<Readonly<Record<string, unknown>>>;
export async function readCatalogue(client: AmisClient, connection: AmisConnection, dataType: typeof AMIS_DICTIONARIES.accountObject | typeof AMIS_DICTIONARIES.inventoryItem | typeof AMIS_DICTIONARIES.stock | typeof AMIS_DICTIONARIES.unit): Promise<CatalogueRows> {
  const all: CatalogueRows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await client.dictionary(connection, { dataType, skip: page * PAGE, take: PAGE, lastSyncTime: null, branchId: null });
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
  throw new TooLarge();
}

/**
 * The names of the active stocks by their ids (ASP, #4125): a sales or goods line writes `stock_name` beside its `stock_id`, and the name is read here, in the worker's memory, right before the send; it is never stored
 * or logged, and is not part of the digest a person confirms.
 */
export async function readStockNames(client: AmisClient, connection: AmisConnection): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const row of await readCatalogue(client, connection, AMIS_DICTIONARIES.stock)) {
    const id = typeof row.stock_id === 'string' ? row.stock_id.toLowerCase() : null;
    const name = typeof row.stock_name === 'string' ? row.stock_name.trim() : '';
    if (id !== null && row.inactive !== true && name.length > 0) names.set(id, name.slice(0, 128));
  }
  return names;
}

/**
 * What is asked of the catalogue: tax codes to look parties up by, names to look parties with no tax code up by (S3b, #4124), item codes, and the codes of names a person confirmed, which must still be there. Only
 * the kinds that have something to look up are read, and the party pages are read once for all three party questions.
 */
export interface CatalogueQuestion {
  taxCodes: readonly string[];
  itemCodes: readonly string[];
  names?: readonly WantedName[];
  confirmed?: ReadonlyArray<{ partyId: string; code: string }>;
  /** MISA ASP only (#4125): the unit names and stock codes Ludy writes on lines, looked up in catalogues 4 and 3. */
  unitNames?: readonly string[];
  stockCodes?: readonly string[];
  /** MISA ASP: the unit names a person typed, by the unit of Ludy (folded). */
  unitAliases?: Readonly<Record<string, string>>;
}

/** The questions matched against the catalogue as it is now. */
export async function matchCatalogue(client: AmisClient, connection: AmisConnection, wanted: CatalogueQuestion): Promise<MisaAmisMatchResult[]> {
  const results: MisaAmisMatchResult[] = [];
  const names = wanted.names ?? [];
  const confirmed = wanted.confirmed ?? [];
  if (wanted.taxCodes.length > 0 || names.length > 0 || confirmed.length > 0) {
    const parties = catalogueParties(await readCatalogue(client, connection, AMIS_DICTIONARIES.accountObject));
    results.push(...matchParties(wanted.taxCodes, parties), ...matchNames(names, parties), ...confirmedStillHold(confirmed, parties));
  }
  if (wanted.itemCodes.length > 0) results.push(...matchItems(wanted.itemCodes, catalogueItems(await readCatalogue(client, connection, AMIS_DICTIONARIES.inventoryItem))));
  const unitNames = wanted.unitNames ?? [];
  if (unitNames.length > 0) results.push(...matchUnits(unitNames, catalogueUnits(await readCatalogue(client, connection, AMIS_DICTIONARIES.unit)), wanted.unitAliases));
  const stockCodes = wanted.stockCodes ?? [];
  if (stockCodes.length > 0) results.push(...matchStocks(stockCodes, catalogueStocks(await readCatalogue(client, connection, AMIS_DICTIONARIES.stock))));
  return results;
}
