// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854; plan accounting-software-sync.md step 4), modeled on the marketplace connection (#2519):
// - finance.misa_amis_connection.target (owners and admins; query): the legal entity a connect is for, resolved before anything is sealed.
// - finance.misa_amis_connection.connect (owners and admins; R2 external): runs kernel.channel.connect (provider `accounting_misa_amis`, the access code sealed in crove_kernel.credential)
//   and files the connection under the legal entity in ONE transaction. It sees no credential: the sealing is the API edge's, and only a worker opens it.
// - finance.misa_amis_connection.unlink (same; R2): deletes the row. The API asks `can_disconnect` (no voucher awaiting MISA's answer), then revokes the channel connection, which drops the credential.
// - finance.misa_amis_connection.request_test (owners and admins; R2 external): queues the connection test (S2b, #3885). The worker's job opens the access code, asks AMIS for a token and the company's
//   information, and records the state through finance.misa_amis_connection.record_test (system only: a state and a time, nothing else). The test_target query hands the worker what it needs.
// - finance.misa_amis_connection.list: every member reads the connections ("connected since", the channel's status, the last test).
// No query, audit fact or error carries the access code, the integrator's ClientID or MISA's own text: only ids and states. The connection's opaque org_company_code (what AMIS is told and what a
// later slice's callback finds the organisation by) is not in any answer either.
import { z } from 'zod';
import { zChannelConnect } from '@crove/kernel';
import { zId, zMisaAmisConnectionRecordTest, zMisaAmisDefaultItem, zMisaAmisProduct, type MisaAmisConnection, type MisaAmisProduct, type MisaAmisTestState } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

// The channel layer's provider id for this connector (ADR-0025). One connection per entity, so the external account id is the entity's.
export const MISA_AMIS_CHANNEL_PROVIDER = 'accounting_misa_amis';
// MISA ASP's own provider id (#4111, S2 of #4103): its access code is sealed under this binding, so the code of one product is never opened as the other's.
export const MISA_ASP_CHANNEL_PROVIDER = 'accounting_misa_asp';
export const misaChannelProvider = (product: MisaAmisProduct): string => (product === 'asp' ? MISA_ASP_CHANNEL_PROVIDER : MISA_AMIS_CHANNEL_PROVIDER);

export const misaAmisConnectionTarget = defineQuery({
  name: 'finance.misa_amis_connection.target',
  input: z.strictObject({ legalEntityId: zId.nullable() }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ legalEntityId: string }> => ({ legalEntityId: await resolveLegalEntity(ctx, input.legalEntityId) }),
});

export const misaAmisConnectionConnect = defineCommand({
  name: 'finance.misa_amis_connection.connect',
  // The sealed envelope of the access code (made at the API's edge, never the secret) and the entity it is for. One transaction writes the channel connection with its credential and files the
  // connection under the entity, so a refusal of either rolls back both: a refused connect never replaces the credential of a connection that is already live.
  input: z.strictObject({
    legalEntityId: zId.nullable(),
    // AMIS Kế toán or MISA ASP (#4111): the channel connection is made under that product's provider id, and a legal entity has one connection across both.
    product: zMisaAmisProduct.default('amis'),
    displayName: z.string().trim().min(1).max(200),
    credential: zChannelConnect.shape.credential,
  }),
  // It names which AMIS data the entity's vouchers will be pushed to and stores that connection's access code (sealed); nothing is read, written or changed in AMIS.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    const entityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const channel = await ctx.run<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', {
      provider: misaChannelProvider(input.product),
      externalAccountId: entityId,
      displayName: input.displayName,
      scopes: [],
      expiresAt: null,
      credential: input.credential,
    });
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    try {
      const row = await ctx.trx
        .insertInto('crove_finance.misa_amis_connection')
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, product: input.product, channel_connection_id: channel.connectionId, created_by: userId })
        // Two connects of one entity at once: the channel connection's own lock serialises them, and the second finds the first's row and answers with it.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const id =
        row?.id ??
        (await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select('id').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', channel.connectionId).executeTakeFirstOrThrow()).id;
      ctx.audit({ connectionId: channel.connectionId, legalEntityId: entityId, product: input.product, reconnected: channel.reconnected });
      return { id, existing: !row };
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('MISA_AMIS_CONNECTION_EXISTS', 409, 'Pháp nhân này đã có một kết nối MISA (AMIS Kế toán hoặc ASP); hãy ngắt kết nối cũ trước khi kết nối lại');
      throw error;
    }
  },
});

// Vouchers MISA took or may have taken stay on record while they await an answer: deleting the connection would delete the record, and a reconnect could send the same voucher again.
// The API asks this (`can_disconnect`) before it revokes the channel, so a refused disconnect leaves the access code and the channel as they were; the unlink asks again as the last guard.
async function refuseWhilePending(ctx: Pick<CommandContext, 'trx' | 'orgId'>, connectionId: string): Promise<void> {
  const pending = await ctx.trx
    .selectFrom('crove_finance.misa_amis_push')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('connection_id', '=', connectionId)
    .where('state', 'in', ['sending', 'sent', 'ambiguous'])
    .limit(1)
    .executeTakeFirst();
  if (pending) throw new DomainError('MISA_AMIS_PUSH_PENDING', 409, 'Còn chứng từ đã gửi sang MISA AMIS chưa có kết quả; hãy xử lý xong trước khi xóa kết nối');
}

// Asked by the API before the channel is revoked. A push that begins between this and the revocation is the one gap: its rows then stay on record and the unlink refuses, as before.
export const misaAmisConnectionCanDisconnect = defineQuery({
  name: 'finance.misa_amis_connection.can_disconnect',
  input: z.strictObject({ id: zId }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ ok: true }> => {
    await refuseWhilePending(ctx, input.id);
    return { ok: true };
  },
});

export const misaAmisConnectionUnlink = defineCommand({
  name: 'finance.misa_amis_connection.unlink',
  input: z.strictObject({ id: zId }),
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ removed: boolean }> => {
    // Only a connection that is no longer live: the credential goes first (the API revokes the channel connection before this), so no live credential is left without its row.
    const live = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select('c.id')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .where('ch.status', '<>', 'revoked')
      .executeTakeFirst();
    if (live) throw new DomainError('MISA_AMIS_CONNECTION_LIVE', 409, 'Hãy ngắt kết nối MISA AMIS trước khi xóa dòng này');
    await refuseWhilePending(ctx, input.id);
    const gone = await ctx.trx.deleteFrom('crove_finance.misa_amis_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    const removed = Number(gone.numDeletedRows) > 0;
    ctx.audit({ removed });
    return { removed };
  },
});

const notFound = () => new DomainError('MISA_AMIS_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối MISA AMIS này');

// The test the worker runs is queued by this event (apps/kernel/src/worker.ts). Ids only.
export const MISA_AMIS_TEST_REQUESTED = 'finance.misa_amis_connection.test_requested';

export const misaAmisConnectionRequestTest = defineCommand({
  name: 'finance.misa_amis_connection.request_test',
  input: z.strictObject({ id: zId }),
  // The event it emits starts a job that calls AMIS with the org's sealed access code: it derives R2 external (plan section 4.7), though the call only reads (a token and the company's information).
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ queued: boolean }> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select('ch.status')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    await ctx.emit(MISA_AMIS_TEST_REQUESTED, { connection_id: input.id });
    ctx.audit({ requested: true });
    return { queued: true };
  },
});

// What the worker needs to test one connection, or why it must not: a connection that is gone, or whose channel connection is no longer active (revoked, expired, in error), is left alone.
// The company code is the opaque one AMIS is told (not a secret); it reaches the worker and nothing else.
export type MisaAmisTestTarget = { action: 'none'; reason: 'not_found' | 'not_active' } | { action: 'test'; id: string; product: MisaAmisProduct; channelConnectionId: string; orgCompanyCode: string };

export const misaAmisConnectionTestTarget = defineQuery({
  name: 'finance.misa_amis_connection.test_target',
  input: z.strictObject({ id: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<MisaAmisTestTarget> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.product', 'c.channel_connection_id', 'c.org_company_code', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .executeTakeFirst();
    if (!row) return { action: 'none', reason: 'not_found' };
    if (row.status !== 'active') return { action: 'none', reason: 'not_active' };
    return { action: 'test', id: row.id, product: row.product, channelConnectionId: row.channel_connection_id, orgCompanyCode: row.org_company_code };
  },
});

export const misaAmisConnectionRecordTest = defineCommand({
  name: 'finance.misa_amis_connection.record_test',
  input: zMisaAmisConnectionRecordTest,
  // A state and a time on a row; no voucher, no money, no credential.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ recorded: boolean; state: MisaAmisTestState }> => {
    const found = await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).forUpdate().executeTakeFirst();
    // A connection closed while its test ran: nothing to record.
    if (!found) return { recorded: false, state: input.state };
    await ctx.trx
      .updateTable('crove_finance.misa_amis_connection')
      .set({ last_test_state: input.state, last_tested_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    ctx.audit({ state: input.state });
    return { recorded: true, state: input.state };
  },
});

export const misaAmisConnectionList = defineQuery({
  name: 'finance.misa_amis_connection.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MisaAmisConnection[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_amis_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.product', 'c.channel_connection_id', 'c.legal_entity_id', 'c.created_at', 'c.last_test_state', 'c.last_tested_at', 'c.default_service_item_code', 'c.default_sales_item_code', 'c.default_sales_stock_code', 'ch.display_name', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      product: r.product,
      connectionId: r.channel_connection_id,
      legalEntityId: r.legal_entity_id,
      displayName: r.display_name,
      status: r.status,
      connectedAt: new Date(r.created_at).toISOString(),
      lastTestState: r.last_test_state,
      lastTestedAt: r.last_tested_at ? new Date(r.last_tested_at).toISOString() : null,
      defaultServiceItemCode: r.default_service_item_code,
      defaultSalesItemCode: r.default_sales_item_code,
      defaultSalesStockCode: r.default_sales_stock_code,
    }));
  },
});

// The default item of a connection (S3b, #4124): kept, or cleared with a null code, for service lines or for sales lines. A typed code, as the catalogue spells it; nothing here reads the catalogue (the next check does,
// and an item it does not have is a blocker by line). Owner or admin. The two columns are the only ones this writes, and the trigger that fixes the product and the channel connection is untouched.
export const misaAmisConnectionSetDefaultItem = defineCommand({
  name: 'finance.misa_amis_connection.set_default_item',
  input: zMisaAmisDefaultItem,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.misa_amis_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ saved: boolean }> => {
    // A stock is MISA ASP's (a sales line of AMIS leaves none): refused for an AMIS connection, and the table's own check says the same.
    if (input.role === 'sales_stock') {
      const connection = await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select(['product']).where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
      if (!connection) throw notFound();
      if (connection.product !== 'asp' && input.code !== null) throw new DomainError('MISA_AMIS_STOCK_NOT_ASP', 422, 'Chỉ kết nối MISA ASP mới có kho mặc định cho dòng bán hàng');
    }
    const updated = await ctx.trx
      .updateTable('crove_finance.misa_amis_connection')
      .set(input.role === 'service' ? { default_service_item_code: input.code } : input.role === 'sales' ? { default_sales_item_code: input.code } : { default_sales_stock_code: input.code })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw notFound();
    // The role and whether a code was kept: an item code names no one, but nothing about it needs to be in the audit trail.
    ctx.audit({ role: input.role, cleared: input.code === null });
    return { saved: true };
  },
});

export const misaAmisConnectionCommands = [misaAmisConnectionConnect, misaAmisConnectionUnlink, misaAmisConnectionRequestTest, misaAmisConnectionRecordTest, misaAmisConnectionSetDefaultItem];
export const misaAmisConnectionQueries = [misaAmisConnectionList, misaAmisConnectionTarget, misaAmisConnectionTestTarget, misaAmisConnectionCanDisconnect];
