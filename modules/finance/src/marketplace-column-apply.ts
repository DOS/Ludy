// SPDX-License-Identifier: AGPL-3.0-only
// A saved column mapping applied on import (#4037, the last part of #3850's flow; plan stock-and-marketplaces.md section 8.6 "Columns": "the mapping is stored per org and platform and applied by code
// afterwards"). When a spreadsheet is no built-in platform profile's (readMarketplaceFile, marketplace-orders.ts), the worker first asks the database for the org's saved mappings (none: nothing more is
// done, and the sandbox is not called). With some, it asks the extract sandbox for the file's sheet, whose `headerDigest` is the hash of the file's header row; if the org saved a mapping for a file with that
// same header row (finance.marketplace.columns_confirm, #4206) and the header texts it saved are the ones in this file at the same columns, the file is read once more through the sandbox with that mapping
// and, when the deterministic check accepts it on this file, its lines are staged like any recognised report's: a person still approves them line by line in the existing staged flow. A file with no saved
// mapping, a mapping the check refuses on this file, or one whose headers moved is left as it was (the check card and Ly's proposal). A sandbox that cannot answer throws, as the first read does, so the job
// runs again; nothing here decides, saves or sends anything, and there is no AI.
import { EXTRACT_LIMIT_RETRIES, MARKETPLACE_ORDER_FIELDS, encodeMarketplaceColumnsInput, type ExtractClient, type ExtractedMarketplaceColumns, type MarketplaceColumnsInput } from '@crove/extract-contract';
import { sql } from 'kysely';
import { z } from 'zod';
import { defineQuery, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace_columns_apply' };
// How many saved mappings the worker holds in mind at once: one per header row, the newest first. An org that saved more is a different kind of org; the newest are enough.
const SAVED_LIMIT = 50;

type AppliedOrders = Extract<NonNullable<ExtractedMarketplaceColumns['check']>, { ok: true }>['orders'];

/** One saved mapping the org holds, the latest for its header row: the hash of that row, the platform the person picked and the columns as saved (the header text as the file worded it, and the field). */
export interface SavedMapping {
  headerDigest: string;
  platform: NonNullable<MarketplaceColumnsInput['mapping']>['platform'];
  columns: Array<{ index: number; header: string; field: NonNullable<MarketplaceColumnsInput['mapping']>['assignments'][number]['field'] }>;
}

const zSavedColumns = z.array(z.object({ index: z.number().int().min(0), header: z.string(), field: z.enum(MARKETPLACE_ORDER_FIELDS) }));
const zPlatform = z.enum(['shopee', 'tiktok_shop', 'lazada']);

const marketplaceColumnsSaved = defineQuery({
  name: 'finance.marketplace.columns_saved',
  input: z.strictObject({}),
  // The worker's reader only: the org's saved mappings, as the profile screen would show them, found for a file by the hash of its header row.
  access: 'system',
  handler: async (ctx): Promise<SavedMapping[]> => {
    // The latest confirmation for each header row (whichever platform it was saved for), the newest first.
    const { rows } = await sql<{ header_digest: string; platform: string; columns: unknown }>`
      SELECT header_digest, platform, columns FROM (
        SELECT DISTINCT ON (header_digest) header_digest, platform, columns, confirmed_at, id
          FROM crove_finance.marketplace_column_profile
         WHERE org_id = ${ctx.orgId}::uuid
         ORDER BY header_digest, confirmed_at DESC, id DESC) latest
       ORDER BY confirmed_at DESC, id DESC
       LIMIT ${SAVED_LIMIT}`.execute(ctx.trx);
    return rows.flatMap((r) => {
      // The stored entries were written through the contract and the table's CHECK; a value they do not hold (a row written by hand) is no mapping.
      const columns = zSavedColumns.safeParse(r.columns);
      const platform = zPlatform.safeParse(r.platform);
      return columns.success && platform.success && columns.data.length > 0 ? [{ headerDigest: r.header_digest, platform: platform.data, columns: columns.data }] : [];
    });
  },
});

export const marketplaceColumnApplyQueries = [marketplaceColumnsSaved];

/**
 * Reads a spreadsheet no built-in profile fits through the org's saved mapping for its header row, or returns null (no saved mapping, the file's headers are not the saved ones, or the check refuses the
 * mapping on this file). A sandbox that does not answer throws, and a limit it hit (time or memory) too while attempts remain, so the job runs again as it does for the first read.
 */
export async function readWithSavedColumns(deps: { runtime: Runtime; extract: ExtractClient }, orgId: string, bytes: Uint8Array, attempt: number): Promise<AppliedOrders | null> {
  // Nothing saved, nothing to apply: the common case costs one query and no sandbox call.
  const saved = await deps.runtime.query<SavedMapping[]>('finance.marketplace.columns_saved', {}, { actor: SYSTEM, orgId });
  if (saved.length === 0) return null;
  const fileBase64 = Buffer.from(bytes).toString('base64');
  const failed = (code: string): null => {
    if ((code === 'timeout' || code === 'memory') && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${code}`);
    return null;
  };
  const sheet = await deps.extract.extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64 }));
  if (!sheet.ok) return failed(sheet.code);
  const digest = sheet.columns.sheet?.headerDigest;
  const mapping = digest === undefined ? undefined : saved.find((s) => s.headerDigest === digest);
  if (!mapping || !sheet.columns.sheet) return null;
  // The same words under the same column numbers: a hash of the words alone would take a file with a blank column inserted for the saved layout.
  const headers = new Map(sheet.columns.sheet.columns.map((c) => [c.index, c.header]));
  if (!mapping.columns.every((c) => headers.get(c.index) === c.header)) return null;
  const read = await deps.extract.extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64, mapping: { platform: mapping.platform, assignments: mapping.columns.map((c) => ({ index: c.index, field: c.field })) } }));
  if (!read.ok) return failed(read.code);
  const check = read.columns.check;
  return check?.ok ? check.orders : null;
}
