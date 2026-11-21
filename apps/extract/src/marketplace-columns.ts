// SPDX-License-Identifier: AGPL-3.0-only
// A marketplace order report whose headers no platform profile fits (#4035, #3850 slice 1b), read in the sandbox for the column proposal and for the check of a column mapping on the real file.
// The kernel has no sheet parser, so both happen here, and the buyer's data never leaves: the answer is the masked sheet (@crove/l10n-vn, marketplace-columns.ts: header texts and the SHAPES of a
// few values, a buyer column blanked) or, when the request carries the platform and a mapping, the check's verdict and, when the mapping reads the file, the lines of marketplace_orders. The
// response schema has no field a cell's content could travel in, and the shapes are held to a character class by the schema itself.
import { createHash } from 'node:crypto';
import { EXTRACT_LIMITS, MarketplaceColumnsInputError, decodeMarketplaceColumnsInput, type ExtractedMarketplaceColumns } from '@crove/extract-contract';
import { MARKETPLACE_PROFILES, checkColumnMapping, columnSheet, headerRowText } from '@crove/l10n-vn';
import { readSheetGrid } from './bank-statement.ts';
import { readToOrders } from './marketplace-orders.ts';

export function readMarketplaceColumns(bytes: Uint8Array): ExtractedMarketplaceColumns {
  const input = decodeMarketplaceColumnsInput(bytes);
  const file = new Uint8Array(Buffer.from(input.fileBase64, 'base64'));
  if (file.byteLength > EXTRACT_LIMITS.maxOrderReportBytes) throw new MarketplaceColumnsInputError('marketplace_columns file is larger than allowed');
  const grid = readSheetGrid(file);
  const found = grid ? columnSheet(grid) : null;
  // The digest is of the file's own header row (every non-empty cell, buyer columns included): only the hash leaves the sandbox.
  const sheet = grid && found ? { ...found, headerDigest: createHash('sha256').update(headerRowText(grid, found.headerRow), 'utf8').digest('hex') } : null;
  const mapping = input.mapping;
  if (!mapping) return { sheet, check: null };
  // A file that is no sheet at all, or has no header row, is refused as the check refuses it: the person is told the same thing either way.
  if (!grid || !sheet) return { sheet, check: { ok: false, reason: 'no_header' } };
  const checked = checkColumnMapping(grid, mapping.platform, mapping.assignments, EXTRACT_LIMITS.maxOrderLines);
  if (!checked.ok) return { sheet, check: { ok: false, reason: checked.reason } };
  // checkColumnMapping has accepted the platform, so its profile exists; a header of an assigned column is a non-buyer column's, already in the sheet.
  const profile = MARKETPLACE_PROFILES.find((p) => p.platform === mapping.platform);
  if (!profile) return { sheet, check: { ok: false, reason: 'bad_column' } };
  const headers = new Map(sheet.columns.map((c) => [c.index, c.header]));
  const orders = readToOrders(
    {
      recognized: true,
      platform: profile.platform,
      // A mapping a person confirmed is never the profile's own words, nor a real seller's file checked (#2521): its version says so.
      profile: { version: `${profile.version}+columns`, confirmed: false },
      columns: mapping.assignments.map((a) => ({ field: a.field, header: (headers.get(a.index) ?? '').slice(0, 200) })),
    },
    checked.read,
  );
  return { sheet, check: { ok: true, orders } };
}
