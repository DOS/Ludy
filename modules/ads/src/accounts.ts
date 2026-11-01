// SPDX-License-Identifier: AGPL-3.0-only
// Ad accounts (ADR-0040 point 3, plan docs/plan/ads.md section 7.4): the ad accounts an org connected. The connection and
// its sealed credential are the kernel's channel layer (ADR-0025); this module records what Ads decides about each one:
// the legal entity whose books it belongs to, the expense account the books strip compares with, the action type that
// counts as "a result". The platform is the worker's and the API route's, never this module's: no network here.
// - ads.account.link: owners and admins link a connected ad account (a connection of an ad platform), once; a connection
//   made again after a disconnect takes over the account's row, so its history stays.
// - ads.account.configure: owners and admins change those settings.
// - ads.sync.request: owners, admins and members ask for a refresh of one account, at most one a minute.
// - ads.account.delete_history: owners and admins delete an account's figures and sync log (Q4 of #2214); ads.account.erase is
//   the platform's own deletion request (plan section 9), run by the worker.
// - ads.account.list, ads.sync.runs: what the screens read.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { ADS_REQUEST_MIN_SECONDS, isAdProviderId, zAdsAccountConfigure, zAdsAccountDeleteHistory, zAdsAccountLink, zId, type AdAccountView, type AdsSyncRunView } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { historyStart } from './domain.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const notFound = () => new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo này');
const legalEntityNotAllowed = () => new DomainError('LEGAL_ENTITY_NOT_ALLOWED', 403, 'Bạn không có quyền với pháp nhân này');

// The entity a new account belongs to: the one asked for, else the org's default as the caller sees it (the only one when
// the caller sees just one). Reads through the caller's own policies, so an entity outside their scope is "not allowed".
async function resolveEntity(ctx: Pick<QueryContext, 'trx' | 'orgId'>, requested: string | undefined): Promise<string> {
  if (requested) {
    const row = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', requested).executeTakeFirst();
    if (!row) throw legalEntityNotAllowed();
    return row.id;
  }
  const visible = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select(['id', 'is_default'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('is_default', 'desc')
    .orderBy('id')
    .limit(2)
    .execute();
  const [first, second] = visible;
  if (!first) throw legalEntityNotAllowed();
  if (first.is_default || !second) return first.id;
  throw new DomainError('LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân cho tài khoản quảng cáo này');
}

export const adsAccountLink = defineCommand({
  name: 'ads.account.link',
  input: zAdsAccountLink,
  // The first sync it queues reads the platform with the connection's credential, so it is a customer-visible, external
  // effect even where the platform is the offline sandbox (the real ones come with A2).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ adAccountId: string; linked: boolean }> => {
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'external_account_id', 'display_name', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isAdProviderId(connection.provider)) throw new DomainError('ADS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối tài khoản quảng cáo');
    if (connection.status !== 'active') throw new DomainError('ADS_CONNECTION_INACTIVE', 422, 'Kết nối tài khoản quảng cáo không còn hoạt động; hãy kết nối lại');
    // Two links of one account at once: the second waits and finds the first's row (a FOR UPDATE of a row that does not
    // exist yet would lock nothing).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.ads:${ctx.orgId}:${connection.provider}:${connection.external_account_id}`}, 0))`.execute(ctx.trx);
    const existing = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'channel_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', connection.provider)
      .where('external_account_id', '=', connection.external_account_id)
      .forUpdate()
      .executeTakeFirst();
    let adAccountId: string;
    if (existing) {
      // The same platform account connected again (after a disconnect, or an expiry): its row, history and settings stay, on
      // the connection now, so the next sync reads from the day after the last final one and no day is lost (#2219). The
      // person who granted it this time is the one a deletion request would name.
      if (existing.channel_connection_id !== connection.id || input.grantedByHash !== undefined) {
        await ctx.trx
          .updateTable('crove_ads.ad_account')
          .set({ channel_connection_id: connection.id, ...(input.grantedByHash !== undefined ? { granted_by_hash: input.grantedByHash } : {}), updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.id)
          .execute();
      }
      adAccountId = existing.id;
    } else {
      const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
      const today = ctx.now.toISOString().slice(0, 10);
      const inserted = await ctx.trx
        .insertInto('crove_ads.ad_account')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          channel_connection_id: connection.id,
          provider: connection.provider,
          external_account_id: connection.external_account_id,
          name: connection.display_name,
          expense_account_code: input.expenseAccountCode ?? null,
          backfill_from: historyStart(today),
          ...(input.grantedByHash ? { granted_by_hash: input.grantedByHash } : {}),
          created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      adAccountId = inserted.id;
    }
    ctx.audit({ adAccountId, connectionId: connection.id, provider: connection.provider, relinked: Boolean(existing) });
    // The worker's first sync of the account.
    await ctx.emit('ads.account.linked', { connection_id: connection.id, ad_account_id: adAccountId });
    return { adAccountId, linked: !existing };
  },
});

export const adsAccountConfigure = defineCommand({
  name: 'ads.account.configure',
  input: zAdsAccountConfigure,
  // Settings of what the screens show; it posts nothing and moves no figure (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string }> => {
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_account')
      .select(['id', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.adAccountId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    const set: { updated_at: Date; legal_entity_id?: string; expense_account_code?: string | null; result_kind?: string | null } = { updated_at: ctx.now };
    if (input.legalEntityId !== undefined && input.legalEntityId !== row.legal_entity_id) set.legal_entity_id = await resolveEntity(ctx, input.legalEntityId);
    if (input.expenseAccountCode !== undefined) set.expense_account_code = input.expenseAccountCode;
    if (input.resultKind !== undefined) set.result_kind = input.resultKind;
    await ctx.trx.updateTable('crove_ads.ad_account').set(set).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ adAccountId: row.id, entityChanged: set.legal_entity_id !== undefined, expenseAccountCode: input.expenseAccountCode, resultKind: input.resultKind });
    return { adAccountId: row.id };
  },
});

export const adsSyncRequest = defineCommand({
  name: 'ads.sync.request',
  input: z.strictObject({ adAccountId: zId }),
  // The sync it queues reads the platform: an external effect (R2).
  risk: 'R2',
  sideEffect: 'external',
  access: MEMBERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string }> => {
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.channel_connection_id', 'a.last_requested_at', 'a.next_run_at', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.adAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('ADS_CONNECTION_INACTIVE', 422, 'Kết nối tài khoản quảng cáo không còn hoạt động; hãy kết nối lại');
    // A rate limit holds the account back until the time the platform named: a refresh does not go round it.
    if (row.next_run_at && new Date(row.next_run_at).getTime() > ctx.now.getTime()) {
      throw new DomainError('ADS_SYNC_ON_HOLD', 429, 'Nền tảng đang giới hạn tần suất truy vấn tài khoản này; hệ thống sẽ tự thử lại khi hết giới hạn');
    }
    if (row.last_requested_at && ctx.now.getTime() - new Date(row.last_requested_at).getTime() < ADS_REQUEST_MIN_SECONDS * 1000) {
      throw new DomainError('ADS_SYNC_TOO_SOON', 429, 'Vừa mới làm mới tài khoản này, hãy thử lại sau ít phút');
    }
    await ctx.trx.updateTable('crove_ads.ad_account').set({ last_requested_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', row.id).execute();
    ctx.audit({ adAccountId: row.id });
    await ctx.emit('ads.sync.requested', { connection_id: row.channel_connection_id, ad_account_id: row.id });
    return { adAccountId: row.id };
  },
});

// What the definer crove_ads.account_history_delete refuses, in the words of the screens.
function historyError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'ADS_ACCOUNT_NOT_FOUND':
      throw notFound();
    case 'ADS_HISTORY_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới xóa được lịch sử quảng cáo');
    case 'ADS_CONNECTION_STILL_OPEN':
      throw new DomainError('ADS_CONNECTION_STILL_OPEN', 409, 'Kết nối của tài khoản này còn mở; hãy ngắt kết nối trước khi xóa tài khoản');
    default:
      throw error;
  }
}

async function deleteHistory(ctx: CommandContext, adAccountId: string, removeAccount: boolean, today: string): Promise<{ days: number; runs: number; removed: boolean }> {
  const { rows } = await sql<{ days: string; runs: string; removed: boolean }>`
    SELECT days, runs, removed FROM crove_ads.account_history_delete(${adAccountId}::uuid, ${removeAccount}, ${historyStart(today)}::date)`
    .execute(ctx.trx)
    .catch(historyError);
  const row = rows[0];
  if (!row) throw notFound();
  return { days: Number(row.days), runs: Number(row.runs), removed: row.removed };
}

// An owner or admin deletes what Ads stored for one account (owner answer Q4 of #2214: the figures stay after a disconnect,
// with this explicit action to delete them). Every figure and sync run goes; a connected account's cursors go back to the
// start, so it reads its 13 months again at the next sync, and an account whose connection is closed (disconnected) also
// loses its row, so nothing of it is left. The audit row names the account and the counts, never a figure.
export const adsAccountDeleteHistory = defineCommand({
  name: 'ads.account.delete_history',
  input: zAdsAccountDeleteHistory,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; days: number; runs: number; removed: boolean }> => {
    const row = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.adAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!row) throw notFound();
    const done = await deleteHistory(ctx, row.id, row.status === 'revoked', ctx.now.toISOString().slice(0, 10));
    ctx.audit({ adAccountId: row.id, days: done.days, runs: done.runs, removed: done.removed });
    return { adAccountId: row.id, ...done };
  },
});

// The platform's own data deletion request (plan section 9), run by the worker for each account the request names: the
// account's row and everything under it go, whatever its connection's state (the connection is closed by its own command).
export const adsAccountErase = defineCommand({
  name: 'ads.account.erase',
  input: z.strictObject({ adAccountId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'ads.ad_account', id: input.adAccountId }),
  handler: async (ctx, input): Promise<{ adAccountId: string; days: number; runs: number; removed: boolean }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
    const done = await deleteHistory(ctx, input.adAccountId, true, ctx.now.toISOString().slice(0, 10));
    ctx.audit({ adAccountId: input.adAccountId, days: done.days, runs: done.runs, source: 'platform_deletion' });
    return { adAccountId: input.adAccountId, ...done };
  },
});

// Why a connection stopped, in one of the words the screen has text for: the status reason is the closer's own code
// (kernel.channel.mark_expired, disconnect, revoke_by_platform), anything else is "other" (the text is not shown).
const PAUSED_REASONS: readonly NonNullable<AdAccountView['pausedReason']>[] = ['token_expired', 'owner_left', 'disconnected', 'platform_deletion'];
function pausedReason(reason: string | null): NonNullable<AdAccountView['pausedReason']> {
  return PAUSED_REASONS.find((r) => r === reason) ?? 'other';
}

// The accounts of the entities the caller reads, with their connection's name and status. `resultKinds` is the adapter's
// to say (the API route fills it from the deployment's platforms); the module has no adapter.
export const adsAccountList = defineQuery({
  name: 'ads.account.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<Array<Omit<AdAccountView, 'resultKinds'>>> => {
    const rows = await ctx.trx
      .selectFrom('crove_ads.ad_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select([
        'a.id', 'a.channel_connection_id', 'c.status', 'c.status_reason', 'c.updated_at as connection_updated_at', 'c.scopes', 'a.provider', 'a.name', 'a.currency', 'a.time_zone', 'a.legal_entity_id', 'a.expense_account_code', 'a.result_kind',
        'a.backfill_from', 'a.settled_through', 'a.synced_through', 'a.last_run_at', 'a.last_error_kind', 'a.next_run_at', 'a.write_enabled',
      ])
      .where('a.org_id', '=', ctx.orgId)
      .orderBy('a.name')
      .orderBy('a.id')
      .limit(200)
      .execute();
    const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
    const stamp = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      connectionStatus: r.status as AdAccountView['connectionStatus'],
      writeEnabled: r.write_enabled,
      pausedSince: r.status === 'active' ? null : stamp(r.connection_updated_at),
      pausedReason: r.status === 'active' ? null : pausedReason(r.status_reason),
      // What the sealed token can do beyond reading ad reports (a Meta token holds every permission the person granted the
      // app): the screen says so. public_profile is the basic login permission and is not one of them.
      extraScopes: r.scopes.filter((s) => s !== 'ads_read' && s !== 'public_profile'),
      provider: r.provider,
      name: r.name,
      currency: r.currency,
      timeZone: r.time_zone,
      legalEntityId: r.legal_entity_id,
      expenseAccountCode: r.expense_account_code,
      resultKind: r.result_kind,
      backfillFrom: day(r.backfill_from) as string,
      settledThrough: day(r.settled_through),
      syncedThrough: day(r.synced_through),
      lastRunAt: stamp(r.last_run_at),
      lastErrorKind: r.last_error_kind as AdAccountView['lastErrorKind'],
      nextRunAt: stamp(r.next_run_at),
    }));
  },
});

// The latest runs of one account, newest first: how the syncs ended.
export const adsSyncRuns = defineQuery({
  name: 'ads.sync.runs',
  input: z.object({ adAccountId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<AdsSyncRunView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_ads.ad_sync_run')
      .select(['id', 'status', 'window_from', 'window_to', 'rows_written', 'error_kind', 'error_code', 'retry_at', 'started_at'])
      .where('org_id', '=', ctx.orgId)
      .where('ad_account_id', '=', input.adAccountId)
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(30)
      .execute();
    const day = (value: Date | string | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));
    return rows.map((r) => ({
      id: r.id,
      status: r.status as AdsSyncRunView['status'],
      windowFrom: day(r.window_from),
      windowTo: day(r.window_to),
      rowsWritten: r.rows_written,
      errorKind: r.error_kind as AdsSyncRunView['errorKind'],
      errorCode: r.error_code,
      retryAt: r.retry_at ? new Date(r.retry_at).toISOString() : null,
      startedAt: new Date(r.started_at).toISOString(),
    }));
  },
});

export const accountCommands = [adsAccountLink, adsAccountConfigure, adsSyncRequest, adsAccountDeleteHistory, adsAccountErase];
export const accountQueries = [adsAccountList, adsSyncRuns];
