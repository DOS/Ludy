// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to a marketplace (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7), modeled on the e-invoice connection (#2501):
// - finance.marketplace_connection.connect (owners and admins; R2): runs kernel.channel.connect (provider `marketplace_<adapter>`, the credential sealed in crove_kernel.credential) and
//   files the connection under a legal entity and a platform in ONE transaction. It sees no credential: the sealing is the API edge's, and the worker alone opens it.
// - finance.marketplace_connection.record_test (same; R1): records the state the connection test came back with. The test itself is the API's for the offline provider and the worker's
//   for a real one; this command takes only a state.
// - finance.marketplace_connection.unlink (same; R2): deletes the row. The API revokes the channel connection first, which drops the credential.
// - finance.marketplace_connection.request_poll (same; R2 external): asks the worker to pull the platform's orders now (the outbox event queues the poll job).
// - finance.marketplace_connection.record_poll (system; R1): what the worker records after a poll: how it ended, the cursor the next one resumes from (moved only after the page was
//   ingested) and how many orders the poll handed to the Inbox. The poll NEVER confirms: what it reads is staged like an uploaded file and a member confirms it.
// - finance.marketplace_connection.poll_target (system query): what the worker needs to poll one connection, or why it must not.
// - finance.marketplace_connection.list: every member reads the connections, their last test and their last poll.
// No query, audit fact or error carries a credential, a buyer's data or a platform's own text: only ids, counts and states.
import { sql } from 'kysely';
import { z } from 'zod';
import { zChannelConnect } from '@crove/kernel';
import {
  zId,
  zMarketplaceConnectionRecordPoll,
  zMarketplaceConnectionRecordTest,
  zMarketplacePlatform,
  type MarketplaceConnection,
  type MarketplaceConnectionTested,
} from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { MARKETPLACE_ADAPTER_PLATFORMS, isMarketplaceAdapter, type MarketplaceAdapterId, type MarketplacePlatformKey } from './marketplace-provider.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

const PREFIX = 'marketplace_';

// The adapter a channel provider id names (`marketplace_sandbox` is the adapter `sandbox`), or null when it names none this build knows.
export const marketplaceAdapterOf = (channelProvider: string): MarketplaceAdapterId | null => {
  const name = channelProvider.startsWith(PREFIX) ? channelProvider.slice(PREFIX.length) : '';
  return isMarketplaceAdapter(name) ? name : null;
};

const notFound = () => new DomainError('MARKETPLACE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối sàn thương mại điện tử này');

// The adapter must serve the platform: asked before anything is sealed, and again by the command.
const checkPlatform = (adapter: MarketplaceAdapterId, platform: MarketplacePlatformKey) => {
  if (!MARKETPLACE_ADAPTER_PLATFORMS[adapter].includes(platform)) throw new DomainError('MARKETPLACE_PLATFORM', 422, 'Bộ kết nối này chưa đọc được sàn đã chọn; hãy nhập file báo cáo của sàn');
};

export const marketplaceConnectionTarget = defineQuery({
  name: 'finance.marketplace_connection.target',
  input: z.strictObject({ adapter: z.string().regex(/^[a-z][a-z0-9_]{0,21}$/), platform: zMarketplacePlatform, legalEntityId: zId.nullable() }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ legalEntityId: string }> => {
    if (!isMarketplaceAdapter(input.adapter)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này không được hỗ trợ');
    checkPlatform(input.adapter, input.platform);
    return { legalEntityId: await resolveLegalEntity(ctx, input.legalEntityId) };
  },
});

export const marketplaceConnectionConnect = defineCommand({
  name: 'finance.marketplace_connection.connect',
  // The sealed envelope of what the org typed (made at the API's edge, never the secret), the platform and the entity the orders are imported for. One transaction writes the channel
  // connection with its credential and files the connection under the entity, so a refusal of either rolls back both: a refused connect never replaces the credential or the connector
  // of a connection that is already live.
  input: z.strictObject({
    adapter: z.string().regex(/^[a-z][a-z0-9_]{0,21}$/),
    platform: zMarketplacePlatform,
    legalEntityId: zId.nullable(),
    displayName: z.string().trim().min(1).max(200),
    credential: zChannelConnect.shape.credential,
  }),
  // It names which seller account the org's orders will be read from and stores that account's login (sealed); nothing is read, written or changed at the platform.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    if (!isMarketplaceAdapter(input.adapter)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này không được hỗ trợ');
    checkPlatform(input.adapter, input.platform);
    const channelProvider = `${PREFIX}${input.adapter}`;
    const entityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // The account is the entity's platform under this adapter, so a second connect of it is the same connection.
    const externalAccountId = `${entityId}:${input.platform}`;
    const channel = await ctx.run<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', {
      provider: channelProvider,
      externalAccountId,
      displayName: input.displayName,
      scopes: [],
      expiresAt: null,
      credential: input.credential,
    });
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    try {
      const row = await ctx.trx
        .insertInto('crove_finance.marketplace_connection')
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, channel_connection_id: channel.connectionId, provider: channelProvider, platform: input.platform, created_by: userId })
        // Two connects of one account at once: the channel connection's own lock serialises them, and the second finds the first's row and answers with it.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const id =
        row?.id ??
        (await ctx.trx.selectFrom('crove_finance.marketplace_connection').select('id').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', channel.connectionId).executeTakeFirstOrThrow()).id;
      ctx.audit({ connectionId: channel.connectionId, legalEntityId: entityId, provider: channelProvider, platform: input.platform, reconnected: channel.reconnected });
      return { id, existing: !row };
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('MARKETPLACE_CONNECTION_EXISTS', 409, 'Pháp nhân này đã có một kết nối với sàn này');
      throw error;
    }
  },
});

export const marketplaceConnectionRecordTest = defineCommand({
  name: 'finance.marketplace_connection.record_test',
  input: zMarketplaceConnectionRecordTest,
  // A state on a row; no order, no money, no credential.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<MarketplaceConnectionTested> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.provider', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .forUpdate('c')
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    if (!marketplaceAdapterOf(row.provider)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Kết nối này không phải của một bộ kết nối sàn mà phiên bản này hỗ trợ');
    await ctx.trx
      .updateTable('crove_finance.marketplace_connection')
      .set({ last_test_state: input.state, last_tested_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ state: input.state });
    return { state: input.state };
  },
});

export const marketplaceConnectionUnlink = defineCommand({
  name: 'finance.marketplace_connection.unlink',
  input: z.strictObject({ id: zId }),
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ removed: boolean }> => {
    // Only a connection that is no longer live: the credential goes first (the API revokes the channel connection before this), so no live credential is left without its row.
    const live = await ctx.trx
      .selectFrom('crove_finance.marketplace_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select('c.id')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .where('ch.status', '<>', 'revoked')
      .executeTakeFirst();
    if (live) throw new DomainError('MARKETPLACE_CONNECTION_LIVE', 409, 'Hãy ngắt kết nối với sàn trước khi xóa dòng này');
    const gone = await ctx.trx.deleteFrom('crove_finance.marketplace_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    const removed = Number(gone.numDeletedRows) > 0;
    ctx.audit({ removed });
    return { removed };
  },
});

// The poll the worker runs is queued by this event (apps/kernel/src/worker.ts). Ids only.
export const MARKETPLACE_POLL_REQUESTED = 'finance.marketplace_poll_requested';

export const marketplaceConnectionRequestPoll = defineCommand({
  name: 'finance.marketplace_connection.request_poll',
  input: z.strictObject({ id: zId }),
  // The event it emits starts a job that calls the platform's API with the org's sealed credential: it derives R2 external (plan section 4.7), though what comes back is only staged.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ queued: boolean }> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.provider', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    if (!marketplaceAdapterOf(row.provider)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Kết nối này không phải của một bộ kết nối sàn mà phiên bản này hỗ trợ');
    await ctx.emit(MARKETPLACE_POLL_REQUESTED, { connection_id: input.id });
    ctx.audit({ requested: true });
    return { queued: true };
  },
});

// What the worker needs to poll one connection, or why it must not: a connection that is gone, or whose channel connection is no longer active (revoked, expired, in error), is left alone.
export type MarketplacePollTarget =
  | { action: 'none'; reason: 'not_found' | 'not_active' | 'unknown_adapter' }
  | { action: 'poll'; id: string; channelConnectionId: string; adapter: MarketplaceAdapterId; platform: MarketplacePlatformKey; legalEntityId: string; cursor: string | null };

export const marketplaceConnectionPollTarget = defineQuery({
  name: 'finance.marketplace_connection.poll_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MarketplacePollTarget> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.marketplace_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.channel_connection_id', 'c.provider', 'c.platform', 'c.legal_entity_id', 'c.poll_cursor', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    const adapter = marketplaceAdapterOf(row.provider);
    if (!adapter) return { action: 'none', reason: 'unknown_adapter' };
    return { action: 'poll', id: row.id, channelConnectionId: row.channel_connection_id, adapter, platform: row.platform, legalEntityId: row.legal_entity_id, cursor: row.poll_cursor };
  },
});

export const marketplaceConnectionRecordPoll = defineCommand({
  name: 'finance.marketplace_connection.record_poll',
  input: zMarketplaceConnectionRecordPoll,
  // A cursor and a state on a row. What the poll read was ingested as a file before this runs, and a member still decides it.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    const found = await ctx.trx.selectFrom('crove_finance.marketplace_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).forUpdate().executeTakeFirst();
    if (!found) return { recorded: false };
    await ctx.trx
      .updateTable('crove_finance.marketplace_connection')
      .set({
        last_polled_at: ctx.now,
        last_poll_state: input.state,
        // A cursor given moves it (only after the page was ingested); left out, it stays where it was.
        ...(input.cursor ? { poll_cursor: input.cursor } : {}),
        ...(input.ordersWaiting === undefined ? {} : { orders_waiting: input.ordersWaiting }),
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ state: input.state, ...(input.ordersWaiting === undefined ? {} : { ordersWaiting: input.ordersWaiting }) });
    return { recorded: true };
  },
});

export const marketplaceConnectionList = defineQuery({
  name: 'finance.marketplace_connection.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MarketplaceConnection[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.marketplace_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select([
        'c.id',
        'c.channel_connection_id',
        'c.legal_entity_id',
        'c.provider',
        'c.platform',
        'c.last_test_state',
        'c.last_tested_at',
        'c.last_polled_at',
        'c.last_poll_state',
        'c.orders_waiting',
        'ch.display_name',
        'ch.status',
      ])
      .where('c.org_id', '=', ctx.orgId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      legalEntityId: r.legal_entity_id,
      provider: r.provider,
      platform: r.platform,
      displayName: r.display_name,
      status: r.status,
      lastTestState: r.last_test_state,
      lastTestedAt: iso(r.last_tested_at),
      lastPolledAt: iso(r.last_polled_at),
      lastPollState: r.last_poll_state,
      ordersWaiting: r.orders_waiting,
    }));
  },
});

// A page of the active connections of active orgs after a key (crove_finance.marketplace_poll_due, the worker login's alone), for the worker's sweep, which pages through them all.
export const MARKETPLACE_POLL_DUE_PAGE = 1000;
export async function marketplacePollDue(workerDb: Db, after: { orgId: string; id: string } | null): Promise<Array<{ orgId: string; id: string; provider: string }>> {
  const { rows } = await sql<{ org_id: string; id: string; provider: string }>`
    SELECT org_id, id, provider FROM crove_finance.marketplace_poll_due(${after?.orgId ?? null}::uuid, ${after?.id ?? null}::uuid, ${MARKETPLACE_POLL_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, id: r.id, provider: r.provider }));
}

export const marketplaceConnectionCommands = [
  marketplaceConnectionConnect,
  marketplaceConnectionRecordTest,
  marketplaceConnectionUnlink,
  marketplaceConnectionRequestPoll,
  marketplaceConnectionRecordPoll,
];
export const marketplaceConnectionQueries = [marketplaceConnectionList, marketplaceConnectionTarget, marketplaceConnectionPollTarget];
