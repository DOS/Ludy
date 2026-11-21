// SPDX-License-Identifier: AGPL-3.0-only
// The confirmed mapping of a marketplace report's columns (#4037, slice 2 of #3850; plan stock-and-marketplaces.md section 8.6 "Columns": "A person confirms; the mapping is stored per org and platform
// and applied by code afterwards").
// - finance.marketplace.columns_confirm (owners and admins, a person only, never an agent; R1): saves the mapping a person confirmed for a platform, as a new row of
//   crove_finance.marketplace_column_profile (append-only; the latest row of an org and platform wins). Since #4037 it is the full-check receipt: it takes the FILE whose check the person looked at and the
//   platform and mapping they saw, and refuses unless that file's check (finance.marketplace.columns_check, run by the worker in the extract sandbox) is done, has parsed lines, has the header digest and
//   is for the same platform and mapping. The profile's header texts, header row and digest come from what the worker recorded for that file, never from the caller. It stores the header text of each
//   mapped column and the standard field it is, the row the header was read from and the digest of the whole header row, and nothing else: no cell value, no sample, no buyer column. In the same
//   transaction the file's check row is deleted (its preview is personal data).
// - finance.marketplace.columns_profile (every member reads): the latest profile of the org and a platform, or null.
//
// What is checked here and what is not. The kernel never reads a report (only the sandboxed extract step does), so the checks that read the rows (nothing read, a row that stops the file, rows without an
// order, quantity and amount swapped, dates swapped) were made by the sandbox on the file and are the receipt. This command re-checks what the header row alone decides, by the same refusal names: a buyer
// column, a field or a column twice, the order number and the quantity (or the line key for a platform whose file has a row per unit) mapped, a return status with a status. Applying a saved profile to the
// next report of the platform is the worker's (marketplace-orders.ts, #4037 second part).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  zMarketplaceColumnProfile,
  zMarketplaceColumnEntry,
  zMarketplaceColumnProfileQuery,
  zMarketplaceColumnSheet,
  zMarketplaceColumnsConfirm,
  type MarketplaceColumnEntry,
  type MarketplaceColumnProfile,
  type MarketplaceColumnsConfirmed,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { MARKETPLACE_PROFILES, isBuyerHeader, type ColumnRefusal, type MarketplacePlatform } from '@crove/l10n-vn';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { sameMapping } from './marketplace-columns.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// The refusals the header row alone decides, as COLUMN_REFUSALS names them, with the sentence a person reads.
type HeaderRefusal = Extract<ColumnRefusal, 'buyer_column' | 'field_twice' | 'column_twice' | 'no_order_no' | 'no_line' | 'return_without_status'>;
const REFUSAL_TEXT: Record<HeaderRefusal | 'bad_column', string> = {
  bad_column: 'Một cột được gán không có trong tiêu đề của tệp, hoặc là cột của người mua',
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
    // The receipt: the file's last check, locked so a new request of it cannot slip in between the look and the save. `preview` is only asked whether it is there (it is personal data, never read here).
    const check = await ctx.trx
      .selectFrom('crove_finance.marketplace_column_check')
      .select(['id', 'state', 'refusal', 'platform', 'assignments', 'sheet', sql<boolean>`preview IS NOT NULL`.as('has_preview')])
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .forUpdate()
      .executeTakeFirst();
    if (!check) throw new DomainError('MARKETPLACE_COLUMNS_NOT_FOUND', 404, 'Không tìm thấy báo cáo chưa nhận ra này');
    // Only a passed check of THAT file counts: done, no refusal, and the lines it parsed (the ones the person saw).
    if (check.state !== 'done' || check.refusal !== null || !check.has_preview || check.platform === null) {
      throw new DomainError('MARKETPLACE_COLUMNS_NOT_CHECKED', 409, 'Mapping này chưa được kiểm tra thành công trên tệp này', { reason: 'not_checked' });
    }
    // What the person saw is what was checked: the same platform and the same assignments, or the screen is out of date.
    if (!sameMapping(check, { platform: input.platform, assignments: input.assignments })) {
      throw new DomainError('MARKETPLACE_COLUMNS_STALE', 409, 'Mapping trên màn hình khác với mapping đã kiểm tra; hãy kiểm tra lại', { reason: 'stale' });
    }
    const sheet = zMarketplaceColumnSheet.safeParse(check.sheet);
    // A check recorded before the header digest existed (or a sheet the contract does not hold) cannot be saved: it is asked again.
    if (!sheet.success || sheet.data.headerDigest === undefined) {
      throw new DomainError('MARKETPLACE_COLUMNS_NOT_CHECKED', 409, 'Mapping này chưa được kiểm tra thành công trên tệp này', { reason: 'no_digest' });
    }
    const { headerRow, headerDigest } = sheet.data;
    // The profile's entries are the worker's: the header text of each assigned column as the file words it (a buyer column has none, and is never assigned).
    const headers = new Map(sheet.data.columns.map((c) => [c.index, c]));
    const entries: MarketplaceColumnEntry[] = [];
    for (const a of input.assignments) {
      const column = headers.get(a.index);
      if (!column || column.buyer || column.header === '') throw new DomainError('MARKETPLACE_COLUMNS_REFUSED', 422, REFUSAL_TEXT.bad_column, { reason: 'bad_column' });
      entries.push({ index: a.index, header: column.header, field: a.field });
    }
    const refusal = checkColumnProfileHeader(input.platform, entries);
    if (refusal) throw new DomainError('MARKETPLACE_COLUMNS_REFUSED', 422, REFUSAL_TEXT[refusal], { reason: refusal });
    const columns = inColumnOrder(entries);
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
    const same = latest && latest.header_row === headerRow && latest.header_digest === headerDigest && JSON.stringify(inColumnOrder(storedColumns(latest.columns))) === JSON.stringify(columns);
    let result: MarketplaceColumnsConfirmed;
    if (same) {
      result = { id: latest.id, added: false };
    } else {
      const row = await ctx.trx
        .insertInto('crove_finance.marketplace_column_profile')
        .values({ org_id: ctx.orgId, platform: input.platform, header_row: headerRow, columns: JSON.stringify(columns), header_digest: headerDigest, confirmed_by: ctx.actor.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      result = { id: row.id, added: true };
    }
    // The decision is made: the file's check row (its sheet and the preview lines, personal data) is no longer needed, whether or not a profile was added.
    await ctx.trx.deleteFrom('crove_finance.marketplace_column_check').where('org_id', '=', ctx.orgId).where('id', '=', check.id).execute();
    // Ids, the platform, the row and the standard fields only; the header texts stay in the profile row, the lines in nothing.
    ctx.audit({ platform: input.platform, added: result.added, fileId: input.fileId, headerRow, fields: columns.map((c) => c.field) });
    return result;
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
