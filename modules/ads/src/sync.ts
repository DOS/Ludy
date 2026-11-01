// SPDX-License-Identifier: AGPL-3.0-only
// The worker's side of Ads (ADR-0040 point 4, plan docs/plan/ads.md section 5.2). The credential is opened in the worker
// (apps/kernel/src/ads-sync.ts) and nowhere else; the platform's answer comes here as input to two system commands, in
// one transaction each, so a sync run and its rows commit together and the cursors move only with their rows.
// - ads.sync.target (query): what the job needs to plan a read of one connection's account.
// - ads.sync.record: the rows of one window, the account's own details, the cursors, and the run.
// - ads.sync.record_failure: a run that failed, and when to try again.
// The platform's rows are external data: the command checks every one again (the day inside the window, a decimal spend,
// whole counts, one row per object and day), and refuses the whole window rather than store part of it.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { ADS_BACKFILL_MONTHS, isAdProviderId, zAdsSyncFailure, zAdsSyncRecord, zId, type AdDailyRowInput } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { addMonths, nextSettledThrough, todayIn } from './domain.ts';

function assertSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
}

const invalid = (why: string) => new DomainError('ADS_ROWS_INVALID', 422, `Dữ liệu quảng cáo nhận về không hợp lệ: ${why}`);
// Rows a statement inserts at once.
const CHUNK = 500;
// The longest a rate limit holds the next run back.
const RETRY_MAX_MS = 24 * 3_600_000;

export interface AdsSyncTarget {
  adAccountId: string;
  provider: string;
  connectionStatus: string;
  // The connection's version (its updated_at), so marking it expired leaves alone one connected again meanwhile.
  connectionUpdatedAt: string;
  currency: string | null;
  timeZone: string | null;
  backfillFrom: string;
  settledThrough: string | null;
  // After a rate limit: not before this time.
  nextRunAt: string | null;
}

const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

export const adsSyncTarget = defineQuery({
  name: 'ads.sync.target',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<AdsSyncTarget | null> => {
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.provider', 'a.currency', 'a.time_zone', 'a.backfill_from', 'a.settled_through', 'a.next_run_at', 'c.status', 'c.updated_at'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || !isAdProviderId(row.provider)) return null;
    return {
      adAccountId: row.id,
      provider: row.provider,
      connectionStatus: row.status,
      connectionUpdatedAt: new Date(row.updated_at).toISOString(),
      currency: row.currency,
      timeZone: row.time_zone,
      backfillFrom: day(row.backfill_from) as string,
      settledThrough: day(row.settled_through),
      nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    };
  },
});

// Checks the rows against the window and each other; returns them keyed for the upsert.
function checkRows(rows: readonly AdDailyRowInput[], window: { from: string; to: string }, accountExternalId: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    // The account's own row names the account itself: two such rows on one day would both be summed.
    if (row.level === 'account' && row.externalObjectId !== accountExternalId) throw invalid('một dòng cấp tài khoản không thuộc tài khoản này');
    if (row.day < window.from || row.day > window.to) throw invalid('một ngày nằm ngoài khoảng đã đọc');
    const key = `${row.level}\u0000${row.externalObjectId}\u0000${row.day}`;
    if (seen.has(key)) throw invalid('một đối tượng có hai dòng trong cùng một ngày');
    seen.add(key);
  }
}

export const adsSyncRecord = defineCommand({
  name: 'ads.sync.record',
  input: zAdsSyncRecord,
  // Records what the platform reported and posts nothing; the platform was called by the job (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ rows: number; removed: number; settledThrough: string | null }> => {
    assertSystem(ctx);
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.legal_entity_id', 'a.currency', 'a.backfill_from', 'a.settled_through', 'a.external_account_id', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.adAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!account) throw new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
    if (account.status !== 'active') throw new DomainError('ADS_CONNECTION_INACTIVE', 422, 'Kết nối tài khoản quảng cáo không còn hoạt động; hãy kết nối lại');
    const { details, window, rows } = input;
    if (account.currency !== null && account.currency !== details.currency) {
      throw new DomainError('ADS_CURRENCY_CHANGED', 409, 'Nền tảng báo một tiền tệ khác với tiền tệ đã ghi cho tài khoản này; số liệu không được ghi');
    }
    const today = todayIn(details.timeZone, ctx.now);
    const backfillFrom = day(account.backfill_from) as string;
    if (window.from > window.to || window.to > today) throw invalid('khoảng ngày đã đọc không hợp lệ');
    if (window.from < backfillFrom) throw invalid('khoảng ngày bắt đầu trước lịch sử được giữ');
    if (input.settleBefore !== null && input.settleBefore > today) throw invalid('ngày chốt nằm trong tương lai');
    checkRows(rows, window, account.external_account_id);

    const horizon = addMonths(today, -ADS_BACKFILL_MONTHS);
    const settled = nextSettledThrough({ current: day(account.settled_through), backfillFrom, window, settleBefore: input.settleBefore });
    const started = ctx.now;
    // Upsert: a day inside the platform's revision window is rewritten in place; a final day is never rewritten.
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await ctx.trx
        .insertInto('crove_ads.ad_spend_day')
        .values(
          chunk.map((r) => ({
            org_id: ctx.orgId,
            ad_account_id: account.id,
            legal_entity_id: account.legal_entity_id,
            level: r.level,
            external_object_id: r.externalObjectId,
            object_name: r.objectName,
            day: r.day,
            currency: details.currency,
            spend: new Decimal(r.spend).toFixed(),
            impressions: String(r.impressions),
            clicks: String(r.clicks),
            reach: r.reach === null ? null : String(r.reach),
            results: JSON.stringify(r.results),
            fetched_at: started,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['org_id', 'ad_account_id', 'level', 'external_object_id', 'day']).doUpdateSet((eb) => ({
            object_name: eb.ref('excluded.object_name'),
            currency: eb.ref('excluded.currency'),
            spend: eb.ref('excluded.spend'),
            impressions: eb.ref('excluded.impressions'),
            clicks: eb.ref('excluded.clicks'),
            reach: eb.ref('excluded.reach'),
            results: eb.ref('excluded.results'),
            fetched_at: eb.ref('excluded.fetched_at'),
          })).where('crove_ads.ad_spend_day.settled_at', 'is', null),
        )
        .execute();
    }
    // A day of the window the platform no longer reports (and that is not final) goes; so does history past 13 months.
    const gone = await ctx.trx
      .deleteFrom('crove_ads.ad_spend_day')
      .where('org_id', '=', ctx.orgId)
      .where('ad_account_id', '=', account.id)
      .where('day', '>=', window.from)
      .where('day', '<=', window.to)
      .where('settled_at', 'is', null)
      .where('fetched_at', '<', started)
      .returning('id')
      .execute();
    await ctx.trx.deleteFrom('crove_ads.ad_spend_day').where('org_id', '=', ctx.orgId).where('ad_account_id', '=', account.id).where('day', '<', horizon).execute();
    if (settled !== null) {
      await ctx.trx
        .updateTable('crove_ads.ad_spend_day')
        .set({ settled_at: started })
        .where('org_id', '=', ctx.orgId)
        .where('ad_account_id', '=', account.id)
        .where('day', '<=', settled)
        .where('settled_at', 'is', null)
        .execute();
    }
    await ctx.trx
      .updateTable('crove_ads.ad_account')
      .set({
        currency: details.currency,
        time_zone: details.timeZone,
        settled_through: settled,
        synced_through: window.to,
        last_run_at: started,
        last_error_kind: null,
        next_run_at: null,
        updated_at: started,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.id)
      .execute();
    await ctx.trx
      .insertInto('crove_ads.ad_sync_run')
      .values({ org_id: ctx.orgId, ad_account_id: account.id, legal_entity_id: account.legal_entity_id, status: 'ok', window_from: window.from, window_to: window.to, rows_written: rows.length })
      .execute();
    ctx.audit({ adAccountId: account.id, from: window.from, to: window.to, rows: rows.length, removed: gone.length, settledThrough: settled });
    return { rows: rows.length, removed: gone.length, settledThrough: settled };
  },
});

export const adsSyncRecordFailure = defineCommand({
  name: 'ads.sync.record_failure',
  input: zAdsSyncFailure,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string }> => {
    assertSystem(ctx);
    const account = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.adAccountId)
      .forUpdate()
      .executeTakeFirst();
    if (!account) throw new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
    // A rate limit holds the next run back to the time the platform names, at most a day.
    const retryAt =
      input.errorKind === 'rate_limited' && input.retryAt ? new Date(Math.min(Date.parse(input.retryAt), ctx.now.getTime() + RETRY_MAX_MS)) : null;
    await ctx.trx
      .updateTable('crove_ads.ad_account')
      .set({ last_run_at: ctx.now, last_error_kind: input.errorKind, next_run_at: retryAt, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.id)
      .execute();
    await ctx.trx
      .insertInto('crove_ads.ad_sync_run')
      .values({
        org_id: ctx.orgId,
        ad_account_id: account.id,
        legal_entity_id: account.legal_entity_id,
        status: 'failed',
        window_from: input.window?.from ?? null,
        window_to: input.window?.to ?? null,
        error_kind: input.errorKind,
        error_code: input.errorCode ?? null,
        retry_at: retryAt,
      })
      .execute();
    ctx.audit({ adAccountId: account.id, errorKind: input.errorKind, errorCode: input.errorCode ?? null });
    return { adAccountId: account.id };
  },
});

export const syncCommands = [adsSyncRecord, adsSyncRecordFailure];
export const syncQueries = [adsSyncTarget];
