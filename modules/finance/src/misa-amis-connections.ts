// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854; plan accounting-software-sync.md step 4), modeled on the marketplace connection (#2519):
// - finance.misa_amis_connection.target (owners and admins; query): the legal entity a connect is for, resolved before anything is sealed.
// - finance.misa_amis_connection.connect (owners and admins; R2 external): runs kernel.channel.connect (provider `accounting_misa_amis`, the access code sealed in crove_kernel.credential)
//   and files the connection under the legal entity in ONE transaction. It sees no credential: the sealing is the API edge's, and only a worker opens it.
// - finance.misa_amis_connection.unlink (same; R2): deletes the row. The API revokes the channel connection first, which drops the credential.
// - finance.misa_amis_connection.list: every member reads the connections ("connected since", the channel's status).
// No query, audit fact or error carries the access code, the integrator's ClientID or MISA's own text: only ids and states. The connection's opaque org_company_code (what AMIS is told and what a
// later slice's callback finds the organisation by) is not in any answer either.
import { z } from 'zod';
import { zChannelConnect } from '@crove/kernel';
import { zId, type MisaAmisConnection } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

// The channel layer's provider id for this connector (ADR-0025). One connection per entity, so the external account id is the entity's.
export const MISA_AMIS_CHANNEL_PROVIDER = 'accounting_misa_amis';

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
      provider: MISA_AMIS_CHANNEL_PROVIDER,
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
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, channel_connection_id: channel.connectionId, created_by: userId })
        // Two connects of one entity at once: the channel connection's own lock serialises them, and the second finds the first's row and answers with it.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const id =
        row?.id ??
        (await ctx.trx.selectFrom('crove_finance.misa_amis_connection').select('id').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', channel.connectionId).executeTakeFirstOrThrow()).id;
      ctx.audit({ connectionId: channel.connectionId, legalEntityId: entityId, reconnected: channel.reconnected });
      return { id, existing: !row };
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('MISA_AMIS_CONNECTION_EXISTS', 409, 'Pháp nhân này đã có một kết nối MISA AMIS');
      throw error;
    }
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
    const gone = await ctx.trx.deleteFrom('crove_finance.misa_amis_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    const removed = Number(gone.numDeletedRows) > 0;
    ctx.audit({ removed });
    return { removed };
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
      .select(['c.id', 'c.channel_connection_id', 'c.legal_entity_id', 'c.created_at', 'ch.display_name', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      legalEntityId: r.legal_entity_id,
      displayName: r.display_name,
      status: r.status,
      connectedAt: new Date(r.created_at).toISOString(),
    }));
  },
});

export const misaAmisConnectionCommands = [misaAmisConnectionConnect, misaAmisConnectionUnlink];
export const misaAmisConnectionQueries = [misaAmisConnectionList, misaAmisConnectionTarget];
