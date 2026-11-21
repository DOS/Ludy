// SPDX-License-Identifier: AGPL-3.0-only
// The check of a column mapping on an unrecognised marketplace order report (#4036, slice 1c of #3850; plan stock-and-marketplaces.md section 8.6 "Columns"). The file is read by the worker in the extract
// sandbox (the API has no access to it), so a member's request is a row and a job: `columnsCheck` files it, `columns` reads what the worker found, and `columnsProposal` asks the finance coworker (Ly) for a
// first mapping from the masked sheet alone. Nothing is imported or saved from a mapping here; saving a confirmed mapping is #4037.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MARKETPLACE_COLUMN_PLATFORMS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export const MARKETPLACE_COLUMN_FIELDS = ['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount'] as const;
export const MARKETPLACE_COLUMN_REFUSALS = ['no_header', 'bad_column', 'buyer_column', 'field_twice', 'column_twice', 'no_order_no', 'no_line', 'nothing_read', 'row_stops_file', 'too_many_rows', 'rows_without_order', 'return_without_status', 'quantity_exceeds_amount', 'dates_swapped', 'buyer_text'] as const;
export const MARKETPLACE_COLUMN_FAILURES = ['not_a_sheet', 'too_large', 'unavailable', 'unreadable'] as const;
// A check asked this long ago and still waiting is read as lost: the server then lets a press ask again, and the screen stops waiting and says so (a lost job must not block the file for ever).
export const MARKETPLACE_COLUMN_RUNNING_MINUTES = 10;
// The lines a member sees before anything is saved: no more than this many.
export const MARKETPLACE_COLUMN_PREVIEW_LINES = 20;
// A check, its masked sheet and its preview (personal data) are deleted by the nightly retention this many days after the check finished.
export const MARKETPLACE_COLUMN_CHECK_RETENTION_DAYS = 7;

const zColumnIndex = z.number().int().min(0).max(16_383);
export const zMarketplaceColumnAssignment = z.strictObject({ index: zColumnIndex, field: z.enum(MARKETPLACE_COLUMN_FIELDS) });
export type MarketplaceColumnAssignment = z.infer<typeof zMarketplaceColumnAssignment>;
// The platform is the person's pick, never the model's; one assignment per standard field at most.
export const zMarketplaceColumnMapping = z.strictObject({
  platform: z.enum(MARKETPLACE_COLUMN_PLATFORMS),
  assignments: z.array(zMarketplaceColumnAssignment).min(1).max(MARKETPLACE_COLUMN_FIELDS.length),
});
export type MarketplaceColumnMapping = z.infer<typeof zMarketplaceColumnMapping>;

// A member asks for the sheet alone (no mapping) or for a mapping to be checked on the real file.
export const zMarketplaceColumnsCheckAsk = z.strictObject({ fileId: zId, mapping: zMarketplaceColumnMapping.optional() });
export type MarketplaceColumnsCheckAsk = z.infer<typeof zMarketplaceColumnsCheckAsk>;
export const zMarketplaceColumnsCheckQueued = z.strictObject({ queued: z.boolean(), running: z.boolean() });
export type MarketplaceColumnsCheckQueued = z.infer<typeof zMarketplaceColumnsCheckQueued>;

// The masked sheet: header texts and the SHAPES of a few values (never a value), a buyer column an empty shell. The same rules as the sandbox's answer (packages/extract-contract marketplace_columns): a sample is
// held to the character class a shape uses (9 for a digit, a for a letter, spaces and the marks of a date or an amount), so what the worker records, what the screen reads and what the model is told can only ever be
// shapes, and a buyer column carries no header and no sample.
const zSampleShape = z
  .string()
  .max(12)
  .regex(/^[9a \-/.,:;@#()+%_]*$/, 'a masked shape');
export const zMarketplaceColumnSheet = z.strictObject({
  headerRow: z.number().int().min(0).max(1_048_576),
  // The hash of the file's header row (#4037), made in the sandbox: what a saved mapping is found and checked by. Optional so a sheet stored before it existed still reads (its check must be asked again to be saved).
  headerDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  columns: z
    .array(
      z
        .strictObject({ index: zColumnIndex, header: z.string().max(80), samples: z.array(zSampleShape).max(3), buyer: z.boolean() })
        .refine((c) => !c.buyer || (c.header === '' && c.samples.length === 0), 'a buyer column carries nothing'),
    )
    .max(60),
});
export type MarketplaceColumnSheet = z.infer<typeof zMarketplaceColumnSheet>;

// One parsed line as the confirm screen shows it: only these fields. A line can carry a buyer's text when a column was mapped by hand, so the preview is personal data (kept at most seven days).
export const zMarketplaceColumnPreviewLine = z.strictObject({
  rowNo: z.number().int().positive().max(1_048_576),
  orderNo: z.string().max(64),
  lineKey: z.string().max(120),
  sku: z.string().max(100).nullable(),
  itemName: z.string().max(200).nullable(),
  quantity: z.string().max(24),
  amount: z.string().max(40).nullable(),
  status: z.string().max(100).nullable(),
});
export type MarketplaceColumnPreviewLine = z.infer<typeof zMarketplaceColumnPreviewLine>;
export const zMarketplaceColumnPreview = z.strictObject({
  lines: z.array(zMarketplaceColumnPreviewLine).max(MARKETPLACE_COLUMN_PREVIEW_LINES),
  // How many lines the mapping reads in all, and how many rows it skipped (a totals row, for one).
  total: z.number().int().min(0).max(20_000),
  skipped: z.number().int().min(0).max(1_048_576),
});
export type MarketplaceColumnPreview = z.infer<typeof zMarketplaceColumnPreview>;

// The org's unrecognised spreadsheets the screen offers a column check for: newest first, at most this many, each with where its check stands (`none` before anyone asked).
export const MARKETPLACE_COLUMN_FILES_LIMIT = 10;
export const zMarketplaceColumnsFile = z.strictObject({
  fileId: zId,
  filename: z.string().max(255),
  createdAt: z.string(),
  state: z.enum(['none', 'requested', 'done', 'failed']),
});
export type MarketplaceColumnsFile = z.infer<typeof zMarketplaceColumnsFile>;

// What the worker found for a file: `none` before anyone asked. `sheet` is kept across requests; `refusal` and `preview` belong to the mapping asked last.
export const zMarketplaceColumnsStatus = z.strictObject({
  state: z.enum(['none', 'requested', 'done', 'failed']),
  failure: z.enum(MARKETPLACE_COLUMN_FAILURES).nullable(),
  refusal: z.enum(MARKETPLACE_COLUMN_REFUSALS).nullable(),
  mapping: zMarketplaceColumnMapping.nullable(),
  requestedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  sheet: zMarketplaceColumnSheet.nullable(),
  preview: zMarketplaceColumnPreview.nullable(),
});
export type MarketplaceColumnsStatus = z.infer<typeof zMarketplaceColumnsStatus>;

// What the worker records (system only): the sheet, and for a mapping the check's verdict. `requestedAt` is the version of the request it ran for: a later request makes the record a no-op.
export const zMarketplaceColumnsRecord = z.strictObject({
  fileId: zId,
  requestedAt: z.string(),
  result: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('done'), sheet: zMarketplaceColumnSheet.nullable(), refusal: z.enum(MARKETPLACE_COLUMN_REFUSALS).nullable(), preview: zMarketplaceColumnPreview.nullable() }),
    z.strictObject({ state: z.literal('failed'), failure: z.enum(MARKETPLACE_COLUMN_FAILURES) }),
  ]),
});
export type MarketplaceColumnsRecord = z.infer<typeof zMarketplaceColumnsRecord>;

// Ly's first mapping, from the masked sheet alone (never the lines, never a value): `none` (fewer than three columns to show), `off` (no model), `busy` (too frequent), `budget` (the AI budget is spent),
// `failed` (the call failed or every answer was dropped; the reason is logged as a code, never the words) or `used`. The proposal is only a first mapping for the screen to check on the real file.
export const zMarketplaceColumnsProposalAsk = z.strictObject({ fileId: zId, lang: z.enum(['vi', 'en']).optional() });
export type MarketplaceColumnsProposalAsk = z.infer<typeof zMarketplaceColumnsProposalAsk>;
export const zMarketplaceColumnsProposal = z.strictObject({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'none']),
  assignments: z.array(zMarketplaceColumnAssignment).max(MARKETPLACE_COLUMN_FIELDS.length),
});
export type MarketplaceColumnsProposal = z.infer<typeof zMarketplaceColumnsProposal>;
