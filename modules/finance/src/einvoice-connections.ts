// SPDX-License-Identifier: AGPL-3.0-only
// An org's connection to an e-invoice provider (#2501, ADR-0044 point 2, plan einvoice-issue.md section 7):
// - finance.einvoice_connection.link (owners and admins; R2): files a channel connection the kernel just made (provider `einvoice_<adapter>`, its credential sealed in
//   crove_kernel.credential) under a legal entity and the seller's tax code. It sees no credential: the sealing is the API edge's, and the worker alone opens it.
// - finance.einvoice_connection.record_test (same; R1): records the state the connection test came back with and adds the templates and series the provider listed to the
//   connection's entity. The test itself (the provider calls) is the API's for the offline provider and the worker's for a real one; this command takes only a state.
// - finance.einvoice_connection.unlink (same; R2): deletes the row. The API revokes the channel connection first, which drops the credential.
// - finance.einvoice_series.set_default (same; R1): the entity's default series.
// - finance.einvoice_connection.list: every member reads the connections and their last test.
// No query, audit fact or error carries a credential or a provider's own text: only ids, counts and the state.
import { sql } from 'kysely';
import { z } from 'zod';
import { isEInvoiceProvider } from '@crove/einvoice';
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

export const einvoiceConnectionLink = defineCommand({
  name: 'finance.einvoice_connection.link',
  input: z.strictObject({ connectionId: zId, legalEntityId: zId.nullable(), sellerTaxCode: zSellerTaxCode.nullable() }),
  // It names which provider account the org's invoices will be issued from; nothing is issued and no credential is touched.
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ id: string; existing: boolean }> => {
    const channel = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      // Held until this transaction ends, so a disconnect cannot revoke the connection between this check and the row that files it.
      .forShare()
      .executeTakeFirst();
    if (!channel) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kết nối này');
    if (!adapterOf(channel.provider)) throw new DomainError('EINVOICE_PROVIDER_UNKNOWN', 422, 'Kết nối này không phải của một nhà cung cấp hóa đơn điện tử');
    if (channel.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kết nối này không còn hoạt động, hãy kết nối lại');
    const { legalEntityId: entityId, sellerTaxCode } = await resolveSeller(ctx, input.legalEntityId, input.sellerTaxCode);
    // A connect that reaches the same account again (a retry whose answer was lost) is the same row; the same connection under another tax code is not: the seller of an
    // account does not change, so it is disconnected and connected again.
    const same = await ctx.trx
      .selectFrom('crove_finance.einvoice_connection')
      .select(['id', 'legal_entity_id', 'seller_tax_code'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (same) {
      if (same.legal_entity_id !== entityId || same.seller_tax_code !== sellerTaxCode) throw new DomainError('EINVOICE_CONNECTION_EXISTS', 409, 'Kết nối này đã có cho một mã số thuế khác; hãy ngắt kết nối rồi kết nối lại');
      return { id: same.id, existing: true };
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    try {
      const row = await ctx.trx
        .insertInto('crove_finance.einvoice_connection')
        .values({ org_id: ctx.orgId, legal_entity_id: entityId, channel_connection_id: input.connectionId, provider: channel.provider, seller_tax_code: sellerTaxCode, created_by: userId })
        // Two links of one channel connection at once (two connects of one account): the second waits for the first, finds its row and answers with it, so neither call is
        // refused for the other's work and the API does not revoke a connection the other returned.
        .onConflict((conflict) => conflict.columns(['org_id', 'channel_connection_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) {
        const first = await ctx.trx
          .selectFrom('crove_finance.einvoice_connection')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('channel_connection_id', '=', input.connectionId)
          .executeTakeFirstOrThrow();
        return { id: first.id, existing: true };
      }
      ctx.audit({ connectionId: input.connectionId, legalEntityId: entityId, provider: channel.provider });
      return { id: row.id, existing: false };
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

export const einvoiceConnectionCommands = [einvoiceConnectionLink, einvoiceConnectionRecordTest, einvoiceConnectionUnlink, einvoiceSeriesSetDefault];
export const einvoiceConnectionQueries = [einvoiceConnectionList, einvoiceConnectionTarget];
