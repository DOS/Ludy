// SPDX-License-Identifier: AGPL-3.0-only
// The check of a column mapping on a marketplace order report no platform profile fits (#4036, slice 1c of #3850; plan stock-and-marketplaces.md section 8.6 "Columns").
// The file is read in the extract sandbox, which only the worker reaches, so the API never reads it: a member asks, the worker reads the file through the sandbox, and records what it found.
// - finance.marketplace.columns_check (owners, admins and members; a person, never an agent): files the request (the sheet alone, or the platform the person picked and a mapping to check) and queues the
//   worker's job. A second press while a check asked in the last ten minutes for the same thing still waits returns that one and queues nothing.
// - finance.marketplace.columns_target (system; query): what the worker needs for one file, or why it must not read it.
// - finance.marketplace.columns_record (system only): records the masked sheet and the check's verdict (a refusal, or a preview of at most 20 parsed lines) and marks the check done or failed.
// - finance.marketplace.columns (importers; query): the last check of a file and what it found, for the screen.
// - finance.marketplace.columns_files (importers; query): the unrecognised spreadsheets the screen offers a check for, with where each check stands.
// Nothing is imported or saved from a mapping here; saving a confirmed mapping is #4037. The preview lines are personal data (registry): the job carries ids only, and neither the audit row nor an error holds
// a line.
import { z } from 'zod';
import {
  MARKETPLACE_COLUMN_FILES_LIMIT,
  zId,
  zMarketplaceColumnMapping,
  zMarketplaceColumnPreview,
  zMarketplaceColumnSheet,
  zMarketplaceColumnsCheckAsk,
  zMarketplaceColumnsRecord,
  type MarketplaceColumnMapping,
  type MarketplaceColumnsCheckQueued,
  type MarketplaceColumnsFile,
  type MarketplaceColumnsStatus,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The spreadsheets a report arrives as (an .xlsx may be stored as a ZIP), as the report readers take them.
const SHEET_TYPES = ['application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
// A file the worker's readers took for a bank statement or a marketplace report is not this path's: only a spreadsheet whose latest run is `unsupported` and names none of those kinds is.
const READ_KINDS = ['bank_statement', 'marketplace_orders', 'marketplace_income'];
// A check asked this recently and still waiting is the running one; later than that a press asks again (a lost job must not block the file for ever).
const RUNNING_MS = 10 * 60 * 1000;

export const MARKETPLACE_COLUMN_CHECK_REQUESTED = 'finance.marketplace_column_check.requested';

const iso = (value: Date | string): string => new Date(value).toISOString();
const notFound = () => new DomainError('MARKETPLACE_COLUMNS_NOT_FOUND', 404, 'Không tìm thấy báo cáo chưa nhận ra này');

/** Whether a stored request is for the mapping asked: the platform and every assignment, in order. Compared field by field: the database stores a jsonb object with its keys in its own order, so the text of
 * the stored array is never the text of the parsed input. */
export function sameMapping(stored: { platform: string | null; assignments: unknown }, asked: MarketplaceColumnMapping | undefined): boolean {
  if ((stored.platform ?? null) !== (asked?.platform ?? null)) return false;
  const have = Array.isArray(stored.assignments) ? (stored.assignments as Array<{ index?: unknown; field?: unknown }>) : [];
  const want = asked?.assignments ?? [];
  return have.length === want.length && want.every((a, i) => have[i]?.index === a.index && have[i]?.field === a.field);
}

// The org's own spreadsheet that no reader of the worker took, with its original still there; null for any other file (an invoice, a bank statement, a recognised report, a file of another org).
async function unrecognisedSheet(ctx: CommandContext | QueryContext, fileId: string): Promise<{ id: string; storage_key: string; generation: string | null; sha256: string; size_bytes: number } | null> {
  const { rows } = await sql<{ id: string; storage_key: string; generation: string | null; sha256: string; size_bytes: number }>`
    SELECT f.id::text AS id, f.storage_key, f.generation, f.sha256, f.size_bytes::bigint::int AS size_bytes
      FROM crove_kernel.file f
     WHERE f.org_id = ${ctx.orgId}::uuid AND f.id = ${fileId}::uuid AND f.original_deleted_at IS NULL
       AND f.content_type = ANY(${SHEET_TYPES}::text[])
       AND EXISTS (
         SELECT 1 FROM crove_kernel.extraction x
          WHERE x.org_id = f.org_id AND x.file_id = f.id AND x.method = 'unsupported'
            AND x.version = (SELECT max(v.version) FROM crove_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
            AND coalesce(x.result ->> 'kind', '') <> ALL(${READ_KINDS}::text[]))`.execute(ctx.trx);
  return rows[0] ?? null;
}

export const marketplaceColumnsCheck = defineCommand({
  name: 'finance.marketplace.columns_check',
  input: zMarketplaceColumnsCheckAsk,
  // It files a request and queues a job that reads the file in the sandbox (no egress); it posts nothing and changes no book.
  risk: 'R1',
  sideEffect: 'internal',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplaceColumnsCheckQueued> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới yêu cầu kiểm tra được các cột của báo cáo');
    const file = await unrecognisedSheet(ctx, input.fileId);
    if (!file) throw notFound();
    const platform = input.mapping?.platform ?? null;
    const assignments = JSON.stringify(input.mapping?.assignments ?? []);
    const existing = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_check')
      .select(['id', 'state', 'platform', 'assignments', 'requested_at'])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .forUpdate()
      .executeTakeFirst();
    // The waiting one is returned only when it is for the same thing: a press for another mapping files it anew (an older job's record is then ignored).
    if (existing && existing.state === 'requested' && ctx.now.getTime() - new Date(existing.requested_at).getTime() < RUNNING_MS && sameMapping(existing, input.mapping)) {
      ctx.audit({ requested: false, running: true });
      return { queued: false, running: true };
    }
    if (existing) {
      // A new request clears the earlier verdict and preview (they belong to the earlier mapping) and keeps the sheet (the file's own); the guard allows no other move.
      await ctx.trx
        .updateTable('crove_finance.marketplace_column_check')
        .set({ platform, assignments, state: 'requested', failure: null, refusal: null, preview: null, requested_by: ctx.actor.userId, requested_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      try {
        await ctx.trx
          .insertInto('crove_finance.marketplace_column_check')
          .values({ org_id: ctx.orgId, file_id: input.fileId, platform, assignments, requested_by: ctx.actor.userId, requested_at: ctx.now })
          .execute();
      } catch (error: unknown) {
        // Two first requests for the same file at once: the other one filed the row (one row per file). A plain refusal, not a server error; the member presses again and gets the waiting one.
        if ((error as { code?: unknown } | null)?.code === '23505') throw new DomainError('MARKETPLACE_COLUMNS_BUSY', 409, 'Báo cáo này vừa được yêu cầu kiểm tra ở nơi khác; hãy thử lại sau giây lát');
        throw error;
      }
    }
    // The job carries the file's id and nothing else.
    await ctx.emit(MARKETPLACE_COLUMN_CHECK_REQUESTED, { file_id: input.fileId });
    ctx.audit({ requested: true, running: false, mapping: input.mapping !== undefined });
    return { queued: true, running: false };
  },
});

// What the worker needs to read one file, or why it must not: a file that is gone, whose original is deleted, or no longer an unrecognised spreadsheet, or a check that is not waiting (done by an earlier run
// of the same job), is left alone. The storage key and the checksum reach the worker and nothing else.
export type MarketplaceColumnsTarget =
  | { action: 'none'; reason: 'not_found' | 'not_requested' }
  | { action: 'check'; fileId: string; storageKey: string; generation: string | null; sha256: string; sizeBytes: number; requestedAt: string; mapping: MarketplaceColumnMapping | null };

export const marketplaceColumnsTarget = defineQuery({
  name: 'finance.marketplace.columns_target',
  input: z.strictObject({ fileId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MarketplaceColumnsTarget> => {
    const check = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_check')
      .select(['state', 'platform', 'assignments', 'requested_at'])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .executeTakeFirst();
    const file = await unrecognisedSheet(ctx, input.fileId);
    if (!check || !file) return { action: 'none', reason: 'not_found' };
    if (check.state !== 'requested') return { action: 'none', reason: 'not_requested' };
    const parsed = check.platform === null ? null : zMarketplaceColumnMapping.safeParse({ platform: check.platform, assignments: check.assignments });
    // A stored mapping the contract does not hold (a row written by hand) is read as the sheet alone: nothing is checked that was not asked in the shape the contract allows.
    const mapping = parsed?.success ? parsed.data : null;
    return { action: 'check', fileId: input.fileId, storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, sizeBytes: file.size_bytes, requestedAt: iso(check.requested_at), mapping };
  },
});

export const marketplaceColumnsRecord = defineCommand({
  name: 'finance.marketplace.columns_record',
  input: zMarketplaceColumnsRecord,
  // A state, a masked sheet, a refusal code and at most 20 parsed lines on a row; no book, no money, no credential.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    const check = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_check')
      .select(['id', 'state', 'requested_at', 'sheet'])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .forUpdate()
      .executeTakeFirst();
    // A file erased while its check ran, a check another run already recorded, or a request filed again since this run took it (a newer one waits): nothing to record.
    if (!check || check.state !== 'requested' || iso(check.requested_at) !== input.requestedAt) return { recorded: false };
    const result = input.result;
    if (result.state === 'done') {
      // A refusal and a preview are the verdict on one mapping: not both, and neither without the other's absence being a refusal.
      if (result.refusal !== null && result.preview !== null) throw new DomainError('MARKETPLACE_COLUMNS_INVALID', 422, 'Một mapping bị từ chối không có bản xem trước');
      await ctx.trx
        .updateTable('crove_finance.marketplace_column_check')
        .set({
          state: 'done',
          failure: null,
          refusal: result.refusal,
          // The sheet is the file's own: a record without one keeps the one an earlier check stored.
          sheet: result.sheet === null ? check.sheet === null ? null : JSON.stringify(check.sheet) : JSON.stringify(result.sheet),
          preview: result.preview === null ? null : JSON.stringify(result.preview),
          finished_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', check.id)
        .execute();
    } else {
      await ctx.trx
        .updateTable('crove_finance.marketplace_column_check')
        .set({ state: 'failed', failure: result.failure })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', check.id)
        .execute();
    }
    // The state, the failure code and the refusal code only: nothing of the sheet or the preview (the audit scan refuses a fact that reads the classified preview column, and no count of it is wanted).
    ctx.audit({ state: result.state, failure: result.state === 'failed' ? result.failure : null, refusal: result.state === 'done' ? result.refusal : null });
    return { recorded: true };
  },
});

const zSheetOrNull = zMarketplaceColumnSheet.nullable();
const zPreviewOrNull = zMarketplaceColumnPreview.nullable();

export const marketplaceColumns = defineQuery({
  name: 'finance.marketplace.columns',
  input: z.strictObject({ fileId: zId }),
  access: IMPORTERS,
  handler: async (ctx, input): Promise<MarketplaceColumnsStatus> => {
    const file = await unrecognisedSheet(ctx, input.fileId);
    if (!file) throw notFound();
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_check')
      .select(['state', 'failure', 'refusal', 'platform', 'assignments', 'requested_at', 'finished_at', 'sheet', 'preview'])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .executeTakeFirst();
    if (!row) return { state: 'none', failure: null, refusal: null, mapping: null, requestedAt: null, finishedAt: null, sheet: null, preview: null };
    const mapping = row.platform === null ? null : zMarketplaceColumnMapping.safeParse({ platform: row.platform, assignments: row.assignments });
    // What the table holds was written through the record command's schema; a value the contract does not hold (a row written by hand) is read as absent, never passed on.
    const sheet = zSheetOrNull.safeParse(row.sheet);
    const preview = zPreviewOrNull.safeParse(row.preview);
    return {
      state: row.state,
      failure: row.failure,
      refusal: row.refusal,
      mapping: mapping?.success ? mapping.data : null,
      requestedAt: iso(row.requested_at),
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
      sheet: sheet.success ? sheet.data : null,
      preview: preview.success ? preview.data : null,
    };
  },
});

// The org's unrecognised spreadsheets for the screen's card: the same test as `unrecognisedSheet`, newest first, with where each check stands. Names and states only: no sheet, no preview.
export const marketplaceColumnsFiles = defineQuery({
  name: 'finance.marketplace.columns_files',
  input: z.strictObject({}),
  access: IMPORTERS,
  handler: async (ctx): Promise<MarketplaceColumnsFile[]> => {
    const { rows } = await sql<{ id: string; filename: string; created_at: Date | string; state: string | null }>`
      SELECT f.id::text AS id, f.filename, f.created_at, c.state
        FROM crove_kernel.file f
        LEFT JOIN crove_finance.marketplace_column_check c ON c.org_id = f.org_id AND c.file_id = f.id
       WHERE f.org_id = ${ctx.orgId}::uuid AND f.original_deleted_at IS NULL
         AND f.content_type = ANY(${SHEET_TYPES}::text[])
         AND EXISTS (
           SELECT 1 FROM crove_kernel.extraction x
            WHERE x.org_id = f.org_id AND x.file_id = f.id AND x.method = 'unsupported'
              AND x.version = (SELECT max(v.version) FROM crove_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
              AND coalesce(x.result ->> 'kind', '') <> ALL(${READ_KINDS}::text[]))
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ${MARKETPLACE_COLUMN_FILES_LIMIT}`.execute(ctx.trx);
    return rows.map((r) => ({ fileId: r.id, filename: r.filename, createdAt: iso(r.created_at), state: (r.state ?? 'none') as MarketplaceColumnsFile['state'] }));
  },
});

export const marketplaceColumnsCommands = [marketplaceColumnsCheck, marketplaceColumnsRecord];
export const marketplaceColumnsQueries = [marketplaceColumnsTarget, marketplaceColumns, marketplaceColumnsFiles];
