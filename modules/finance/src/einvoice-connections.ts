// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to an e-invoice provider (#2501, ADR-0044 point 2, plan einvoice-issue.md section 7):
// - finance.einvoice_connection.connect (owners and admins; R2): runs kernel.channel.connect (provider `einvoice_<adapter>`, the credential sealed in
//   crove_kernel.credential) and files the connection under a legal entity and the seller's tax code in ONE transaction. It sees no credential: the sealing is the API edge's,
//   and the worker alone opens it.
// - finance.einvoice_connection.record_test (same; R1): records the state the connection test came back with and adds the templates and series the provider listed to the
//   connection's entity. The test itself (the provider calls) is the API's for the offline provider and the worker's for a real one; this command takes only a state.
// - finance.einvoice_connection.unlink (same; R2): deletes the row. The API revokes the channel connection first, which drops the credential.
// - finance.einvoice_series.set_default (same; R1): the entity's default series.
// - finance.einvoice_connection.list: every member reads the connections and their last test.
// No query, audit fact or error carries a credential or a provider's own text: only ids, counts and the state.
import { sql } from 'kysely';
import { z } from 'zod';
import { isEInvoiceProvider } from '@crove/einvoice';
import { zChannelConnect } from '@crove/kernel';
import { zEInvoiceConnectionRecordTest, zEInvoiceSeriesSetDefault, zId, zSellerTaxCode, type EInvoiceConnection, type EInvoiceConnectionTested } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { addSeriesFrom, loadSeries } from './einvoice-drafts.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

// The adapter a channel provider id names (`einvoice_sandbox` is the adapter `sandbox`), or null when it names none this build knows.
const adapterOf = (channelProvider: string): string | null => {
  const name = channelProvider.startsWith('einvoice_') ? channelProvider.slice('einvoice_'.length) : '';
  return isEInvoiceProvider(name) ? name : null;
};

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// The entity a connection issues for and the seller's tax code it issues under: the entity's own code unless one is typed, and a typed one must be the entity's when
// the entity has one. The API asks this before it seals anything, so no credential is made for an account the entity cannot use; the link command asks it again.
async function resolveSeller(ctx: Ctx, requestedEntity: string | null, requestedTaxCode: string | null): Promise<{ legalEntityId: string; sellerTaxCode: string }> {
  const legalEntityId = await resolveLegalEntity(ctx, requestedEntity);
  const entity = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('tax_code').where('org_id', '=', ctx.orgId).where('id', '=', legalEntityId).executeTakeFirstOrThrow();
  const sellerTaxCode = requestedTaxCode ?? entity.tax_code;
  if (!sellerTaxCode) throw new DomainError('EINVOICE_TAX_CODE_NEEDED', 422, 'Hãy nhập mã số thuế cho pháp nhân này trước khi kết nối nhà cung cấp hóa đơn điện tử');
  if (entity.tax_code && entity.tax_code !== sellerTaxCode) throw new DomainError('EINVOICE_TAX_CODE_MISMATCH', 422, 'Mã số thuế người bán phải là mã số thuế của pháp nhân đã chọn');
  // An entity with no tax code of its own takes the one typed, but never another entity's: invoices of one taxpayer are not issued under another's.
  if (!entity.tax_code) {
    const other = await ctx.trx
      .selectFrom('crove_kernel.legal_entity')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('tax_code', '=', sellerTaxCode)
      .where('id', '<>', legalEntityId)
      .executeTakeFirst();
    if (other) throw new DomainError('EINVOICE_TAX_CODE_MISMATCH', 422, 'Mã số thuế này là của một pháp nhân khác; hãy chọn đúng pháp nhân hoặc nhập mã số thuế của pháp nhân này');
  }
  return { legalEntityId, sellerTaxCode };
}

export const einvoiceConnectionTarget = defineQuery({
  name: 'finance.einvoice_connection.target',
  input: z.strictObject({ legalEntityId: zId.nullable(), sellerTaxCode: zSellerTaxCode.nullable() }),
  access: MANAGERS,
  handler: (ctx, input) => resolveSeller(ctx, input.legalEntityId, input.sellerTaxCode),
});

export const einvoiceConnectionConnect = defineCommand({
  name: 'finance.einvoice_connection.connect',
  // The sealed envelope of what the org typed (made at the API's edge, never the secret), the entity the account issues for and the seller's tax code. One transaction
  // writes the channel connection with its credential and files the connection under the entity, so a refusal of either rolls back both: a refused connect never
  // replaces the credential or the connector of a connection that is already live.
  input: z.strictObject({
    provider: z.string().regex(/^[a-z][a-z0-9_]{0,21}$/),
    legalEntityId: zId.nullable(),
    sellerTaxCode: zSellerTaxCode.nullable(),
    displayName: z.string().trim().min(1).max(200),
    credential: zChannelConnect.shape.credential,
  }),
  // It names which provider account the org's invoices will be issued from and stores that account's login (sealed); nothing is issued.
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    if (!isEInvoiceProvider(input.provider)) throw new DomainError('EINVOICE_PROVIDER_UNKNOWN', 422, 'Nhà cung cấp hóa đơn điện tử này không được hỗ trợ');
    const channelProvider = `einvoice_${input.provider}`;
    const { legalEntityId: entityId, sellerTaxCode } = await resolveSeller(ctx, input.legalEntityId, input.sellerTaxCode);
    // The account is the entity's under this provider, so a second connect of it is the same connection. The seller's tax code is not in it, nor in the display name: the
    // channel row stays as history after a disconnect, and a household's tax code is its owner's national ID. Only the finance row holds the code, and it goes with the
    // disconnect.
    const externalAccountId = entityId;
    // The seller of an account does not change: the same connection under another tax code is refused before the credential is written, and disconnected and connected again.
    const held = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection')
      .select(['id', 'seller_tax_code'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', entityId)
      .where('provider', '=', channelProvider)
      .executeTakeFirst();
    if (held && held.seller_tax_code !== sellerTaxCode) throw new DomainError('EINVOICE_CONNECTION_EXISTS', 409, 'Kết nối này đã có cho một mã số thuế khác; hãy ngắt kết nối rồi kết nối lại');
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
        .insertInto('crove_finance.einvoice_connection')
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, channel_connection_id: channel.connectionId, provider: channelProvider, seller_tax_code: sellerTaxCode, created_by: userId })
        // Two connects of one account at once: the channel connection's own lock serialises them, and the second finds the first's row and answers with it.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const id =
        row?.id ??
        (await ctx.trx.selectFrom('crove_finance.einvoice_connection').select('id').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', channel.connectionId).executeTakeFirstOrThrow()).id;
      ctx.audit({ connectionId: channel.connectionId, legalEntityId: entityId, provider: channelProvider, reconnected: channel.reconnected });
      return { id, existing: !row };
    } catch (error) {
      if (pgCode(error) === '23505') throw new DomainError('EINVOICE_CONNECTION_EXISTS', 409, 'Pháp nhân này đã có một kết nối với nhà cung cấp đó cho mã số thuế này');
      throw error;
    }
  },
});

export const einvoiceConnectionRecordTest = defineCommand({
  name: 'finance.einvoice_connection.record_test',
  input: zEInvoiceConnectionRecordTest,
  // It adds rows that name a template and a symbol the provider already holds; no invoice, no money, no credential.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.einvoice_connection', id: input.id }),
  handler: async (ctx, input): Promise<EInvoiceConnectionTested> => {
    const row = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.legal_entity_id', 'c.provider', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .forUpdate('c')
      .executeTakeFirst();
    if (!row) throw new DomainError('EINVOICE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối hóa đơn điện tử này');
    if (row.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    const adapter = adapterOf(row.provider);
    if (!adapter) throw new DomainError('EINVOICE_PROVIDER_UNKNOWN', 422, 'Kết nối này không phải của một nhà cung cấp hóa đơn điện tử');
    await ctx.trx
      .updateTable('crove_finance.einvoice_connection')
      .set({ last_test_state: input.state, last_tested_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .execute();
    // The templates come with a test that worked; a failed one lists none.
    const added = input.state === 'works' ? await addSeriesFrom(ctx, row.legal_entity_id, adapter, input.templates) : 0;
    ctx.audit({ state: input.state, added });
    return { state: input.state, added, series: (await loadSeries(ctx)).filter((s) => s.legalEntityId === row.legal_entity_id) };
  },
});

export const einvoiceConnectionUnlink = defineCommand({
  name: 'finance.einvoice_connection.unlink',
  input: z.strictObject({ id: zId }),
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.einvoice_connection', id: input.id }),
  handler: async (ctx, input): Promise<{ removed: boolean }> => {
    // Only a connection that is no longer live: the credential goes first (the API revokes the channel connection before this), so no live credential is left without its row.
    const live = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select('c.id')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.id)
      .where('ch.status', '<>', 'revoked')
      .executeTakeFirst();
    if (live) throw new DomainError('EINVOICE_CONNECTION_LIVE', 409, 'Hãy ngắt kết nối với nhà cung cấp trước khi xóa dòng này');
    const gone = await ctx.trx.deleteFrom('crove_finance.einvoice_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    const removed = Number(gone.numDeletedRows) > 0;
    ctx.audit({ removed });
    return { removed };
  },
});

export const einvoiceSeriesSetDefault = defineCommand({
  name: 'finance.einvoice_series.set_default',
  input: zEInvoiceSeriesSetDefault,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'finance.einvoice_series', id: input.seriesId }),
  handler: async (ctx, input) => {
    const series = await ctx.trx
      .selectFrom('crove_finance.einvoice_series')
      .select('legal_entity_id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.seriesId)
      .executeTakeFirst();
    if (!series) throw new DomainError('EINVOICE_SERIES_NOT_FOUND', 404, 'Không tìm thấy ký hiệu hóa đơn này');
    // The same lock as the series sync takes, so the one default per entity holds.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.einvoice_series:${ctx.orgId}:${series.legal_entity_id}`}, 0))`.execute(ctx.trx);
    await ctx.trx
      .updateTable('crove_finance.einvoice_series')
      .set({ is_default: false })
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', series.legal_entity_id)
      .where('is_default', '=', true)
      .where('id', '<>', input.seriesId)
      .execute();
    await ctx.trx.updateTable('crove_finance.einvoice_series').set({ is_default: true }).where('org_id', '=', ctx.orgId).where('id', '=', input.seriesId).execute();
    ctx.audit({ legalEntityId: series.legal_entity_id });
    return { series: (await loadSeries(ctx)).filter((s) => s.legalEntityId === series.legal_entity_id) };
  },
});

export const einvoiceConnectionList = defineQuery({
  name: 'finance.einvoice_connection.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<EInvoiceConnection[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection as c')
      .innerJoin('crove_kernel.channel_connection as ch', (join) => join.onRef('ch.org_id', '=', 'c.org_id').onRef('ch.id', '=', 'c.channel_connection_id'))
      .select(['c.id', 'c.channel_connection_id', 'c.legal_entity_id', 'c.provider', 'c.seller_tax_code', 'c.last_test_state', 'c.last_tested_at', 'ch.display_name', 'ch.status'])
      .where('c.org_id', '=', ctx.orgId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      legalEntityId: r.legal_entity_id,
      provider: r.provider.slice('einvoice_'.length),
      sellerTaxCode: r.seller_tax_code,
      displayName: r.display_name,
      status: r.status,
      lastTestState: r.last_test_state,
      lastTestedAt: r.last_tested_at ? new Date(r.last_tested_at).toISOString() : null,
    }));
  },
});

export const einvoiceConnectionCommands = [einvoiceConnectionConnect, einvoiceConnectionRecordTest, einvoiceConnectionUnlink, einvoiceSeriesSetDefault];
export const einvoiceConnectionQueries = [einvoiceConnectionList, einvoiceConnectionTarget];
