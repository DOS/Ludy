// SPDX-License-Identifier: AGPL-3.0-only
// A saved column mapping applied on import (#4037, the last part of #3850's flow; plan stock-and-marketplaces.md section 8.6 "Columns": "the mapping is stored per org and platform and applied by code
// afterwards"). When a spreadsheet is no built-in platform profile's (readMarketplaceFile, marketplace-orders.ts), the worker asks the extract sandbox for the file's sheet, whose `headerDigest` is the hash of
// the file's header row; if the org saved a mapping for a file with that same header row (finance.marketplace.columns_confirm, #4206), the file is read once more through the sandbox with that mapping and, when
// the deterministic check accepts it on this file, its lines are staged like any recognised report's: a person still approves them line by line in the existing staged flow. A file with no saved mapping, a
// mapping the check refuses on this file, or a sandbox that cannot answer is left as it was (the check card and Ly's proposal); nothing here decides, saves or sends anything, and there is no AI.
import { EXTRACT_LIMIT_RETRIES, MARKETPLACE_ORDER_FIELDS, encodeMarketplaceColumnsInput, type ExtractClient, type ExtractedMarketplaceColumns, type MarketplaceColumnsInput } from '@crove/extract-contract';
import { zMarketplaceHeaderDigest } from '@crove/kernel-contract';
import { z } from 'zod';
import { defineQuery, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace_columns_apply' };

/** The lines and the summary of an order report as the sandbox reads one (the same shape `marketplace_orders` answers). */
type AppliedOrders = Extract<NonNullable<ExtractedMarketplaceColumns['check']>, { ok: true }>['orders'];

/** The org's latest saved mapping for a file with this header row, as the sandbox takes it: the platform the person picked and one assignment of a column to a field each. */
export type SavedColumns = NonNullable<MarketplaceColumnsInput['mapping']>;

const marketplaceColumnsSaved = defineQuery({
  name: 'finance.marketplace.columns_saved',
  input: z.strictObject({ headerDigest: zMarketplaceHeaderDigest }),
  // The worker's reader only: it looks up a mapping by the hash of a file's header row and tells nothing a person could not read from the profile screen.
  access: 'system',
  handler: async (ctx, input): Promise<SavedColumns | null> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_profile')
      .select(['platform', 'columns'])
      .where('org_id', '=', ctx.orgId)
      .where('header_digest', '=', input.headerDigest)
      // The latest confirmation wins (the same rule as the profile read), whichever platform it was saved for.
      .orderBy('confirmed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    // The stored entries were written through the contract and the table's CHECK; a value they do not hold (a row written by hand) is no mapping.
    const columns = z.array(z.object({ index: z.number().int().min(0), field: z.enum(MARKETPLACE_ORDER_FIELDS) })).safeParse(row.columns);
    const platform = z.enum(['shopee', 'tiktok_shop', 'lazada']).safeParse(row.platform);
    if (!columns.success || !platform.success || columns.data.length === 0) return null;
    return { platform: platform.data, assignments: columns.data.map((c) => ({ index: c.index, field: c.field })).sort((a, b) => a.index - b.index) };
  },
});

export const marketplaceColumnApplyQueries = [marketplaceColumnsSaved];

/**
 * Reads a spreadsheet no built-in profile fits through the org's saved mapping for its header row, or returns null (no saved mapping, the check refuses it on this file, or the sandbox could not answer).
 * A limit the sandbox hit (time or memory) throws on the first attempts so the job runs again, as the first read does; any other failure is a null: the file stays as the first read left it.
 */
export async function readWithSavedColumns(deps: { runtime: Runtime; extract: ExtractClient }, orgId: string, bytes: Uint8Array, attempt: number): Promise<AppliedOrders | null> {
  const fileBase64 = Buffer.from(bytes).toString('base64');
  const failed = (code: string): null => {
    if ((code === 'timeout' || code === 'memory') && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${code}`);
    return null;
  };
  const sheet = await deps.extract.extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64 })).catch(() => null);
  if (!sheet) return null;
  if (!sheet.ok) return failed(sheet.code);
  const digest = sheet.columns.sheet?.headerDigest;
  if (digest === undefined) return null;
  const saved = await deps.runtime.query<SavedColumns | null>('finance.marketplace.columns_saved', { headerDigest: digest }, { actor: SYSTEM, orgId });
  if (!saved) return null;
  const read = await deps.extract
    .extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64, mapping: saved }))
    .catch(() => null);
  if (!read) return null;
  if (!read.ok) return failed(read.code);
  const check = read.columns.check;
  return check?.ok ? check.orders : null;
}
