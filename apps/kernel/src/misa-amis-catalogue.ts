// SPDX-License-Identifier: AGPL-3.0-only
// Reading the firm's MISA catalogue in the worker's memory (#4112, S3a, and #4124, S3b, of #4103), shared by the check job (misa-amis-match-job.ts) and the push job's re-read (misa-amis-push-job.ts). The pages live in
// the caller's variables and nowhere else: nothing here logs, stores or returns a catalogue name, address or tax code beyond the rows themselves, which the caller matches and drops. A catalogue of 20 000 entries or
// more of a kind is not read in part (a party past the cut would read as unknown): `TooLarge` says so and the caller gives a fixed reason.
import { AMIS_DICTIONARIES, type AmisClient, type AmisConnection } from '@crove/misa-amis';
import { catalogueItems, catalogueParties, matchItems, matchParties } from '@crove/mod-finance';
import type { MisaAmisMatchResult } from '@crove/kernel-contract';

const PAGE = 1000;
const MAX_PAGES = 20;

export class TooLarge extends Error {}

export type CatalogueRows = Array<Readonly<Record<string, unknown>>>;
export async function readCatalogue(client: AmisClient, connection: AmisConnection, dataType: typeof AMIS_DICTIONARIES.accountObject | typeof AMIS_DICTIONARIES.inventoryItem): Promise<CatalogueRows> {
  const all: CatalogueRows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await client.dictionary(connection, { dataType, skip: page * PAGE, take: PAGE, lastSyncTime: null, branchId: null });
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
  throw new TooLarge();
}

/** The given tax codes and item codes matched against the catalogue as it is now: only the kinds that have something to look up are read. */
export async function matchCatalogue(client: AmisClient, connection: AmisConnection, wanted: { taxCodes: readonly string[]; itemCodes: readonly string[] }): Promise<MisaAmisMatchResult[]> {
  const results: MisaAmisMatchResult[] = [];
  if (wanted.taxCodes.length > 0) results.push(...matchParties(wanted.taxCodes, catalogueParties(await readCatalogue(client, connection, AMIS_DICTIONARIES.accountObject))));
  if (wanted.itemCodes.length > 0) results.push(...matchItems(wanted.itemCodes, catalogueItems(await readCatalogue(client, connection, AMIS_DICTIONARIES.inventoryItem))));
  return results;
}
