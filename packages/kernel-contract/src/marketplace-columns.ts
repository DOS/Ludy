// SPDX-License-Identifier: AGPL-3.0-only
// The mapping of a marketplace report's columns that a person confirmed (#4037, slice 2 of #3850; plan stock-and-marketplaces.md section 8.6 "Columns"): what the confirm command takes and what the
// read of the latest profile answers. Only the header texts of the mapped columns and the standard field of each: never a cell value, a sample or a buyer column (the field list has no buyer field).
import { z } from 'zod';
import { zMarketplacePlatform } from './marketplace.ts';
import { zId } from './schemas.ts';

// The standard fields of an order line a column can be confirmed as: the same list as `ORDER_FIELDS` of @crove/l10n-vn (a test in modules/finance keeps the two equal) and the database's CHECK.
export const MARKETPLACE_COLUMN_FIELDS = ['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount'] as const;
export const zMarketplaceColumnField = z.enum(MARKETPLACE_COLUMN_FIELDS);
export type MarketplaceColumnField = z.infer<typeof zMarketplaceColumnField>;

// How much of a header text is kept (as `columnSheet` cuts it) and how many columns a profile maps (one per standard field at most).
export const MARKETPLACE_COLUMN_HEADER_MAX = 80;

// One confirmed column: its place in the header row (0-based), the header text as the file words it and the standard field it is.
export const zMarketplaceColumnEntry = z.strictObject({
  index: z.number().int().min(0).max(999),
  header: z.string().trim().min(1).max(MARKETPLACE_COLUMN_HEADER_MAX),
  field: zMarketplaceColumnField,
});
export type MarketplaceColumnEntry = z.infer<typeof zMarketplaceColumnEntry>;

// The digest of a whole header row: sha-256, hex, of the normalized texts of its non-empty cells in column order, joined by a line feed. A later file whose header row has another digest does not use
// the profile. Computed where the file is read (the sandboxed extract step), never from a cell below the header.
export const zMarketplaceHeaderDigest = z.string().regex(/^[0-9a-f]{64}$/);

// The confirmation a person makes. The kernel re-checks here what the header row alone decides (see the command); the checks that read the rows of the file run where the file is read.
export const zMarketplaceColumnsConfirm = z.strictObject({
  platform: zMarketplacePlatform,
  headerRow: z.number().int().min(0).max(100_000),
  columns: z.array(zMarketplaceColumnEntry).min(2).max(MARKETPLACE_COLUMN_FIELDS.length),
  headerDigest: zMarketplaceHeaderDigest,
});
export type MarketplaceColumnsConfirm = z.infer<typeof zMarketplaceColumnsConfirm>;

// What a confirmation answers: the profile's id, and whether it was a new row (false when the latest profile of the org and platform already had this very mapping, so nothing was added).
export const zMarketplaceColumnsConfirmed = z.object({ id: zId, added: z.boolean() });
export type MarketplaceColumnsConfirmed = z.infer<typeof zMarketplaceColumnsConfirmed>;

export const zMarketplaceColumnProfileQuery = z.strictObject({ platform: zMarketplacePlatform });

export const zMarketplaceColumnProfile = z.object({
  id: zId,
  platform: zMarketplacePlatform,
  headerRow: z.number().int().nonnegative(),
  columns: z.array(zMarketplaceColumnEntry),
  headerDigest: zMarketplaceHeaderDigest,
  confirmedAt: z.string(),
});
export type MarketplaceColumnProfile = z.infer<typeof zMarketplaceColumnProfile>;
