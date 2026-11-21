// SPDX-License-Identifier: AGPL-3.0-only
// The confirmed mapping of a marketplace report's columns (#4037, slice 2 of #3850; plan stock-and-marketplaces.md section 8.6 "Columns": "A person confirms; the mapping is stored per org and platform
// and applied by code afterwards").
// - finance.marketplace.columns_confirm (owners and admins, a person only, never an agent; R1): saves the mapping a person confirmed for a platform, as a new row of
//   crove_finance.marketplace_column_profile (append-only; the latest row of an org and platform wins). It stores the header text of each mapped column and the standard field it is, the row the header was
//   read from and the digest of the whole header row, and nothing else: no cell value, no sample, no buyer column.
// - finance.marketplace.columns_profile (every member reads): the latest profile of the org and a platform, or null.
//
// What is checked here and what is not. The kernel never reads a report (only the sandboxed extract step does), so the check that reads the rows of the file (`checkColumnMapping` of @crove/l10n-vn:
// nothing read, a row that stops the file, rows without an order, quantity and amount swapped, dates swapped) runs where the file is read. This command re-checks what the header row alone decides, the
// same refusals by the same names: a buyer column, a field or a column twice, the order number and the quantity (or the line key for a platform whose file has a row per unit) mapped, a return status with
// a status. The extract step that applies a saved profile (#4035) and the screen (#4036) come after this slice.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  zMarketplaceColumnProfile,
  zMarketplaceColumnEntry,
  zMarketplaceColumnProfileQuery,
  zMarketplaceColumnsConfirm,
  type MarketplaceColumnEntry,
  type MarketplaceColumnProfile,
  type MarketplaceColumnsConfirmed,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { MARKETPLACE_PROFILES, isBuyerHeader, type ColumnRefusal, type MarketplacePlatform } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The refusals the header row alone decides, as COLUMN_REFUSALS names them, with the sentence a person reads.
type HeaderRefusal = Extract<ColumnRefusal, 'buyer_column' | 'field_twice' | 'column_twice' | 'no_order_no' | 'no_line' | 'return_without_status'>;
const REFUSAL_TEXT: Record<HeaderRefusal, string> = {
  buyer_column: 'Một cột có tiêu đề của người mua hoặc người nhận không được dùng làm cột dữ liệu',
  field_twice: 'Một trường được gán cho hai cột',
  column_twice: 'Một cột được gán cho hai trường',
  no_order_no: 'Chưa có cột mã đơn hàng',
  no_line: 'Chưa có cột số lượng (hoặc mã dòng, với sàn xuất mỗi dòng một đơn vị)',
  return_without_status: 'Có cột trạng thái trả hàng nhưng chưa có cột trạng thái đơn',
};

// Whether the mapping passes what the header row alone decides; the first refusal, or null. Pure, so the extract step and the screen can ask the same.
export function checkColumnProfileHeader(platform: MarketplacePlatform, columns: readonly MarketplaceColumnEntry[]): HeaderRefusal | null {
  const profile = MARKETPLACE_PROFILES.find((p) => p.platform === platform);
  if (!profile) return null;
  const fields = new Set<string>();
  const places = new Set<number>();
  for (const column of columns) {
    if (isBuyerHeader(column.header)) return 'buyer_column';
    if (fields.has(column.field)) return 'field_twice';
    if (places.has(column.index)) return 'column_twice';
    fields.add(column.field);
    places.add(column.index);
  }
  if (!fields.has('orderNo')) return 'no_order_no';
  if (profile.rowPerUnit ? !fields.has('lineKey') : !fields.has('quantity')) return 'no_line';
  if (fields.has('returnStatus') && !fields.has('status')) return 'return_without_status';
  return null;
}

// What the table holds in `columns`, read through its schema (the database's CHECK keeps it that shape; this keeps the type honest).
const storedColumns = (value: unknown): MarketplaceColumnEntry[] => z.array(zMarketplaceColumnEntry).parse(value);

// The mapped columns in the order of the header row, the form that is stored and compared.
const inColumnOrder = (columns: readonly MarketplaceColumnEntry[]): MarketplaceColumnEntry[] =>
  [...columns].sort((a, b) => a.index - b.index).map((c) => ({ index: c.index, header: c.header, field: c.field }));

export const marketplaceColumnProfileConfirm = defineCommand({
  name: 'finance.marketplace.columns_confirm',
  input: zMarketplaceColumnsConfirm,
  // A mapping saved for the next report of this platform; nothing is imported, posted or sent, and what is imported later is still confirmed by a person line by line.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<MarketplaceColumnsConfirmed> => {
    // A person confirms, never an agent or the system (the database's insert policy admits the system context for the matrix's own-org control; this is the rule).
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xác nhận được cách đọc các cột của báo cáo');
    const refusal = checkColumnProfileHeader(input.platform, input.columns);
    if (refusal) throw new DomainError('MARKETPLACE_COLUMNS_REFUSED', 422, REFUSAL_TEXT[refusal], { reason: refusal });
    const columns = inColumnOrder(input.columns);
    // Two confirmations at once: one lock per org and platform, so the second sees the first's row and the "same mapping again" check below holds.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.marketplace_columns:${ctx.orgId}:${input.platform}`}, 0))`.execute(ctx.trx);
    const latest = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_profile')
      .select(['id', 'header_row', 'columns', 'header_digest'])
      .where('org_id', '=', ctx.orgId)
      .where('platform', '=', input.platform)
      .orderBy('confirmed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    // The same mapping of the same header again is the same confirmation: nothing is added, so the history holds each distinct mapping once.
    if (latest && latest.header_row === input.headerRow && latest.header_digest === input.headerDigest && JSON.stringify(inColumnOrder(storedColumns(latest.columns))) === JSON.stringify(columns)) {
      ctx.audit({ platform: input.platform, added: false });
      return { id: latest.id, added: false };
    }
    const row = await ctx.trx
      .insertInto('crove_finance.marketplace_column_profile')
      .values({ org_id: ctx.orgId, platform: input.platform, header_row: input.headerRow, columns: JSON.stringify(columns), header_digest: input.headerDigest, confirmed_by: ctx.actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Ids, the platform, the row and the standard fields only; the header texts stay in the profile row.
    ctx.audit({ platform: input.platform, added: true, headerRow: input.headerRow, fields: columns.map((c) => c.field) });
    return { id: row.id, added: true };
  },
});

export const marketplaceColumnProfileRead = defineQuery({
  name: 'finance.marketplace.columns_profile',
  input: zMarketplaceColumnProfileQuery,
  access: ALL,
  handler: async (ctx, input): Promise<MarketplaceColumnProfile | null> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_profile')
      .select(['id', 'platform', 'header_row', 'columns', 'header_digest', 'confirmed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('platform', '=', input.platform)
      .orderBy('confirmed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return zMarketplaceColumnProfile.parse({
      id: row.id,
      platform: row.platform,
      headerRow: row.header_row,
      columns: inColumnOrder(storedColumns(row.columns)),
      headerDigest: row.header_digest,
      confirmedAt: new Date(row.confirmed_at).toISOString(),
    });
  },
});

export const marketplaceColumnProfileCommands = [marketplaceColumnProfileConfirm];
export const marketplaceColumnProfileQueries = [marketplaceColumnProfileRead];
