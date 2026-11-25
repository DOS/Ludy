// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to a marketplace (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7), modeled on the e-invoice connection (#2501):
// - finance.marketplace_connection.connect (owners and admins; R2): runs kernel.channel.connect (provider `marketplace_<adapter>`, the credential sealed in ludy_kernel.credential) and
//   files the connection under a legal entity and a platform in ONE transaction. It sees no credential: the sealing is the API edge's, and the worker alone opens it.
// - finance.marketplace_connection.record_test (same; R1): records the state the connection test came back with. The test itself is the API's for the offline provider and the worker's
//   for a real one; this command takes only a state.
// - finance.marketplace_connection.unlink (same; R2): deletes the row. The API revokes the channel connection first, which drops the credential.
// - finance.marketplace_connection.request_test (same; R2 external): asks the worker to test a connection whose adapter reaches a host (#4238); the worker records the state with record_test.
// - finance.marketplace_connection.request_poll (same; R2 external): asks the worker to pull the platform's orders now (the outbox event queues the poll job).
// - finance.marketplace_connection.record_poll (system; R1): what the worker records after a poll: how it ended, the cursor the next one resumes from (moved only after the page was
//   ingested) (the orders still waiting are counted by the list from the staged files the connection's polls ingested). The poll NEVER confirms: what it reads is staged like an uploaded file and a member confirms it.
// - finance.marketplace_connection.ingest_page (system; R2 external, as the ingest it runs): files a page of orders (kernel.file.ingest, source `upload`, the connection's entity) and links the file to
//   the connection in the SAME transaction (ludy_finance.marketplace_connection_file, #4250), so the orders still waiting are counted from the link and a member's upload named after a connection id
//   inflates nothing. A page read twice is one file and one link.
// - finance.marketplace_connection.poll_target (system query): what the worker needs to poll one connection, or why it must not.
// - finance.marketplace_connection.list: every member reads the connections, their last test and their last poll.
// No query, audit fact or error carries a credential, a buyer's data or a platform's own text: only ids, counts and states.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zChannelConnect } from '@ludy/kernel';
import {
  zId,
  zMarketplaceAuthorizeBegin,
  zMarketplaceAuthorizeComplete,
  zMarketplaceAuthorizeFinish,
  zMarketplaceAuthorizeLookup,
  zMarketplaceAuthorizeRecord,
  zMarketplaceConnectionRecordPoll,
  zMarketplaceIngestPage,
  zMarketplaceConnectionRecordTest,
  zMarketplacePlatform,
  zMarketplacePushHookSet,
  MARKETPLACE_PUSH_ADAPTERS,
  type MarketplaceAuthorizeBegun,
  type MarketplaceConnection,
  type MarketplaceConnectionTested,
  type MarketplacePageIngested,
  type MarketplacePushHookStatus,
} from '@ludy/kernel-contract';
import type { Db, MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, sha256Hex } from '@ludy/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { MARKETPLACE_ADAPTER_PLATFORMS, MARKETPLACE_AUTHORIZED_ADAPTERS, isMarketplaceAdapter, type MarketplaceAdapterId, type MarketplacePlatformKey } from './marketplace-provider.ts';

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
    // The App Key of an adapter that has one (a public identifier, never the secret): kept in the clear so the authorize address can be built without opening the sealed secret.
    appKey: z.string().regex(/^[!-~]{1,100}$/).nullable().optional(),
  }),
  // It names which seller account the org's orders will be read from and stores that account's login (sealed); nothing is read, written or changed at the platform.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    if (!isMarketplaceAdapter(input.adapter)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này không được hỗ trợ');
    checkPlatform(input.adapter, input.platform);
    // The App Key goes with the sealed secret in this one command, so the two never disagree: an adapter that is authorized on the platform's page needs it, any other has none.
    if (MARKETPLACE_AUTHORIZED_ADAPTERS.includes(input.adapter) !== Boolean(input.appKey)) throw new DomainError('MARKETPLACE_FIELDS', 422, 'Hãy nhập đủ các thông tin mà sàn yêu cầu, không thêm thông tin khác');
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
        .insertInto('ludy_finance.marketplace_connection')
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, channel_connection_id: channel.connectionId, provider: channelProvider, platform: input.platform, created_by: userId, app_key: input.appKey ?? null })
        // Two connects of one account at once: the channel connection's own lock serialises them, and the second finds the first's row and answers with it.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const id =
        row?.id ??
        (await ctx.trx.selectFrom('ludy_finance.marketplace_connection').select('id').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', channel.connectionId).executeTakeFirstOrThrow()).id;
      // A new credential for an account that was already connected ends what the old one earned: the back-off after its refused polls and its last test no longer describe this credential, so the next
      // poll runs at once. (A poll that began with the old credential and ends after this can still record its own failure; the next good poll clears it.)
      if (!row) {
        await ctx.trx
          .updateTable('ludy_finance.marketplace_connection')
          .set({
            last_poll_state: null,
            last_polled_at: null,
            last_test_state: null,
            last_tested_at: null,
            // A new secret may belong to another app: its key replaces the old one, and any authorization of the old one (pending or done) is gone with it.
            app_key: input.appKey ?? null,
            authorize_state: null,
            authorize_state_hash: null,
            authorize_expires_at: null,
            authorize_by: null,
            authorize_code_key_id: null,
            authorize_code_envelope: null,
            authorize_pending_at: null,
            reauthorize_by: null,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .execute();
      }
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
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.provider', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .forUpdate('c')
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    if (!marketplaceAdapterOf(row.provider)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Kết nối này không phải của một bộ kết nối sàn mà phiên bản này hỗ trợ');
    await ctx.trx
      .updateTable('ludy_finance.marketplace_connection')
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
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select('c.id')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .where('ch.status', '<>', 'revoked')
      .executeTakeFirst();
    if (live) throw new DomainError('MARKETPLACE_CONNECTION_LIVE', 409, 'Hãy ngắt kết nối với sàn trước khi xóa dòng này');
    const gone = await ctx.trx.deleteFrom('ludy_finance.marketplace_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
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
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
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

// The test the worker runs is queued by this event (apps/kernel/src/worker.ts): the same queue as the poll, a `kind` in the job. Ids only.
export const MARKETPLACE_TEST_REQUESTED = 'finance.marketplace_test_requested';
export const MARKETPLACE_TEST_MIN_GAP_MS = 60_000;

export const marketplaceConnectionRequestTest = defineCommand({
  name: 'finance.marketplace_connection.request_test',
  input: z.strictObject({ id: zId }),
  // The event it emits starts a job that calls the platform's API with the org's sealed credential (one read that changes nothing there): R2 external, like a poll.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ queued: boolean }> => {
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.provider', 'c.last_tested_at', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    if (!marketplaceAdapterOf(row.provider)) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Kết nối này không phải của một bộ kết nối sàn mà phiên bản này hỗ trợ');
    // The queue is a standard one (a singleton key alone dedupes nothing), so the limit is here: a connection tested less than a minute ago is not tested again, whoever asks. Each test is a call to the platform.
    if (row.last_tested_at && ctx.now.getTime() - new Date(row.last_tested_at).getTime() < MARKETPLACE_TEST_MIN_GAP_MS) throw new DomainError('MARKETPLACE_TEST_RECENT', 429, 'Vừa kiểm tra kết nối này xong, hãy đợi một phút rồi kiểm tra lại');
    await ctx.emit(MARKETPLACE_TEST_REQUESTED, { connection_id: input.id });
    ctx.audit({ requested: true });
    return { queued: true };
  },
});

// What the worker needs to poll one connection, or why it must not: a connection that is gone, or whose channel connection is no longer active (revoked, expired, in error), is left alone.
export type MarketplacePollTarget =
  | { action: 'none'; reason: 'not_found' | 'not_active' | 'unknown_adapter' }
  | { action: 'poll'; id: string; channelConnectionId: string; adapter: MarketplaceAdapterId; platform: MarketplacePlatformKey; legalEntityId: string; cursor: string | null; lastPollState: string | null; lastPolledAt: string | null };

export const marketplaceConnectionPollTarget = defineQuery({
  name: 'finance.marketplace_connection.poll_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MarketplacePollTarget> => {
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.channel_connection_id', 'c.provider', 'c.platform', 'c.legal_entity_id', 'c.poll_cursor', 'c.last_poll_state', 'c.last_polled_at', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    const adapter = marketplaceAdapterOf(row.provider);
    if (!adapter) return { action: 'none', reason: 'unknown_adapter' };
    return { action: 'poll', id: row.id, channelConnectionId: row.channel_connection_id, adapter, platform: row.platform, legalEntityId: row.legal_entity_id, cursor: row.poll_cursor, lastPollState: row.last_poll_state, lastPolledAt: row.last_polled_at ? new Date(row.last_polled_at).toISOString() : null };
  },
});

export const marketplaceConnectionIngestPage = defineCommand({
  name: 'finance.marketplace_connection.ingest_page',
  input: zMarketplaceIngestPage,
  // The same risk as the ingest it runs: its event queues the extraction job, which stages the page for a member (the poll itself confirms nothing).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.marketplaceConnectionId }),
  handler: async (ctx, input): Promise<MarketplacePageIngested> => {
    // The entity is the connection's own, never the caller's; a connection that is gone files nothing.
    const connection = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection')
      .select(['id', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.marketplaceConnectionId)
      .executeTakeFirst();
    if (!connection) throw notFound();
    // The same intake as a file a member drops in the Inbox (source `upload`: the file-source CHECK has no source of its own for a platform's pull).
    const filed = await ctx.run<MarketplacePageIngested>('kernel.file.ingest', {
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      storageKey: input.storageKey,
      generation: input.generation,
      source: 'upload',
      legalEntityId: connection.legal_entity_id,
    });
    // In the same transaction as the ingest, and only for a file this page stored: a page whose bytes are a file the org already holds (a member's own upload, or a page an earlier connection brought) is not linked,
    // so the purge of a gone connection's files (#4284) can never reach a file the poll did not store. A page read twice is the same file: its first link stays (a file belongs to one connection).
    if (!filed.duplicate) {
      await ctx.trx
        .insertInto('ludy_finance.marketplace_connection_file')
        .values({ org_id: ctx.orgId, marketplace_connection_id: connection.id, file_id: filed.fileId })
        .onConflict((conflict) => conflict.columns(['org_id', 'file_id']).doNothing())
        .execute();
    } else {
      // The file existed. When it carries an orphan link (an earlier connection of this org brought the same bytes and was removed) this connection takes it over, so the file is the live connection's and the
      // purge leaves it; a link that has a connection is not moved, and a file with no link (a member's upload) stays unlinked.
      await sql`SELECT ludy_finance.marketplace_link_adopt(${ctx.orgId}::uuid, ${connection.id}::uuid, ${filed.fileId}::uuid)`.execute(ctx.trx);
    }
    ctx.audit({ duplicate: filed.duplicate });
    return filed;
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
    const found = await ctx.trx.selectFrom('ludy_finance.marketplace_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).forUpdate().executeTakeFirst();
    if (!found) return { recorded: false };
    await ctx.trx
      .updateTable('ludy_finance.marketplace_connection')
      .set({
        last_polled_at: ctx.now,
        last_poll_state: input.state,
        // A cursor given moves it (only after the page was ingested); left out, it stays where it was.
        ...(input.cursor ? { poll_cursor: input.cursor } : {}),
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ state: input.state });
    return { recorded: true };
  },
});

// The seller's authorization of a connection (#4238, Lazada S2b). The API makes a random state and stores only its hash with the member who started it (authorize_begin); the seller authorizes on the
// platform's page, which comes back to the app with a one-time code and the state; the API checks the state (authorize_lookup, read only), seals the code (it never opens anything) and authorize_finish
// consumes the state and stores the sealed code; the worker opens it, exchanges it with the seller's own secret and records the outcome (authorize_target and authorize_record). No command, audit fact or
// error carries the state, the code or a token.
export const MARKETPLACE_AUTHORIZE_REQUESTED = 'finance.marketplace_authorize_requested';
export const MARKETPLACE_AUTHORIZE_TTL_MS = 10 * 60_000;
// How long a stored code may wait for the worker: past it the authorization counts as failed (the worker may have died) and the seller authorizes again.
export const MARKETPLACE_AUTHORIZE_PENDING_MS = 15 * 60_000;
const pendingExpired = (pendingAt: Date | string | null, now: number): boolean => pendingAt === null || now - new Date(pendingAt).getTime() > MARKETPLACE_AUTHORIZE_PENDING_MS;
// The binding a sealed one-time code is sealed under: its own, never the credential's, so an envelope of the credential cannot pass for a code and the reverse.
export const marketplaceAuthorizeCodeAccount = (connectionId: string): string => `${connectionId}:authorize_code`;
const digestOf = (envelope: string): string => sha256Hex(new TextEncoder().encode(envelope));

const authorizeInvalid = () => new DomainError('MARKETPLACE_AUTHORIZE_INVALID', 400, 'Đường dẫn cấp quyền không hợp lệ, đã hết hạn hoặc đã dùng rồi; hãy bấm Cấp quyền lại');
const requireUser = (ctx: { actor: { type: string; userId?: string } }): string => {
  if (ctx.actor.type !== 'user' || !ctx.actor.userId) throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên đăng nhập mới cấp quyền được cho kết nối sàn');
  return ctx.actor.userId;
};

export const marketplaceConnectionAuthorizeBegin = defineCommand({
  name: 'finance.marketplace_connection.authorize_begin',
  input: zMarketplaceAuthorizeBegin,
  // It stores a hash and a time and sends nothing; what follows (the seller's click on the platform's page, the callback, the worker's exchange) are separate steps with their own commands.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<MarketplaceAuthorizeBegun> => {
    const userId = requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.provider', 'c.app_key', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .forUpdate('c')
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    const adapter = marketplaceAdapterOf(row.provider);
    if (!adapter || !MARKETPLACE_AUTHORIZED_ADAPTERS.includes(adapter)) throw new DomainError('MARKETPLACE_AUTHORIZE_UNSUPPORTED', 422, 'Kết nối này không cần cấp quyền trên sàn');
    if (!row.app_key) throw new DomainError('MARKETPLACE_APP_KEY_MISSING', 409, 'Kết nối này chưa lưu App Key; hãy ngắt kết nối rồi kết nối lại');
    const expiresAt = new Date(ctx.now.getTime() + MARKETPLACE_AUTHORIZE_TTL_MS);
    // One pending authorization for a connection: a new start replaces the old one.
    try {
      await ctx.trx
        .updateTable('ludy_finance.marketplace_connection')
        .set({ authorize_state_hash: input.stateHash, authorize_expires_at: expiresAt, authorize_by: userId })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .execute();
    } catch (error) {
      // A hash another connection of the org already holds (the API makes them at random, so only a direct caller can send one).
      if (pgCode(error) === '23505') throw authorizeInvalid();
      throw error;
    }
    ctx.audit({ started: true });
    return { appKey: row.app_key, expiresAt: expiresAt.toISOString() };
  },
});

// Which connection a state belongs to, for the API to seal the code under the right binding. Read only: it does not consume the state, and it answers only the member who started it.
export const marketplaceConnectionAuthorizeLookup = defineQuery({
  name: 'finance.marketplace_connection.authorize_lookup',
  input: zMarketplaceAuthorizeLookup,
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; provider: string; externalAccountId: string }> => {
    const userId = requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection')
      .select(['id', 'provider', 'authorize_expires_at', 'authorize_by'])
      .where('org_id', '=', ctx.orgId)
      .where('authorize_state_hash', '=', input.stateHash)
      .executeTakeFirst();
    if (!row || row.authorize_by !== userId || !row.authorize_expires_at || new Date(row.authorize_expires_at).getTime() <= Date.now()) throw authorizeInvalid();
    return { id: row.id, provider: row.provider, externalAccountId: marketplaceAuthorizeCodeAccount(row.id) };
  },
});

export const marketplaceConnectionAuthorizeFinish = defineCommand({
  name: 'finance.marketplace_connection.authorize_finish',
  input: zMarketplaceAuthorizeFinish,
  // The event it emits starts a job that calls the platform's token API with the org's sealed secret and the code: R2 external, like a poll. The seller authorized on the platform's own page.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const userId = requireUser(ctx);
    // One locked statement checks the state (the hash is its own unique key), who started it and its time, and the same transaction consumes it: a state works once, only for the member who made it, only
    // in the org it was made in, and only before it ends. A refusal changes nothing (the transaction ends), so the rightful member can still finish.
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.authorize_expires_at', 'c.authorize_by', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.authorize_state_hash', '=', input.stateHash)
      .forUpdate('c')
      .executeTakeFirst();
    if (!row || row.authorize_by !== userId || !row.authorize_expires_at || new Date(row.authorize_expires_at).getTime() <= ctx.now.getTime()) throw authorizeInvalid();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    await ctx.trx
      .updateTable('ludy_finance.marketplace_connection')
      .set({
        authorize_state_hash: null,
        authorize_expires_at: null,
        authorize_by: null,
        authorize_code_key_id: input.codeKeyId,
        authorize_code_envelope: input.codeEnvelope,
        authorize_state: 'pending',
        authorize_pending_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    await ctx.emit(MARKETPLACE_AUTHORIZE_REQUESTED, { connection_id: row.id });
    ctx.audit({ connectionId: row.id, requested: true });
    return { id: row.id };
  },
});

// What the worker needs to finish an authorization: the sealed code and the binding of the sealed secret, or why it must not.
export type MarketplaceAuthorizeTarget =
  | { action: 'none'; reason: 'not_found' | 'not_active' | 'not_pending' | 'unknown_adapter' }
  // The code waited past the window: it is not traded, but the worker records it as failed (with the digest) so the sealed code is cleared.
  | { action: 'expired'; id: string; codeDigest: string }
  | { action: 'authorize'; id: string; channelConnectionId: string; adapter: MarketplaceAdapterId; codeKeyId: string; codeEnvelope: string; codeDigest: string; codeAccount: string; channelVersion: string };

export const marketplaceConnectionAuthorizeTarget = defineQuery({
  name: 'finance.marketplace_connection.authorize_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MarketplaceAuthorizeTarget> => {
    const row = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.channel_connection_id', 'c.provider', 'c.authorize_state', 'c.authorize_code_key_id', 'c.authorize_code_envelope', 'c.authorize_pending_at', 'ch.status', 'ch.updated_at'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    const adapter = marketplaceAdapterOf(row.provider);
    if (!adapter || !MARKETPLACE_AUTHORIZED_ADAPTERS.includes(adapter)) return { action: 'none', reason: 'unknown_adapter' };
    if (row.authorize_state !== 'pending' || !row.authorize_code_key_id || !row.authorize_code_envelope) return { action: 'none', reason: 'not_pending' };
    // A code that waited past the window is not traded (the worker may have died, and the code is old): the list shows it as failed and the seller authorizes again.
    if (pendingExpired(row.authorize_pending_at, Date.now())) return { action: 'expired', id: row.id, codeDigest: digestOf(row.authorize_code_envelope) };
    return {
      action: 'authorize',
      id: row.id,
      channelConnectionId: row.channel_connection_id,
      adapter,
      codeKeyId: row.authorize_code_key_id,
      codeEnvelope: row.authorize_code_envelope,
      codeDigest: digestOf(row.authorize_code_envelope),
      codeAccount: marketplaceAuthorizeCodeAccount(row.id),
      // The channel connection's version at this read: what kernel.channel.refresh compares, so a credential replaced meanwhile is never overwritten.
      channelVersion: new Date(row.updated_at).toISOString(),
    };
  },
});

export const marketplaceConnectionAuthorizeRecord = defineCommand({
  name: 'finance.marketplace_connection.authorize_record',
  input: zMarketplaceAuthorizeRecord,
  // A refusal or a failure and the code gone (a good exchange is authorize_complete's, which also seals the new credential in the same transaction).
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    const found = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection')
      .select(['id', 'authorize_state', 'authorize_code_envelope'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    // Only a pending authorization is recorded: a second record of the same code, or one for a connection that was reconnected meanwhile, changes nothing.
    // and only for the code the worker read: if the seller authorized again meanwhile, the newer code is not cleared by an older outcome.
    if (!found || found.authorize_state !== 'pending' || !found.authorize_code_envelope || digestOf(found.authorize_code_envelope) !== input.codeDigest) return { recorded: false };
    await ctx.trx
      .updateTable('ludy_finance.marketplace_connection')
      .set({
        authorize_state: input.outcome,
        authorize_code_key_id: null,
        authorize_code_envelope: null,
        authorize_pending_at: null,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ outcome: input.outcome });
    return { recorded: true };
  },
});

export const marketplaceConnectionAuthorizeComplete = defineCommand({
  name: 'finance.marketplace_connection.authorize_complete',
  input: zMarketplaceAuthorizeComplete,
  // It replaces the connection's sealed credential with the one the exchange produced (the tokens are inside the envelope, sealed by the worker) and marks the authorization done: no money, no order.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    const found = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection')
      .select(['channel_connection_id', 'authorize_state', 'authorize_code_envelope', 'authorize_pending_at', 'seller_ref'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    // Only the pending authorization of the code the worker read.
    if (!found || found.authorize_state !== 'pending' || !found.authorize_code_envelope || digestOf(found.authorize_code_envelope) !== input.codeDigest) return { recorded: false };
    // The code this command is for is spent (the platform has traded it): whatever stops the new credential being stored, the sealed code must not stay behind, so the authorization is marked failed and the code
    // cleared in this same transaction, and the seller authorizes again.
    const fail = async (outcome: 'failed' | 'shop_changed' = 'failed'): Promise<{ recorded: boolean }> => {
      await ctx.trx
        .updateTable('ludy_finance.marketplace_connection')
        .set({ authorize_state: outcome, authorize_code_key_id: null, authorize_code_envelope: null, authorize_pending_at: null })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .execute();
      ctx.audit({ outcome });
      return { recorded: false };
    };
    if (pendingExpired(found.authorize_pending_at, ctx.now.getTime())) return fail();
    // The seller who authorized must be the seller this connection was authorized for (#4285, #4273): the stored one, or for a connection authorized before it was kept, the one the worker read from its previous
    // secret. A different seller would move this connection's books, link rows and poll cursor onto another shop's orders, so nothing is replaced: the code is cleared, the state says so, and a different seller
    // needs a new connection. Decided here, by a plain comparison of two short words. It fails closed: when a seller is known and the answer names none (null or a field left out), the seller cannot be
    // told, so nothing is replaced either and the state is `failed` (the seller authorizes again). With no seller known yet there is nothing to compare, and the first one named is kept.
    const sellerRef = input.sellerRef ?? null;
    const baseline = found.seller_ref ?? input.priorSellerRef ?? null;
    if (baseline !== null) {
      if (sellerRef === null) return fail('failed');
      if (sellerRef !== baseline) return fail('shop_changed');
    }
    // The credential is replaced only if the connection is as the worker read it (a reconnect or a refresh since then moved its version); in the same transaction as the mark below, so the two never part.
    const replaced = await ctx.run<{ refreshed: boolean }>('kernel.channel.refresh', {
      connectionId: found.channel_connection_id,
      ifVersion: input.ifVersion,
      expiresAt: input.expiresAt,
      credential: input.credential,
    });
    if (!replaced.refreshed) return fail();
    await ctx.trx
      .updateTable('ludy_finance.marketplace_connection')
      .set({
        authorize_state: 'authorized',
        authorize_code_key_id: null,
        authorize_code_envelope: null,
        authorize_pending_at: null,
        reauthorize_by: input.reauthorizeBy,
        // The seller is kept for good (a reconnect does not clear it): the first authorization that names one sets it, a later one is compared with it above.
        seller_ref: sellerRef ?? found.seller_ref ?? input.priorSellerRef ?? null,
        // A new authorization ends what the old credential earned: the back-off after its refused polls and its last test no longer describe it.
        last_poll_state: null,
        last_polled_at: null,
        last_test_state: null,
        last_tested_at: null,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ outcome: 'authorized' });
    return { recorded: true };
  },
});

export const marketplaceConnectionList = defineQuery({
  name: 'finance.marketplace_connection.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MarketplaceConnection[]> => {
    const rows = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
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
        'c.authorize_state',
        'c.authorize_pending_at',
        'c.reauthorize_by',
        'ch.display_name',
        'ch.status',
      ])
      .where('c.org_id', '=', ctx.orgId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    // What waits in the Inbox for each connection: the orders of the staged reads (no member has confirmed or rejected them) of the files its polls ingested, found through the link written in the
    // same transaction as the ingest (ludy_finance.marketplace_connection_file, #4250), never through a file's name. It is counted here, so a confirm or a reject lowers it and a second page adds to the first.
    const waiting = new Map<string, number>();
    if (rows.length > 0) {
      const { rows: counted } = await sql<{ id: string; n: string }>`
        SELECT c.id::text AS id, COALESCE(SUM((x.result -> 'summary' ->> 'orders')::int), 0)::text AS n
        FROM ludy_finance.marketplace_connection c
        JOIN ludy_finance.marketplace_connection_file l ON l.org_id = c.org_id AND l.marketplace_connection_id = c.id
        JOIN ludy_kernel.file f ON f.org_id = l.org_id AND f.id = l.file_id
        JOIN ludy_kernel.extraction x ON x.org_id = f.org_id AND x.file_id = f.id
        WHERE c.org_id = ${ctx.orgId}::uuid AND x.method = 'unsupported' AND x.status = 'done' AND x.result ->> 'kind' = 'marketplace_orders' AND x.result -> 'summary' ->> 'state' = 'staged'
          AND x.version = (SELECT max(v.version) FROM ludy_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
        GROUP BY c.id`.execute(ctx.trx);
      for (const r of counted) waiting.set(r.id, Number(r.n));
    }
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
      ordersWaiting: waiting.get(r.id) ?? 0,
      // A code that waited for the worker past the window is shown as failed: nothing else would ever clear it.
      authorizeState: r.authorize_state === 'pending' && pendingExpired(r.authorize_pending_at, Date.now()) ? ('failed' as const) : r.authorize_state,
      reauthorizeBy: iso(r.reauthorize_by),
    }));
  },
});

// The reports of one connection that wait in the Inbox (staged: no member has confirmed or rejected them), by file id, for "disconnect and discard what is waiting" (#4240 S3b). The same condition as
// `ordersWaiting` in the list: the files its polls ingested, found through the link written in the same transaction as the ingest (ludy_finance.marketplace_connection_file, #4250), never through a file's
// name, so a file a member uploaded under a crafted name is not taken. Read only; the rpc runs each through `finance.marketplace.reject`, the
// member's own decision, so nothing is deleted here and the originals follow the retention that already exists for a decided report. More than the cap is refused whole, so a disconnect never discards part.
const MARKETPLACE_DISCARD_MAX = 500;
export const marketplaceConnectionStaged = defineQuery({
  name: 'finance.marketplace_connection.staged',
  input: z.strictObject({ id: zId }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ fileIds: string[] }> => {
    const { rows } = await sql<{ file_id: string }>`
      SELECT f.id::text AS file_id
      FROM ludy_finance.marketplace_connection c
      JOIN ludy_finance.marketplace_connection_file l ON l.org_id = c.org_id AND l.marketplace_connection_id = c.id
      JOIN ludy_kernel.file f ON f.org_id = l.org_id AND f.id = l.file_id
      JOIN ludy_kernel.extraction x ON x.org_id = f.org_id AND x.file_id = f.id
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ${input.id}::uuid AND x.method = 'unsupported' AND x.status = 'done' AND x.result ->> 'kind' = 'marketplace_orders' AND x.result -> 'summary' ->> 'state' = 'staged'
        AND x.version = (SELECT max(v.version) FROM ludy_kernel.extraction v WHERE v.org_id = x.org_id AND v.file_id = x.file_id)
      ORDER BY f.created_at, f.id
      LIMIT ${MARKETPLACE_DISCARD_MAX + 1}`.execute(ctx.trx);
    if (rows.length > MARKETPLACE_DISCARD_MAX) throw new DomainError('MARKETPLACE_TOO_MANY_STAGED', 409, 'Có quá nhiều báo cáo đang chờ để bỏ một lần; hãy xác nhận hoặc bỏ bớt trong hộp thư đến rồi ngắt kết nối lại');
    return { fileIds: rows.map((r) => r.file_id) };
  },
});

// A page of the active connections of active orgs after a key (ludy_finance.marketplace_poll_due, the worker login's alone), for the worker's sweep, which pages through them all.
export const MARKETPLACE_POLL_DUE_PAGE = 1000;
export async function marketplacePollDue(workerDb: Db, after: { orgId: string; id: string } | null): Promise<Array<{ orgId: string; id: string; provider: string }>> {
  const { rows } = await sql<{ org_id: string; id: string; provider: string }>`
    SELECT org_id, id, provider FROM ludy_finance.marketplace_poll_due(${after?.orgId ?? null}::uuid, ${after?.id ?? null}::uuid, ${MARKETPLACE_POLL_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, id: r.id, provider: r.provider }));
}

// The push address of a connection (#4348, S3b of #4315): 128 random bits as 22 base64url characters, shown once; the database keeps its SHA-256 only, in a definer-only table, through
// ludy_finance.marketplace_hook_set (owners and admins, checked there too from the sealed context). A second call replaces the key, so the old address stops at once, the pushes waiting for it are dropped and a hook
// stopped by refused pushes takes pushes again. The address the owner sees is built from the key by the API, which knows the public URL (apps/kernel rpc.ts); the key leaves only in this command's answer.
const marketplaceHookKey = () => randomBytes(16).toString('base64url');
const marketplaceHookKeyHash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

// What the definer's refusal of a connection that is no longer there or no longer active is to the caller: CHANNEL_NOT_ACTIVE, as when the command's own check sees it. Anything else is not this refusal.
export function hookSetFailure(e: unknown): DomainError | null {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err !== null && typeof err === 'object' && err.code === '22023' && typeof err.message === 'string' && err.message.includes('MARKETPLACE_HOOK_NOT_FOUND')
    ? new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối với sàn không còn hoạt động; hãy kết nối lại')
    : null;
}

export const marketplaceConnectionPushHookSet = defineCommand({
  name: 'finance.marketplace_connection.push_hook_set',
  input: zMarketplacePushHookSet,
  // A row of Ludy that makes an address valid or stops the old one; it posts nothing, reaches no platform and moves no money. The key leaves only in the answer to the owner or admin: callers send no idempotency key,
  // so no replay hands it out again, and the audit row keeps the connection and a flag, never the key.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  // The answer holds the key in plaintext, so it must never be stored for a replay (ludy_kernel.idempotency_key.response): callers omit the key and the runtime refuses one.
  noIdempotency: true,
  target: (input) => ({ type: 'finance.marketplace_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ adapter: (typeof MARKETPLACE_PUSH_ADAPTERS)[number]; key: string; created: boolean }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tạo được địa chỉ nhận thông báo của sàn');
    const connection = await ctx.trx
      .selectFrom('ludy_finance.marketplace_connection as c')
      .innerJoin('ludy_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['ch.provider as provider', 'ch.status as status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!connection) throw notFound();
    const adapter = marketplaceAdapterOf(connection.provider);
    const pushAdapter = MARKETPLACE_PUSH_ADAPTERS.find((id) => id === adapter);
    if (!pushAdapter) throw new DomainError('MARKETPLACE_PUSH_UNSUPPORTED', 422, 'Sàn này chưa nhận thông báo đẩy');
    if (connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối với sàn không còn hoạt động; hãy kết nối lại');
    const key = marketplaceHookKey();
    // A channel connection revoked between the check above and the definer's own check is the same refusal, not a generic error.
    const { rows } = await sql<{ made: boolean }>`SELECT ludy_finance.marketplace_hook_set(${input.id}::uuid, ${marketplaceHookKeyHash(key)}) AS made`.execute(ctx.trx).catch((e: unknown) => {
      throw hookSetFailure(e) ?? e;
    });
    const created = rows[0]?.made === true;
    ctx.audit({ created });
    return { adapter: pushAdapter, key, created };
  },
});

export const marketplaceConnectionPushHook = defineQuery({
  name: 'finance.marketplace_connection.push_hook',
  input: zMarketplacePushHookSet,
  access: MANAGERS,
  handler: async (ctx, input): Promise<MarketplacePushHookStatus> => {
    // A connection that is not this org's answers as the command does (404), whether it has no hook or does not exist, so an id of another org learns nothing from either.
    const known = await ctx.trx.selectFrom('ludy_finance.marketplace_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    if (!known) throw notFound();
    const { rows } = await sql<{ created_at: Date | string; rotated_at: Date | string | null; last_seen_at: Date | string | null; rejected_count: number; stopped: boolean }>`
      SELECT created_at, rotated_at, last_seen_at, rejected_count, stopped FROM ludy_finance.marketplace_hook_status(${input.id}::uuid)`.execute(ctx.trx);
    const row = rows[0];
    if (!row) return { exists: false, createdAt: null, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };
    const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
    return { exists: true, createdAt: iso(row.created_at), rotatedAt: iso(row.rotated_at), lastSeenAt: iso(row.last_seen_at), rejectedCount: Number(row.rejected_count), stopped: row.stopped };
  },
});

export const marketplaceConnectionCommands = [
  marketplaceConnectionConnect,
  marketplaceConnectionRecordTest,
  marketplaceConnectionIngestPage,
  marketplaceConnectionUnlink,
  marketplaceConnectionRequestPoll,
  marketplaceConnectionRequestTest,
  marketplaceConnectionRecordPoll,
  marketplaceConnectionAuthorizeBegin,
  marketplaceConnectionAuthorizeFinish,
  marketplaceConnectionAuthorizeRecord,
  marketplaceConnectionAuthorizeComplete,
  marketplaceConnectionPushHookSet,
];
export const marketplaceConnectionQueries = [marketplaceConnectionPushHook, marketplaceConnectionList, marketplaceConnectionTarget, marketplaceConnectionPollTarget, marketplaceConnectionAuthorizeLookup, marketplaceConnectionAuthorizeTarget, marketplaceConnectionStaged];
