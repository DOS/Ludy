// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports (#2515, ADR-0045 points 5 and 7): what the Inbox shows of a report read from a file (the platform, the period, the orders and lines, how far they have got,
// what could not be read), the live check against the stock items before a member confirms, and the confirmed orders. No buyer data of any kind appears anywhere here: the importer
// never reads the report's buyer columns.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';
import { zStockFactor } from './stock.ts';

export const MARKETPLACE_PLATFORM_KEYS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export const MARKETPLACE_STAGE_KEYS = ['placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown'] as const;
export const zMarketplacePlatform = z.enum(MARKETPLACE_PLATFORM_KEYS);
export const zMarketplaceStage = z.enum(MARKETPLACE_STAGE_KEYS);

// What a staged read keeps next to its lines: the platform the headers say, the profile that read it (never confirmed against a real file until #2521), the period of the orders, how
// many of each stage, the status labels the profile did not know, and the rows that were no line of an order (a totals row), which the confirm step ignores.
// After the decision the same summary says what was stored: newLines (lines new to the org), updatedLines (a stage moved forward) and duplicateLines (already known, unchanged).
export const zMarketplaceSummary = z.object({
  state: z.enum(['staged', 'imported', 'rejected']),
  platform: zMarketplacePlatform,
  profileVersion: z.string(),
  profileConfirmed: z.boolean(),
  filename: z.string(),
  orders: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  from: zLocalDate.nullable(),
  to: zLocalDate.nullable(),
  stages: z.object({ placed: z.number().int(), shipped: z.number().int(), completed: z.number().int(), cancelled: z.number().int(), returned: z.number().int(), unknown: z.number().int() }),
  unknownStatuses: z.array(z.string().max(100)).max(20),
  ignoredRows: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative().optional(),
  updatedLines: z.number().int().nonnegative().optional(),
  duplicateLines: z.number().int().nonnegative().optional(),
  stockMoves: z.number().int().nonnegative().optional(),
});
export type MarketplaceSummary = z.infer<typeof zMarketplaceSummary>;

// A report waiting for a member, in the Inbox.
export const zMarketplaceStaged = z.object({
  fileId: zId,
  filename: z.string(),
  createdAt: z.string(),
  summary: zMarketplaceSummary,
  // The legal entity the orders would go to: the one the file was uploaded for (or the default), with its name as it is now.
  entity: z.object({ id: zId, name: z.string() }).nullable(),
});
export type MarketplaceStaged = z.infer<typeof zMarketplaceStaged>;

export const zMarketplacePreview = z.object({
  // Lines new to the org, lines already known (unchanged), and lines already known whose stage the report moves forward.
  newLines: z.number().int().nonnegative(),
  knownLines: z.number().int().nonnegative(),
  advancedLines: z.number().int().nonnegative(),
  // Of the lines that would move stock (shipped, completed or returned), how many name an item and how many none yet: the others wait in "Chưa gán hàng".
  matchedLines: z.number().int().nonnegative(),
  unmatchedLines: z.number().int().nonnegative(),
});
export type MarketplacePreview = z.infer<typeof zMarketplacePreview>;

export const zMarketplaceConfirmResult = z.object({ newLines: z.number().int(), updatedLines: z.number().int(), duplicateLines: z.number().int(), stockMoves: z.number().int() });
export type MarketplaceConfirmResult = z.infer<typeof zMarketplaceConfirmResult>;

export const zMarketplaceOrdersInput = z.strictObject({
  legalEntityId: zId.optional(),
  platform: zMarketplacePlatform.optional(),
  stage: zMarketplaceStage.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const zMarketplaceOrder = z.object({
  id: zId,
  legalEntityId: zId,
  platform: zMarketplacePlatform,
  orderNo: z.string(),
  orderedAt: zLocalDate.nullable(),
  // How far the order has got: the furthest stage of its lines.
  stage: zMarketplaceStage,
  lines: z.array(
    z.object({
      id: zId,
      lineKey: z.string(),
      sku: z.string().nullable(),
      itemName: z.string().nullable(),
      quantity: z.string(),
      unitPrice: z.string().nullable(),
      amount: z.string().nullable(),
      stage: zMarketplaceStage,
      shippedAt: zLocalDate.nullable(),
      // The stock item the line moved, by its code, or null while it moved nothing.
      itemCode: z.string().nullable(),
    }),
  ),
});
export type MarketplaceOrder = z.infer<typeof zMarketplaceOrder>;

// The order lines that move stock (shipped, completed or returned) and name no item yet: they wait in "Chưa gán hàng" for a person to assign them (finance.marketplace.assign), which also
// teaches the SKU for the platform so the next report moves it by itself.
export const zMarketplaceUnassignedInput = z.strictObject({ legalEntityId: zId.optional(), limit: z.number().int().min(1).max(500).optional() });
export const zMarketplaceUnassignedLine = z.object({
  lineId: zId,
  legalEntityId: zId,
  platform: zMarketplacePlatform,
  orderNo: z.string(),
  orderedAt: zLocalDate.nullable(),
  sku: z.string().nullable(),
  itemName: z.string().nullable(),
  quantity: z.string(),
  stage: zMarketplaceStage,
});
export type MarketplaceUnassignedLine = z.infer<typeof zMarketplaceUnassignedLine>;

// factor: how many of the item's units one unit of the report's is (a carton of 12). teach: remember the SKU for this platform and item.
export const zMarketplaceAssign = z.strictObject({ lineId: zId, itemId: zId, factor: zStockFactor.default('1'), teach: z.boolean().default(true) });
export type MarketplaceAssign = z.infer<typeof zMarketplaceAssign>;
