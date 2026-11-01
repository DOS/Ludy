// SPDX-License-Identifier: AGPL-3.0-only
// Contact import (#2229, docs/plan/crm.md step K5): a person reads a CSV of contacts and companies in the browser, maps its
// columns, and posts the rows. The server stages them with how each one was classified, the person looks at the preview,
// and only then commits, which creates the new parties. Nothing is written to `party` before the commit.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_PREVIEW_PAGE = 100;
// A staged batch older than this is refused and its rows are deleted: they carry personal data.
export const IMPORT_STAGED_DAYS = 7;

export const IMPORT_OUTCOMES = ['new', 'duplicate', 'conflict', 'invalid'] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
export const IMPORT_ON_DUPLICATE = ['skip', 'fill_empty'] as const;
export type ImportOnDuplicate = (typeof IMPORT_ON_DUPLICATE)[number];
export const IMPORT_STATUSES = ['staged', 'committed', 'cancelled', 'expired'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

// Why a row is not a new party: a code, never a value from the file.
export const IMPORT_REASONS = [
  'INVALID_NAME',
  'INVALID_TAX_CODE',
  'INVALID_EMAIL',
  'INVALID_PHONE',
  'INVALID_ADDRESS',
  'DUPLICATE_TAX_CODE',
  'DUPLICATE_EMAIL',
  'DUPLICATE_PHONE',
  'DUPLICATE_IN_FILE',
  'CONFLICT_PARTIES',
] as const;
export type ImportReason = (typeof IMPORT_REASONS)[number];

// A row as the file had it, after the person mapped its columns: text, or empty. `kind` is the file's own word for a
// person or a company when it has one; the server decides the rest.
const zCell = (max: number) => z.string().max(max).nullable();
export const zImportRowInput = z.strictObject({
  kind: z.string().max(100).nullable(),
  name: z.string().max(1000),
  taxCode: zCell(100),
  email: zCell(1000),
  phone: zCell(200),
  address: zCell(2000),
});
export type ImportRowInput = z.infer<typeof zImportRowInput>;

export const zImportStage = z.strictObject({
  filename: z.string().trim().min(1).max(255),
  rows: z.array(zImportRowInput).min(1).max(IMPORT_MAX_ROWS),
});
export type ImportStage = z.infer<typeof zImportStage>;

export const zImportRef = z.strictObject({ batchId: zId });
export const zImportCommit = z.strictObject({ batchId: zId, onDuplicate: z.enum(IMPORT_ON_DUPLICATE) });
export const zImportPreviewQuery = z.strictObject({
  batchId: zId,
  outcome: z.enum(IMPORT_OUTCOMES).optional(),
  // The last row number of the page before; rows come in file order.
  after: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(IMPORT_PREVIEW_PAGE).optional(),
});

export interface ImportBatch {
  id: string;
  filename: string;
  status: ImportStatus;
  onDuplicate: ImportOnDuplicate;
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  conflictRows: number;
  invalidRows: number;
  createdRows: number;
  updatedRows: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface ImportPreviewRow {
  rowNo: number;
  kind: 'organization' | 'person';
  name: string;
  taxCode: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  outcome: ImportOutcome;
  reason: ImportReason | null;
  // The existing party a duplicate matched.
  match: { partyId: string; name: string } | null;
}

export interface ImportPreview {
  batch: ImportBatch;
  rows: ImportPreviewRow[];
  more: boolean;
}

// What a commit did, and the rows it did not import with the code of why (the browser still holds the file, so it can
// offer them again).
export interface ImportCommitted {
  batch: ImportBatch;
  skipped: { rowNo: number; reason: ImportReason }[];
}

const zIso = z.string();
export const zImportBatch = z.object({
  id: zId,
  filename: z.string(),
  status: z.enum(IMPORT_STATUSES),
  onDuplicate: z.enum(IMPORT_ON_DUPLICATE),
  totalRows: z.number().int(),
  newRows: z.number().int(),
  duplicateRows: z.number().int(),
  conflictRows: z.number().int(),
  invalidRows: z.number().int(),
  createdRows: z.number().int(),
  updatedRows: z.number().int(),
  createdAt: zIso,
  decidedAt: zIso.nullable(),
});
export const zImportPreview = z.object({
  batch: zImportBatch,
  rows: z.array(
    z.object({
      rowNo: z.number().int(),
      kind: z.enum(['organization', 'person']),
      name: z.string(),
      taxCode: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      address: z.string().nullable(),
      outcome: z.enum(IMPORT_OUTCOMES),
      reason: z.enum(IMPORT_REASONS).nullable(),
      match: z.object({ partyId: zId, name: z.string() }).nullable(),
    }),
  ),
  more: z.boolean(),
});
export const zImportCommitted = z.object({
  batch: zImportBatch,
  skipped: z.array(z.object({ rowNo: z.number().int(), reason: z.enum(IMPORT_REASONS) })),
});
