// SPDX-License-Identifier: AGPL-3.0-only
// Bank feed accounts (ADR-0039 points 2 and 3, #2044): the accounts a bank feed connection reaches, each mapped to one
// of the org's bank accounts in one legal entity. The connection and its sealed credential are the kernel's channel
// layer (ADR-0025); this module only says where a connected account's lines go. Owners and admins map and unmap; every
// member who reads the entity lists the mappings. No network here: the provider is the worker's (part 2b) and the API
// route's, never the module's.
// - finance.bank_feed.map: maps an account of an active bank feed connection to a bank account of an entity, or points
//   an existing mapping at another bank account of the same entity.
// - finance.bank_feed.unmap: removes a mapping; the lines it brought in stay, as imported ones do.
// - finance.bank_feed.accounts: the mappings the caller's entities hold, with their connection's name and status.
// - finance.bank_feed.connections: the live connections, mapped or not, for the Settings card.
// - finance.bank_feed.listed: the accounts a connection reaches, as the worker last listed them.
// The worker's sync (#2044 part 2b, apps/kernel/src/bank-feed-sync.ts) runs two system commands:
// - finance.bank_feed.record_accounts: the accounts the provider lists for a connection, replacing the last listing;
// - finance.bank_feed.record_outcome: why a pull stopped (a closed kind, #4244), on the mapped account or on every mapped account of the connection;
// - finance.bank_feed.record_pull: one page of a mapped account's transactions, stored as the entity's bank lines
//   through the import's path (ingestFeedLines), and the cursor and sync time moved in the same transaction.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { BANK_FEED_FIRST_PULL_DAYS, isBankFeedProviderId, vietnamToday, zBankFeedPullOutcome, zBankFeedHookSet, zBankFeedMap, zBankFeedRecordAccounts, zBankFeedRecordOutcome, zBankFeedRecordPull, zId, type BankFeedAccountView, type BankFeedConnectionView, type BankFeedHookCreated, type BankFeedHookStatus, type BankFeedListedAccount, type BankImportResult } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { accountNumberDigits, feedAccountDigits } from './account-number.ts';
import { bankAccount, ingestFeedLines } from './bank.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// One answer for a mapping in another entity, whether the caller can read that mapping or row security hides it (#2079).
const accountMapped = () => new DomainError('BANK_FEED_ACCOUNT_MAPPED', 409, 'Tài khoản này đã gắn với một pháp nhân khác; hãy gỡ liên kết trước');

// The first day a feed with this provider reaches on a first pull: today in Vietnam, minus the provider's first-pull days.
function reachFrom(now: Date, provider: string): string {
  const days = BANK_FEED_FIRST_PULL_DAYS[provider] ?? 0;
  return new Date(Date.parse(`${vietnamToday(now)}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// The earliest cut-over day a mapping may be given (#4218): not before the provider's first pull reaches and, once it has synced (cursor set), not before the day it holds now, or if none the first day the feed will still fetch (lines it stored or left out before that are never fetched again, so a file's lines from there would be lost). Clearing the day stays allowed, and the rule applies to the next day set all the same. Null: the cursor cannot be read, so no day can be vouched for.
export function earliestFeedFrom(now: Date, provider: string, row: { cursor: string | null; feed_from: string | null } | null): string | null {
  const reach = reachFrom(now, provider);
  if (!row || row.cursor === null) return reach;
  const floor = row.feed_from ?? firstDayStillFetched(provider, row.cursor);
  if (floor === null) return null;
  return floor > reach ? floor : reach;
}

// The first day a feed will still fetch after this cursor, read the way the provider writes it. The sandbox's cursor is the last day pulled (2026-11-20): the next pull starts the day after. Tingee's is a Vietnam time stamp yyyyMMddHHmmss (20261120083000) the next pull reads from: lines of its day from that moment on are still fetched, earlier ones are not, so the floor is the next day, except for a stamp at midnight, where the whole day is. Null for anything else, or a time that is not on the calendar.
function firstDayStillFetched(provider: string, cursor: string): string | null {
  if (provider === 'bank_sandbox') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cursor);
    const day = iso ? calendarDay(iso[1] as string, iso[2] as string, iso[3] as string) : null;
    return day === null ? null : addDay(day);
  }
  if (provider === 'bank_tingee') {
    const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(cursor);
    if (!stamp) return null;
    const [, y, mo, d, h, mi, sec] = stamp as unknown as [string, string, string, string, string, string, string];
    const day = calendarDay(y, mo, d);
    if (day === null || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
    return h === '00' && mi === '00' && sec === '00' ? day : addDay(day);
  }
  return null;
}

// A day of the calendar as `YYYY-MM-DD`, or null for one that is not (2026-02-30).
function calendarDay(y: string, m: string, d: string): string | null {
  const text = `${y}-${m}-${d}`;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

const addDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export const bankFeedMap = defineCommand({
  name: 'finance.bank_feed.map',
  input: zBankFeedMap,
  // It decides where a feed's lines are stored and posts nothing, but it queues a pull (finance.bank_feed.sync_requested) that reaches the provider's host through its adapter: so it declares an external
  // effect, R2 (plan §4.7, the job egress invariant #1653).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ feedAccountId: string }> => {
    const connection = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    await bankAccount(ctx, input.bankAccount, true);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // Two maps of one account at once: the second waits, then finds the first's row and remaps it (a FOR UPDATE of a
    // row that does not exist yet would lock nothing).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.bank_feed:${ctx.orgId}:${connection.id}:${input.externalAccountId}`}, 0))`.execute(ctx.trx);
    // Only an account the connection reaches, as the worker listed it with the credential.
    const listed = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_listed_account')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connection.id)
      .where('external_account_id', '=', input.externalAccountId)
      .executeTakeFirst();
    if (!listed) throw new DomainError('BANK_FEED_ACCOUNT_UNKNOWN', 422, 'Kết nối này không có tài khoản đó; hãy chọn một tài khoản trong danh sách');
    // A number recorded on a bank account (#2183) is on that account alone: the feed account's digits, when they are one,
    // may not put it on another. The digits are taken as the statement path takes them (every non-digit dropped), so an id
    // such as SBX-7770001111 counts as the number 7770001111. The lock is the recording's own (bank-account-number.ts), so
    // the two cannot race. Owners and admins, the only callers, always hold the org-wide entity scope (enter_context seals
    // '*' for them), so no recorded number of another entity is hidden from this lookup.
    const feedDigits = accountNumberDigits(feedAccountDigits(input.externalAccountId));
    if (feedDigits !== null) {
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.bank_account_number:${ctx.orgId}:${feedDigits}`}, 0))`.execute(ctx.trx);
      const recorded = await ctx.trx
        .selectFrom('ludy_finance.bank_account_number')
        .select(['bank_account', 'legal_entity_id'])
        .where('org_id', '=', ctx.orgId)
        .where('account_number', '=', feedDigits)
        .execute();
      if (recorded.some((r) => r.bank_account !== input.bankAccount || r.legal_entity_id !== legalEntityId)) {
        throw new DomainError('BANK_ACCOUNT_NUMBER_TAKEN', 409, 'Số tài khoản này đã gắn với một tài khoản ngân hàng khác của tổ chức; hãy gỡ số đó ở tài khoản kia trước');
      }
    }
    const existing = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_account')
      .select(['id', 'legal_entity_id', 'cursor', 'feed_from'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connection.id)
      .where('external_account_id', '=', input.externalAccountId)
      .forUpdate()
      .executeTakeFirst();
    // The cut-over day decides which lines the feed supplies, so it must be a day the feed reaches (#4218): not before its first pull's window, and, once the account has synced, never earlier than it was (the lines the feed left out before it are not fetched again).
    if (input.feedFrom) {
      const earliest = earliestFeedFrom(ctx.now, connection.provider, existing ?? null);
      if (earliest === null) throw new DomainError('BANK_FEED_FROM_UNKNOWN', 422, 'Không đọc được điểm đồng bộ của tài khoản này nên chưa đặt được ngày bắt đầu; hãy bỏ ngày này hoặc thử lại sau lần đồng bộ kế tiếp');
      if (input.feedFrom < earliest) {
        if (existing?.cursor != null) throw new DomainError('BANK_FEED_FROM_MOVED_EARLIER', 422, `Tài khoản này đã đồng bộ nên ngày bắt đầu lấy giao dịch tự động không thể sớm hơn ${earliest}; hãy chọn ngày muộn hơn`, { earliest });
        throw new DomainError('BANK_FEED_FROM_TOO_EARLY', 422, `Ngày nguồn tự động bắt đầu lấy giao dịch không được sớm hơn ${earliest}, vì nguồn chỉ lấy lùi tới ngày đó`, { earliest });
      }
    }
    let feedAccountId: string;
    if (existing) {
      // Its lines are already in that entity's books: another entity takes an unmap first.
      if (existing.legal_entity_id !== legalEntityId) throw accountMapped();
      await ctx.trx
        .updateTable('ludy_finance.bank_feed_account')
        .set({ bank_account: input.bankAccount, ...(input.feedFrom !== undefined ? { feed_from: input.feedFrom } : {}) })
        .where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      feedAccountId = existing.id;
    } else {
      // Under the account's lock the lookup above has seen every mapping the caller may read. A conflict here is a
      // mapping that row security hides from the caller (in another entity's books): the same answer as a visible one in
      // another entity, never a generic conflict, and nothing says which entity holds it (#2079).
      const inserted = await ctx.trx
        .insertInto('ludy_finance.bank_feed_account')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          channel_connection_id: connection.id,
          external_account_id: input.externalAccountId,
          bank_account: input.bankAccount,
          feed_from: input.feedFrom ?? null,
          created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'external_account_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) throw accountMapped();
      feedAccountId = inserted.id;
    }
    ctx.audit({ feedAccountId, connectionId: connection.id, provider: connection.provider, bankAccount: input.bankAccount, legalEntityId, remapped: Boolean(existing), ...(input.feedFrom !== undefined ? { feedFrom: input.feedFrom } : {}) });
    // The worker pulls the newly mapped account (part 2b).
    await ctx.emit('finance.bank_feed.sync_requested', { connection_id: connection.id });
    return { feedAccountId };
  },
});

export const bankFeedUnmap = defineCommand({
  name: 'finance.bank_feed.unmap',
  input: z.strictObject({ feedAccountId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ feedAccountId: string }> => {
    const removed = await ctx.trx
      .deleteFrom('ludy_finance.bank_feed_account')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.feedAccountId)
      .returning(['id', 'bank_account', 'legal_entity_id'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('BANK_FEED_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản của nguồn giao dịch ngân hàng');
    ctx.audit({ feedAccountId: removed.id, bankAccount: removed.bank_account, legalEntityId: removed.legal_entity_id });
    return { feedAccountId: removed.id };
  },
});

// How the last pull ended, as the card reads it (#4244): null before the first, the line number 1-based. The kind is checked against the closed list, so a value the database would refuse reads as no outcome.
function lastPullOf(r: { last_pull_outcome: string | null; last_pull_outcome_at: Date | string | null; last_pull_item: number | null }): BankFeedAccountView['lastPull'] {
  const kind = zBankFeedPullOutcome.safeParse(r.last_pull_outcome);
  if (!kind.success || r.last_pull_outcome_at === null) return null;
  return { outcome: kind.data, at: new Date(r.last_pull_outcome_at).toISOString(), item: kind.data === 'bad_page' && r.last_pull_item !== null ? r.last_pull_item + 1 : null };
}

export const bankFeedAccounts = defineQuery({
  name: 'finance.bank_feed.accounts',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BankFeedAccountView[]> => {
    const rows = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_account as a')
      .innerJoin('ludy_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.channel_connection_id', 'c.provider', 'c.display_name', 'c.status', 'a.external_account_id', 'a.bank_account', 'a.legal_entity_id', 'a.last_synced_at', 'a.feed_from', 'a.cursor', 'a.last_pull_outcome', 'a.last_pull_outcome_at', 'a.last_pull_item'])
      .where('a.org_id', '=', ctx.orgId)
      .orderBy('c.display_name')
      .orderBy('a.external_account_id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      provider: r.provider,
      connectionName: r.display_name,
      connectionStatus: r.status as BankFeedAccountView['connectionStatus'],
      externalAccountId: r.external_account_id,
      bankAccount: r.bank_account,
      legalEntityId: r.legal_entity_id,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
      feedFrom: r.feed_from,
      feedFromEarliest: earliestFeedFrom(new Date(), r.provider, { cursor: r.cursor, feed_from: r.feed_from }),
      lastPull: lastPullOf(r),
    }));
  },
});

// The org's live bank feed connections, whether an account of theirs is mapped or not, newest first: the Settings card
// lists them to map from and to say which one expired (#2099). The managers' alone, as the listing is org-wide.
export const bankFeedConnections = defineQuery({
  name: 'finance.bank_feed.connections',
  input: z.object({}),
  access: MANAGERS,
  handler: async (ctx): Promise<BankFeedConnectionView[]> => {
    const rows = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['id', 'provider', 'display_name', 'status', 'connected_at'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', 'like', 'bank\\_%')
      .where('status', '<>', 'revoked')
      .orderBy('connected_at', 'desc')
      .limit(500)
      .execute();
    return rows
      .filter((r) => isBankFeedProviderId(r.provider))
      .map((r) => ({ id: r.id, provider: r.provider, displayName: r.display_name, status: r.status as BankFeedConnectionView['status'], connectedAt: new Date(r.connected_at).toISOString() }));
  },
});

// The managers' alone: the listing is org-wide (no entity), and only they map an account.
export const bankFeedListed = defineQuery({
  name: 'finance.bank_feed.listed',
  input: z.object({ connectionId: zId }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<Array<BankFeedListedAccount & { listedAt: string }>> => {
    const rows = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_listed_account')
      .select(['external_account_id', 'display_name', 'listed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .orderBy('external_account_id')
      .execute();
    return rows.map((r) => ({ externalAccountId: r.external_account_id, displayName: r.display_name, listedAt: new Date(r.listed_at).toISOString() }));
  },
});

// The mapped accounts of a connection the provider still lists, and where each one's next pull starts, for the
// worker's sync. A mapped account the provider no longer lists keeps its mapping and lines, and is not pulled.
export const bankFeedPullDue = defineQuery({
  name: 'finance.bank_feed.pull_due',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<Array<{ feedAccountId: string; externalAccountId: string; cursor: string | null }>> => {
    const rows = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_account as a')
      .innerJoin('ludy_finance.bank_feed_listed_account as l', (j) =>
        j.onRef('l.org_id', '=', 'a.org_id').onRef('l.channel_connection_id', '=', 'a.channel_connection_id').onRef('l.external_account_id', '=', 'a.external_account_id'),
      )
      .select(['a.id', 'a.external_account_id', 'a.cursor'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.channel_connection_id', '=', input.connectionId)
      .orderBy('a.external_account_id')
      .execute();
    return rows.map((r) => ({ feedAccountId: r.id, externalAccountId: r.external_account_id, cursor: r.cursor }));
  },
});

// A bank feed connection's status and version (its updated_at), for the worker's sync; null for none of this org.
export const bankFeedConnection = defineQuery({
  name: 'finance.bank_feed.connection',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ status: string; updatedAt: string } | null> => {
    const row = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['provider', 'status', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || !isBankFeedProviderId(row.provider)) return null;
    return { status: row.status, updatedAt: new Date(row.updated_at).toISOString() };
  },
});

export const bankFeedRecordAccounts = defineCommand({
  name: 'finance.bank_feed.record_accounts',
  input: zBankFeedRecordAccounts,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ listed: number; removed: number }> => {
    const connection = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    const ids = input.accounts.map((a) => a.externalAccountId);
    if (new Set(ids).size !== ids.length) throw new DomainError('BANK_FEED_INVALID', 422, 'Nguồn giao dịch ngân hàng gửi một tài khoản hai lần');
    for (const account of input.accounts) {
      await ctx.trx
        .insertInto('ludy_finance.bank_feed_listed_account')
        .values({ org_id: ctx.orgId, channel_connection_id: connection.id, external_account_id: account.externalAccountId, display_name: account.displayName })
        .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'external_account_id']).doUpdateSet({ display_name: account.displayName, listed_at: ctx.now }))
        .execute();
    }
    let gone = ctx.trx.deleteFrom('ludy_finance.bank_feed_listed_account').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', connection.id);
    if (ids.length > 0) gone = gone.where('external_account_id', 'not in', ids);
    const removed = (await gone.returning('id').execute()).length;
    ctx.audit({ connectionId: connection.id, provider: connection.provider, listed: ids.length, removed });
    return { listed: ids.length, removed };
  },
});

// Why a pull stopped (#4244): the sync calls it when a call or a page is refused, then raises the error as before, so the job retries as it did. A closed kind and a line position, never a provider's text.
// With an account (a refused page) it records on that account, and only while the account's cursor is still where the page was to start; without one (the account listing or the credential was refused,
// before any pull) it records on every mapped account of the connection, so each card says the same. A connection that is no longer active, or with nothing mapped, records nothing.
export const bankFeedRecordOutcome = defineCommand({
  name: 'finance.bank_feed.record_outcome',
  input: zBankFeedRecordOutcome,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ recorded: number }> => {
    const connection = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') return { recorded: 0 };
    let update = ctx.trx
      .updateTable('ludy_finance.bank_feed_account')
      .set({ last_pull_outcome: input.kind, last_pull_outcome_at: ctx.now, last_pull_item: input.item ?? null })
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId);
    if (input.feedAccountId !== undefined) {
      update = update.where('id', '=', input.feedAccountId);
      if (input.fromCursor !== undefined) update = input.fromCursor === null ? update.where('cursor', 'is', null) : update.where('cursor', '=', input.fromCursor);
    } else {
      // A connection-wide record reaches the accounts the connection still lists: one it no longer lists is never pulled again, so nothing would clear its reason.
      update = update.where(
        'external_account_id',
        'in',
        ctx.trx
          .selectFrom('ludy_finance.bank_feed_listed_account')
          .select('external_account_id')
          .where('org_id', '=', ctx.orgId)
          .where('channel_connection_id', '=', input.connectionId),
      );
    }
    const recorded = (await update.returning('id').execute()).length;
    ctx.audit({ connectionId: input.connectionId, kind: input.kind, accounts: recorded });
    return { recorded };
  },
});

export const bankFeedRecordPull = defineCommand({
  name: 'finance.bank_feed.record_pull',
  input: zBankFeedRecordPull,
  // Records the bank's own figures and posts nothing, as an import does (R1). The provider was called by the job.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<BankImportResult | { importId: null }> => {
    // The account and entity are the mapping's, never the job's input.
    const mapped = await ctx.trx
      .selectFrom('ludy_finance.bank_feed_account as a')
      .innerJoin('ludy_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.bank_account', 'a.legal_entity_id', 'a.cursor', 'a.feed_from', 'c.provider', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.feedAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!mapped) throw new DomainError('BANK_FEED_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản của nguồn giao dịch ngân hàng');
    if (mapped.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    // Under the row lock: another sync recorded a page since this one read the cursor, so this page is stale.
    if (mapped.cursor !== input.fromCursor) throw new DomainError('BANK_FEED_CURSOR_MOVED', 409, 'Một lần đồng bộ khác đã ghi tài khoản này trước; lần này dừng lại');
    // The first pull may run later than the day the cut-over was set (a delay across midnight), so its window starts later than the day the owner saw. The feed supplies from the day its first pull really starts: a day before that stays the statement files', never skipped by both (#4218).
    let movedTo: string | null = null;
    if (mapped.cursor === null && mapped.feed_from !== null) {
      const start = reachFrom(ctx.now, mapped.provider);
      if (mapped.feed_from < start) {
        movedTo = start;
        await ctx.trx.updateTable('ludy_finance.bank_feed_account').set({ feed_from: start }).where('org_id', '=', ctx.orgId).where('id', '=', mapped.id).execute();
      }
    }
    // From this mapping's own cut-over day on, the feed supplies its lines (#4218, #4226): a line it brings from before
    // that day (the first pull goes back a month) stays with statement files or another link on the same account, and is
    // left out so one transaction is never booked under two keys.
    const cutover = movedTo ?? mapped.feed_from;
    const lines = cutover === null ? input.lines : input.lines.filter((l) => l.date >= cutover);
    const skippedBefore = input.lines.length - lines.length;
    const result =
      lines.length > 0 ? await ingestFeedLines(ctx, { bankAccount: mapped.bank_account, legalEntityId: mapped.legal_entity_id, source: mapped.provider, lines }) : null;
    await ctx.trx
      .updateTable('ludy_finance.bank_feed_account')
      // A stored page clears why an earlier one stopped, in the same transaction as its lines (#4244).
      .set({ cursor: input.cursor, last_synced_at: ctx.now, last_pull_outcome: 'ok', last_pull_outcome_at: ctx.now, last_pull_item: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', mapped.id)
      .execute();
    if (!result) ctx.audit({ feedAccountId: mapped.id, lines: 0 });
    // The lines this link's cut-over day kept out are on the trail whether or not the rest was stored (#4218, #4226); the audit fields merge into this command's one row.
    if (skippedBefore > 0) ctx.audit({ feedAccountId: mapped.id, feedFrom: cutover, skippedBeforeFeedFrom: skippedBefore });
    if (movedTo !== null) ctx.audit({ feedFromMovedTo: movedTo, feedFromWas: mapped.feed_from });
    return result ?? { importId: null };
  },
});

// The webhook hook key of a connection (#4203, Tingee S3): 128 random bits as 22 base64url characters, shown once; the database keeps its SHA-256 only, in a definer-only table, through
// ludy_finance.bank_feed_hook_set (owners and admins, checked there too). A second call replaces the key, so the old address stops at once and a hook stopped by refused notices takes notices again.
export const bankFeedHookKey = () => randomBytes(16).toString('base64url');
export const bankFeedHookKeyHash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

export const bankFeedHookSet = defineCommand({
  name: 'finance.bank_feed.hook_set',
  input: zBankFeedHookSet,
  // A row of Ludy that makes an address valid or stops the old one; it posts nothing, reaches no provider and moves no money. The key leaves only in the answer to the owner or admin: callers send no idempotency
  // key, so no replay hands it out again, and the audit row keeps the input and a flag, never the key.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  // The answer holds the key in plaintext, so it must never be stored for a replay (ludy_kernel.idempotency_key.response): callers omit the key and the runtime refuses one.
  noIdempotency: true,
  handler: async (ctx, input): Promise<BankFeedHookCreated> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tạo được địa chỉ nhận thông báo của nguồn giao dịch');
    const connection = await ctx.trx
      .selectFrom('ludy_kernel.channel_connection')
      .select(['provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    const key = bankFeedHookKey();
    const { rows } = await sql<{ made: boolean }>`SELECT ludy_finance.bank_feed_hook_set(${input.connectionId}::uuid, ${bankFeedHookKeyHash(key)}) AS made`.execute(ctx.trx);
    const created = rows[0]?.made === true;
    ctx.audit({ created });
    return { provider: connection.provider, key, created };
  },
});

export const bankFeedHook = defineQuery({
  name: 'finance.bank_feed.hook',
  input: zBankFeedHookSet,
  access: MANAGERS,
  handler: async (ctx, input): Promise<BankFeedHookStatus> => {
    const { rows } = await sql<{ created_at: Date | string; rotated_at: Date | string | null; last_seen_at: Date | string | null; rejected_count: number; stopped: boolean }>`
      SELECT created_at, rotated_at, last_seen_at, rejected_count, stopped FROM ludy_finance.bank_feed_hook_status(${input.connectionId}::uuid)`.execute(ctx.trx);
    const row = rows[0];
    if (!row) return { exists: false, createdAt: null, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };
    const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
    return { exists: true, createdAt: iso(row.created_at), rotatedAt: iso(row.rotated_at), lastSeenAt: iso(row.last_seen_at), rejectedCount: Number(row.rejected_count), stopped: row.stopped };
  },
});

export const bankFeedCommands = [bankFeedMap, bankFeedUnmap, bankFeedRecordAccounts, bankFeedRecordOutcome, bankFeedRecordPull, bankFeedHookSet];
export const bankFeedQueries = [bankFeedAccounts, bankFeedConnections, bankFeedListed, bankFeedPullDue, bankFeedConnection, bankFeedHook];
