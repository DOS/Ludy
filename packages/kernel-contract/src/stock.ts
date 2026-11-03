// SPDX-License-Identifier: AGPL-3.0-only
// Items of stock, the names a source uses for them, and the moves of stock (#2512, ADR-0045 point 1): the shapes the finance commands and the "Hàng hóa" screen
// share. Quantities and amounts are decimal strings, never numbers. A move is append-only: a correction is a reversing move.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const STOCK_ITEM_KINDS = ['goods'] as const;
export const STOCK_TRADES = ['goods', 'services', 'catering', 'other'] as const;
export type StockTradeKey = (typeof STOCK_TRADES)[number];
export const STOCK_MOVE_SOURCES = ['document_line', 'manual', 'reversal'] as const;
export type StockMoveSourceKey = (typeof STOCK_MOVE_SOURCES)[number];

// A signed decimal quantity with at most six decimals, not zero.
export const zStockQuantity = z.string().regex(/^-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/).refine((v) => !/^-?0(?:\.0+)?$/.test(v), 'not zero');

export const zStockItemInput = z.strictObject({
  // Left out to make an item; set to edit one (its code and entity then stay as they are).
  itemId: zId.nullable(),
  legalEntityId: zId.nullable(),
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/),
  name: z.string().trim().min(1).max(300),
  unit: z.string().trim().min(1).max(30),
  // The chart account the item is booked to (156 for goods, or a sub-account of it).
  stockAccount: z.string().trim().regex(/^[0-9]{3,4}(\.[A-Za-z0-9_-]{1,30})?$/),
  trade: z.enum(STOCK_TRADES),
});
export type StockItemInput = z.infer<typeof zStockItemInput>;

export const zStockItem = z.object({
  id: zId,
  legalEntityId: zId,
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  kind: z.enum(STOCK_ITEM_KINDS),
  stockAccount: z.string(),
  trade: z.enum(STOCK_TRADES),
  active: z.boolean(),
  // The sum of the item's moves (a decimal string); negative is allowed and shown as a warning.
  onHand: z.string(),
  // How many moves the item has: an item with moves keeps its unit and account.
  moves: z.number().int(),
});
export type StockItem = z.infer<typeof zStockItem>;

// How many of the item's units one of the source's is (a carton of 12), a decimal string above zero.
export const zStockFactor = z.string().regex(/^(?:0\.[0-9]{0,5}[1-9]|[1-9][0-9]{0,11}(?:\.[0-9]{1,6})?)$/);

export const zStockAliasTeach = z.strictObject({
  itemId: zId,
  source: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  // The name as the source writes it, or the SKU; the server normalizes it.
  key: z.string().trim().min(1).max(300),
  factor: zStockFactor,
});
export type StockAliasTeach = z.infer<typeof zStockAliasTeach>;

export const zStockMove = z.object({
  id: zId,
  itemId: zId,
  legalEntityId: zId,
  date: z.string(),
  quantity: z.string(),
  source: z.enum(STOCK_MOVE_SOURCES),
  documentId: zId.nullable(),
  lineNo: z.number().int().nullable(),
  reversesMoveId: zId.nullable(),
  // Reversed by another move already.
  reversed: z.boolean(),
});
export type StockMove = z.infer<typeof zStockMove>;

export const zStockUnassignedInput = z.strictObject({ legalEntityId: zId.optional(), limit: z.number().int().min(1).max(500).optional() });

// A goods line of a posted document that moved no stock: it matched no item by code or by a taught name ("Chua gan hang").
export const zStockUnassignedLine = z.object({
  documentId: zId,
  lineNo: z.number().int(),
  legalEntityId: zId,
  direction: z.enum(['purchase', 'sale']),
  invoiceDate: z.string(),
  invoiceSeries: z.string(),
  invoiceNumber: z.string(),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string(),
});
export type StockUnassignedLine = z.infer<typeof zStockUnassignedLine>;

// Assigns a line to an item: writes its move and, unless told not to, teaches the line's name as an alias of the item with the factor.
export const zStockAssign = z.strictObject({
  documentId: zId,
  lineNo: z.number().int().positive(),
  itemId: zId,
  factor: zStockFactor.default('1'),
  teach: z.boolean().default(true),
});
export type StockAssign = z.infer<typeof zStockAssign>;
