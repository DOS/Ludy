// SPDX-License-Identifier: AGPL-3.0-only
// Items of stock, the names a source uses for them, and the moves of stock (#2512, ADR-0045 point 1): the shapes the finance commands and the "Hàng hóa" screen
// share. Quantities and amounts are decimal strings, never numbers. A move is append-only: a correction is a reversing move.
import { z } from 'zod';
import { zId, zJournalVoucherProposal, zLocalDate } from './schemas.ts';

export const STOCK_ITEM_KINDS = ['goods'] as const;
export const STOCK_TRADES = ['goods', 'services', 'catering', 'other'] as const;
export type StockTradeKey = (typeof STOCK_TRADES)[number];
export const STOCK_MOVE_SOURCES = ['document_line', 'manual', 'reversal', 'order_line', 'count'] as const;
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
  stockAccount: z.string().trim().regex(/^[0-9]{3,10}(\.[A-Z0-9]{1,20})?$/),
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
export const zStockFactor = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/)
  .refine((value) => /[1-9]/.test(value), 'above zero');

export const zStockAliasTeach = z.strictObject({
  itemId: zId,
  source: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  // The name as the source writes it, or the SKU; the server normalizes it.
  key: z.string().trim().min(1).max(300),
  factor: zStockFactor,
  // The unit of the source the factor was taught in: the name matches a line in that unit only.
  unit: z.string().trim().min(1).max(40).optional(),
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

// The month of a report: YYYY-MM, 2000 to 2099, so the month after is always a date the database takes.
export const zStockMonth = z.string().regex(/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/);

export const zStockReportInput = z.strictObject({ month: zStockMonth, legalEntityId: zId.optional() });

// One item's month, the weighted average way (#2513): quantity and value at the opening, in, out and at the closing, and the unit cost the month's goods leave at. Every figure is
// a decimal string. Provisional until a person closes the month.
export const zStockReportRow = z.object({
  itemId: zId,
  legalEntityId: zId,
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  openingQuantity: z.string(),
  openingValue: z.string(),
  inQuantity: z.string(),
  inValue: z.string(),
  outQuantity: z.string(),
  outValue: z.string(),
  closingQuantity: z.string(),
  closingValue: z.string(),
  unitCost: z.string().nullable(),
  // True when the month is closed for the item's entity: the figures are what the close stored, not a provisional average.
  closed: z.boolean(),
});
export type StockReportRow = z.infer<typeof zStockReportRow>;

export const zStockCardInput = z.strictObject({ itemId: zId, month: zStockMonth });

// A month a person closed (#2513): the cost of goods sold that was posted for it, as a voucher of the books (null when nothing left the stock).
export const zStockPeriodsInput = z.strictObject({ legalEntityId: zId.optional() });
export const zStockPeriod = z.object({ id: zId, legalEntityId: zId, month: zStockMonth, totalCost: z.string(), voucherId: zId.nullable(), closedAt: z.string() });
export type StockPeriod = z.infer<typeof zStockPeriod>;

// An item's stock card for a month: its moves in order with the balance after each.
export const zStockCard = z.object({
  item: z.object({ id: zId, legalEntityId: zId, code: z.string(), name: z.string(), unit: z.string() }),
  month: zStockMonth,
  openingQuantity: z.string(),
  closingQuantity: z.string(),
  unitCost: z.string().nullable(),
  // False once the month is closed.
  provisional: z.boolean(),
  moves: z.array(
    z.object({
      id: zId,
      date: z.string(),
      source: z.enum(STOCK_MOVE_SOURCES),
      quantity: z.string(),
      // What came in with it (a purchase line's amount), when it brought value.
      value: z.string().nullable(),
      balance: z.string(),
      documentId: zId.nullable(),
      lineNo: z.number().int().nullable(),
    }),
  ),
});
export type StockCard = z.infer<typeof zStockCard>;

// The close of a month of stock (#2513): the cost of goods sold of the month, Dr 632 / Cr the stock accounts, as a general journal voucher that an owner or an admin approves like any
// posting (R3, four-eyes, fresh MFA). The server builds every line from the moves; a person names the month (and the legal entity).
export const STOCK_CLOSE_COMMAND = 'finance.stock.close_period';
export const zStockCloseRequest = z.strictObject({ month: zStockMonth, legalEntityId: zId.optional() });
export type StockCloseRequest = z.infer<typeof zStockCloseRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the month it closes. The figures stored per item are not in it: approving builds them again from the moves, and
// itemCount and figuresHash (SHA-256 of the canonical figures) are what make a proposal stale when an item's figures changed since it was asked for.
export const zStockCloseProposal = zJournalVoucherProposal.extend({
  closingMonth: zStockMonth,
  itemCount: z.number().int().min(1).max(100000),
  figuresHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StockCloseProposal = z.infer<typeof zStockCloseProposal>;
// A month with no cost to post closes at once, with no entry: the number of items whose figures it stored.
export const zStockCloseEmptyResult = z.object({ periodId: zId, items: z.number().int().min(0) });
export type StockCloseEmptyResult = z.infer<typeof zStockCloseEmptyResult>;

// The finance coworker on stock (#2514). Read-only: a suggestion is never a match (a person assigns the line, which teaches the name), and the low-stock list and the reorder text
// move nothing and send nothing.
// How many days a supplier takes to deliver when the org has not said (a week count of the average sales is read against it), and the bounds a person may set.
export const STOCK_LEAD_DAYS_DEFAULT = 14;
export const STOCK_LEAD_DAYS_MAX = 90;
// Lines asked about in one call and items a reorder message names; the agent reads the same bounds (packages/agent stock.ts).
export const STOCK_SUGGEST_LINES_MAX = 10;
export const STOCK_REORDER_ITEMS_MAX = 20;
export const STOCK_REORDER_HINT_MAX = 200;

// ai: used (the model answered), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent), failed (the call failed or its
// answer was refused), quiet (nothing to ask about). Without an answer the screen works as it does with AI off.
export const zStockAiState = z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']);
export type StockAiState = z.infer<typeof zStockAiState>;

// The goods lines of one legal entity the person is looking at (at most STOCK_SUGGEST_LINES_MAX); the server reads their descriptions from the books, never from the request.
export const zStockSuggestInput = z.strictObject({
  legalEntityId: zId,
  lines: z.array(z.strictObject({ documentId: zId, lineNo: z.number().int().positive() })).min(1).max(STOCK_SUGGEST_LINES_MAX),
  lang: z.enum(['vi', 'en']).optional(),
});
export type StockSuggestInput = z.infer<typeof zStockSuggestInput>;
// A suggestion: the item the coworker thinks the line is about and the one-line reason it gave. The reason is the model's text, shown as such and never stored.
export const zStockSuggestion = z.object({ documentId: zId, lineNo: z.number().int(), itemId: zId, reason: z.string() });
export const zStockSuggested = z.object({ ai: zStockAiState, suggestions: z.array(zStockSuggestion) });
export type StockSuggested = z.infer<typeof zStockSuggested>;

// Items running low: the average sales out of the last eight weeks (or of the days since the item's first move, at least seven) against what is on hand. An item is low when its cover
// (days of sales on hand) is shorter than the lead days. suggestedQuantity covers two lead times of sales, to whole units, less what is on hand.
export const zStockLowInput = z.strictObject({
  legalEntityId: zId.optional(),
  leadDays: z.number().int().min(1).max(STOCK_LEAD_DAYS_MAX).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const zStockLowItem = z.object({
  itemId: zId,
  legalEntityId: zId,
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  onHand: z.string(),
  // Average units out per day, a decimal string.
  dailyOut: z.string(),
  // Whole days the stock on hand lasts at that pace; 0 when nothing is on hand.
  coverDays: z.number().int().min(0),
  suggestedQuantity: z.string(),
  // Whom the item was last bought from (the kept party of a duplicate group), when it was bought through a posted purchase.
  supplier: z.object({ partyId: zId, name: z.string(), email: z.string().nullable() }).nullable(),
});
export type StockLowItem = z.infer<typeof zStockLowItem>;

// A reorder message for one supplier (#2514): the items and the quantities a person chose, from the same legal entity. The server reads the names and the units from the books. A message
// is a draft to read, edit and send from the person's own mail; nothing is sent from here.
export const zStockReorderAsk = z.strictObject({
  legalEntityId: zId,
  supplierPartyId: zId.optional(),
  items: z
    .array(z.strictObject({ itemId: zId, quantity: z.string().regex(/^[0-9]{1,14}(\.[0-9]{1,6})?$/) }))
    .min(1)
    .max(STOCK_REORDER_ITEMS_MAX),
  hint: z.string().trim().max(STOCK_REORDER_HINT_MAX).optional(),
  lang: z.enum(['vi', 'en']).optional(),
});
export type StockReorderAsk = z.infer<typeof zStockReorderAsk>;
// text: the coworker's message when ai is used, else the fixed template with the same lines; always a text the person can edit. The supplier is null when none was named.
export const zStockReorderDraft = z.object({
  ai: zStockAiState,
  supplier: z.object({ partyId: zId, name: z.string(), email: z.string().nullable() }).nullable(),
  text: z.string(),
});
export type StockReorderDraft = z.infer<typeof zStockReorderDraft>;

// The count of stock (kiểm kê, #2513 part b): a person names the day the stock was counted and what was counted of each item; the server works out the difference from the books and, when
// confirmed, posts it as adjustment moves and one entry that an owner or an admin approves like any posting (R3, four-eyes, fresh MFA).
export const STOCK_COUNT_STATUSES = ['draft', 'confirmed', 'cancelled'] as const;
// What was counted: a decimal with at most six decimals, zero allowed (nothing of the item is left).
export const zStockCountQuantity = z.string().regex(/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/);
// A unit cost typed for an item the books have no cost for: a decimal with at most four decimals, above zero.
export const zStockUnitCost = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,4})?$/)
  .refine((v) => !/^0(?:\.0+)?$/.test(v), 'not zero');
export const zStockCountLineInput = z.strictObject({ itemId: zId, countedQuantity: zStockCountQuantity, unitCost: zStockUnitCost.nullable().optional() });
// The norm for a shortage is a percentage of the book quantity, 0 to 100 with two decimals at most.
export const zStockCountCreate = z.strictObject({
  legalEntityId: zId.optional(),
  countDate: zLocalDate,
  note: z.string().trim().max(300).optional(),
  lossNormPercent: z.string().regex(/^(?:100(?:\.0{1,2})?|[0-9]{1,2}(?:\.[0-9]{1,2})?)$/),
  lines: z.array(zStockCountLineInput).min(1).max(2000),
});
export type StockCountCreate = z.infer<typeof zStockCountCreate>;
export const zStockCountIdInput = z.strictObject({ countId: zId });
export const zStockCountListInput = z.strictObject({ legalEntityId: zId.optional(), limit: z.number().int().min(1).max(100).optional() });
// The items of an entity with what the books hold of each on the day, to count against.
export const zStockCountPreviewInput = z.strictObject({ countDate: zLocalDate, legalEntityId: zId.optional() });
export const zStockCountPreviewRow = z.object({ itemId: zId, code: z.string(), name: z.string(), unit: z.string(), bookQuantity: z.string(), averageCost: z.string().nullable() });
export type StockCountPreviewRow = z.infer<typeof zStockCountPreviewRow>;
export const zStockCountLine = z.object({
  itemId: zId,
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  countedQuantity: z.string(),
  // What the books held on the day of the count, and counted minus that (negative for a shortage).
  bookQuantity: z.string(),
  difference: z.string(),
  // The unit cost the difference is priced at, and what it is worth in whole dong, signed like the difference.
  unitCost: z.string().nullable(),
  value: z.string(),
  // For a shortage: the part of its value within the norm.
  withinNorm: z.string(),
});
export const zStockCount = z.object({
  id: zId,
  legalEntityId: zId,
  countDate: zLocalDate,
  status: z.enum(STOCK_COUNT_STATUSES),
  note: z.string().nullable(),
  lossNormPercent: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  voucherId: zId.nullable(),
  // A draft is worked out from the books as they read now; a confirmed count shows what its adjustments made.
  lines: z.array(zStockCountLine),
});
export type StockCount = z.infer<typeof zStockCount>;
export const STOCK_COUNT_COMMAND = 'finance.stock.count_confirm';
// The proposal (kind finance.journal_voucher, shown as one) with the count it posts. The lines of the count are not in it: approving builds them again from the books, and lineCount and
// figuresHash (SHA-256 of the canonical figures) are what make a proposal stale when a figure changed since it was asked for.
export const zStockCountProposal = zJournalVoucherProposal.extend({
  countId: zId,
  lineCount: z.number().int().min(1).max(2000),
  figuresHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StockCountProposal = z.infer<typeof zStockCountProposal>;
